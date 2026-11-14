import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialBroker } from "./credential-broker";
import type { CoreSupervisor } from "./core-supervisor";
import { withProvisionedNativeVault } from "./native-vault-provisioner";
import { NativeProfileExportWorker } from "./native-profile-export-worker";

export type NativeProfileExportPreview = {
	counts: Record<string, number>;
	excluded: Record<string, number>;
	projects: number;
	pendingProjects: number;
	instructions: number;
};
type Result = { state: "cancelled"; outputFolder?: string } | { state: "prepared"; profile: string; outputFolder: string; preview: NativeProfileExportPreview };
type ExportStep = "cached-key" | "source" | "destination" | "source-stop" | "provision" | "worker-start" | "plan" | "review" | "apply" | "verify" | "worker-stop" | "publish" | "status";
export class NativeProfileExportError extends Error {
	constructor(readonly step: ExportStep) {
		super("The Chromium transfer could not be prepared. Your original data remains available; preserve any generated transfer folder for review.");
		this.name = "NativeProfileExportError";
	}
}
export interface NativeProfileExportHostOptions {
	sourceRoot: string;
	broker: Pick<CredentialBroker, "withCachedDatabaseKey">;
	core: Pick<CoreSupervisor, "isReady" | "hasProcess" | "stop" | "resumeLastConfiguration">;
	workerExecutable: string;
	workerEntry: string;
	vaultProvisioner: string;
	isBusy(): boolean;
	shouldRestoreCore(): boolean;
	chooseParent(signal: AbortSignal): Promise<string | null>;
	approve(preview: NativeProfileExportPreview, signal: AbortSignal): Promise<boolean>;
	changed?(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
function check(signal: AbortSignal) { if (signal.aborted) throw new Error("Transfer preparation was cancelled."); }
async function publishProfileSelection(profile: string, handoffId: string): Promise<void> {
	for (const [name, text] of [
		["native-core-profile.json", JSON.stringify({ version: 2, active: "", previous: "", handoffs: { "": handoffId } })],
		[".kestrel-desktop.lock", ""],
	] as const) {
		const file = await open(join(profile, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
	}
	const directory = await open(profile, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await directory.sync(); } finally { await directory.close(); }
}
function counts(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100) throw new Error();
	const result: Record<string, number> = {};
	for (const [key, number] of Object.entries(value)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > 250000) throw new Error();
		Object.defineProperty(result, key, { value: number, enumerable: true });
	}
	return result;
}
function preview(value: any, sourceRoot: string, coreRoot: string, handoffId: string): NativeProfileExportPreview {
	if (!value || value.sourceDatabasePath !== join(sourceRoot, "database/kestrel.sqlite") || value.destinationDatabasePath !== join(coreRoot, "database/kestrel.sqlite") ||
		!sha.test(value.planSha256) || value.projectHandoff?.id !== handoffId) throw new Error();
	const projects = value.projectHandoff;
	for (const name of ["projects", "pendingIdentities", "instructions"]) if (!Number.isSafeInteger(projects[name]) || projects[name] < 0 || projects[name] > 500) throw new Error();
	return { counts: counts(value.counts), excluded: counts(value.excluded), projects: projects.projects, pendingProjects: projects.pendingIdentities, instructions: projects.instructions };
}

/** Source-host operation only: no renderer key API and no existing-vault unlock.
 * The host must fence new mutations while busy and retain its source ownership.
 * Native Kestrel selects/imports the exported profile in a separate flow. */
export class NativeProfileExportHost {
	private controller: AbortController | undefined;
	private worker: NativeProfileExportWorker | undefined;
	private closed = false;
	private requiresRestart = false;
	private output: string | undefined;
	get busy(): boolean { return !!this.controller; }
	get outputFolder(): string | undefined { return this.output; }
	get restartRequired(): boolean { return this.requiresRestart; }
	constructor(private readonly options: NativeProfileExportHostOptions) {}
	async close(): Promise<void> {
		this.closed = true; this.controller?.abort();
		if (this.worker) {
			const stopped = await this.worker.close();
			if (!stopped.confirmed) this.requiresRestart = true;
		}
	}
	async execute(): Promise<Result> {
		if (this.closed || this.controller || this.requiresRestart || !this.options.core.isReady || this.options.isBusy())
			throw new Error("Wait for active work to finish before preparing a Chromium transfer.");
		const controller = this.controller = new AbortController(), signal = controller.signal;
		this.output = undefined; this.options.changed?.();
		let coreStopped = false;
		let step: ExportStep = "cached-key";
		try {
			return await this.options.broker.withCachedDatabaseKey(async sourceKey => {
				step = "source";
				check(signal);
				if (await realpath(this.options.sourceRoot) !== this.options.sourceRoot) throw new Error();
				const selected = await this.options.chooseParent(signal); check(signal);
				if (!selected) return { state: "cancelled" as const };
				step = "destination";
				const parent = await realpath(selected), info = await lstat(parent);
				if (parent !== selected || !info.isDirectory() || ![0, process.getuid!()].includes(info.uid) || (info.mode & 0o022)) throw new Error();
				if (parent === this.options.sourceRoot || parent.startsWith(`${this.options.sourceRoot}/`)) throw new Error();
				if (this.options.isBusy() || !this.options.core.isReady) throw new Error();
				step = "source-stop";
				try { await this.options.core.stop({ requireCleanExit: true, gracefulTimeoutMs: 60000 }); }
				catch { this.requiresRestart = true; throw new Error(); }
				if (this.options.core.hasProcess) { this.requiresRestart = true; throw new Error(); }
				coreStopped = true; check(signal);
				step = "provision";
				this.output = await realpath(await mkdtemp(join(parent, "Kestrel Chromium Transfer-")));
				const result = await withProvisionedNativeVault({ parent: this.output, executable: this.options.vaultProvisioner, signal }, async ({ profile, key }) => {
					check(signal);
					const coreRoot = join(profile, "native-core"), handoffId = randomUUID();
					await mkdir(join(coreRoot, "database"), { recursive: true, mode: 0o700 }); check(signal);
					step = "worker-start";
					this.worker = await NativeProfileExportWorker.open({ executable: this.options.workerExecutable, entry: this.options.workerEntry, home: this.output!, signal });
					step = "plan";
					const planned = await this.worker.request("plan-profile", { sourceProfileRoot: this.options.sourceRoot, destinationCoreRoot: coreRoot, handoffId, sourceKeyBase64: sourceKey.toString("base64") }, signal);
					if (!planned.ok || !uuid.test(planned.planId)) throw new Error();
					const reviewed = preview(planned.preview, this.options.sourceRoot, coreRoot, handoffId);
					step = "review";
					if (!await this.options.approve(reviewed, signal)) { check(signal); return { state: "cancelled" as const, outputFolder: this.output! }; }
					check(signal);
					step = "apply";
					const applied = await this.worker.request("apply-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: key.toString("base64") }, signal);
					if (!applied.ok || !uuid.test(applied.recoveryId) || applied.receipt?.activationPerformed !== false) throw new Error();
					step = "verify";
					const verified = await this.worker.request("verify-profile", { recoveryId: applied.recoveryId }, signal);
					if (!verified.ok || verified.recovery?.originalReadable !== true || verified.recovery?.destinationReadable !== true || verified.recovery?.activationPerformed !== false) throw new Error();
					step = "worker-stop";
					const stopped = await this.worker.close(); this.worker = undefined;
					if (!stopped.confirmed) this.requiresRestart = true;
					if (!stopped.clean) throw new Error(); check(signal);
					// Publish only after database/project authentication and confirmed
					// worker exit. A partial export has no native ownership lock.
					step = "publish";
					await publishProfileSelection(profile, handoffId); check(signal);
					return { state: "prepared" as const, profile, outputFolder: this.output!, preview: reviewed };
				});
				if (this.worker) {
					const stopped = await this.worker.close(); this.worker = undefined;
					if (!stopped.confirmed) this.requiresRestart = true;
					if (!stopped.clean) throw new Error();
				}
				check(signal);
				step = "status";
				await writeFile(join(this.output, "transfer-status.json"), JSON.stringify({ version: 1, state: result.state, ...(result.state === "prepared" ? { profile: result.profile, preview: result.preview, activationPerformed: false } : {}), deviceBound: true }, null, 2), { mode: 0o600, flag: "wx" });
				return result;
			});
		} catch {
			throw new NativeProfileExportError(step);
		} finally {
			try {
				if (this.worker) {
					const stopped = await this.worker.close(); this.worker = undefined;
					if (!stopped.confirmed) this.requiresRestart = true;
				}
				if (coreStopped && !this.requiresRestart && !this.closed && this.options.shouldRestoreCore()) {
					try { await this.options.core.resumeLastConfiguration(); }
					catch { this.requiresRestart = true; throw new Error("Restart Kestrel before running another task. The source profile and generated transfer folder were preserved."); }
				}
			} finally { this.controller = undefined; this.options.changed?.(); }
		}
	}
}
