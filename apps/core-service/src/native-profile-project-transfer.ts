import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { applyHostProfileFileTransfer, planHostProfileFileTransfer, reviewHostProfileProjectReferences, verifyHostProfileFileTransferRecovery,
	inspectInterruptedHostProfileFileTransfer, recoverInterruptedHostProfileFileTransfer, verifyInterruptedHostProfileFileTransfer,
	HostProfileFileTransferError, type HostProfileFileTransferPlan, type HostProfileFileTransferReceipt, type HostProfileInterruptedTransferReview } from "@kestrel/database";
import { NativeProjectHandoffFile, ProjectHandoffFileError, type ProjectHandoffFileWitness } from "../../desktop/src/main/native-project-handoff-file";
import { parseNativeProjectHandoffState, PROJECT_HANDOFF_ID, type NativeProjectHandoffState } from "../../desktop/src/main/native-project-handoff-state";
import { readProjectHandoffSource, sameProjectHandoffSourceWitness } from "./project-handoff-source";

type Source = Awaited<ReturnType<typeof readProjectHandoffSource>>;
type Pending = { id: string; handoffId: string; coreRoot: string; sourceRoot: string; reader: Source; plan: HostProfileFileTransferPlan; sourceKey: Buffer;
	projectIds: string[]; reviewSha256: string; expiresAt: number };
type Recovery = Pending & { destinationKey: Buffer; receipt: HostProfileFileTransferReceipt; fileWitness: ProjectHandoffFileWitness; expiresAt: number };
type Inspection = { id: string; handoffId: string; coreRoot: string; review: HostProfileInterruptedTransferReview; expiresAt: number };
type RecoveryPlan = Pending & { destinationKey: Buffer; inspection: Inspection; manifest?: { value: NativeProjectHandoffState; witness: ProjectHandoffFileWitness } };
async function manifestPresent(coreRoot: string): Promise<boolean> {
 try { await lstat(join(coreRoot, "pending-project-handoff.json")); return true; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const TTL = 15 * 60_000, RECOVERY_TTL = 5 * 60_000;
const invalid = () => new HostProfileFileTransferError("INVALID_REQUEST", "The protected project transfer request is invalid.");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function key(value: unknown): Buffer {
	if (typeof value !== "string") throw invalid();
	const bytes = Buffer.from(value, "base64");
	if (bytes.length !== 32 || bytes.toString("base64") !== value) { bytes.fill(0); throw invalid(); }
	return bytes;
}
function path(value: unknown): string {
	if (typeof value !== "string" || value.length > 4096 || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalid();
	return value;
}
function fields(request: Record<string, unknown>, names: string[]) {
	if (Object.keys(request).some(name => !["requestId", "method", ...names].includes(name))) throw invalid();
}
function preview(p: Pending) {
	return { sourceDatabasePath: p.plan.source.path, destinationDatabasePath: p.plan.destination.path, counts: p.plan.summary.counts, excluded: p.plan.summary.excluded,
		...(p.plan.summary.legacy ? { legacy: p.plan.summary.legacy } : {}), authenticatedEnvelopes: p.plan.authenticatedEnvelopes, planSha256: p.reviewSha256,
		projectHandoff: { id: p.handoffId, projects: p.reader.projects.length, pendingIdentities: p.projectIds.length, instructions: p.reader.projects.filter(item => item.instructions !== undefined).length, registryPresent: p.reader.witness.presence === "present" } };
}

/** Host-private wrapper; the version-1 database transfer formats stay intact. */
export class NativeProfileProjectTransfer {
	private pending: Pending | undefined;
	private recovery: Recovery | undefined;
	private inspection: Inspection | undefined;
	private recoveryPlan: RecoveryPlan | undefined;
	private closed = false;
	private busy = false;
	constructor(private readonly now: () => number = Date.now) {}
	private async clear() {
		const values = [this.pending, this.recovery, this.recoveryPlan]; this.pending = undefined; this.recovery = undefined; this.recoveryPlan = undefined; this.inspection = undefined;
		for (const value of values) if (value) { value.sourceKey.fill(0); if ("destinationKey" in value) (value as Recovery).destinationKey.fill(0); await value.reader.close(); }
	}
	async close(): Promise<void> { this.closed = true; if (!this.busy) await this.clear(); }
	async expire(): Promise<void> { if (!this.busy && (this.pending && this.pending.expiresAt <= this.now() || this.recovery && this.recovery.expiresAt <= this.now() || this.inspection && this.inspection.expiresAt <= this.now() || this.recoveryPlan && this.recoveryPlan.expiresAt <= this.now())) await this.clear(); }
	private check(): void { if (this.closed) throw new Error(); }
	async handle(input: unknown): Promise<Record<string, unknown>> {
		const request = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
		const requestId = typeof request.requestId === "string" && PROJECT_HANDOFF_ID.test(request.requestId) ? request.requestId : null;
		if (this.busy) return { requestId, ok: false, error: { code: "TRANSFER_BUSY", message: "The protected project transfer is busy.", published: false } };
		this.busy = true;
		try {
			this.check(); if (!requestId) throw invalid();
			if (this.pending && this.pending.expiresAt <= this.now() || this.recovery && this.recovery.expiresAt <= this.now() || this.inspection && this.inspection.expiresAt <= this.now() || this.recoveryPlan && this.recoveryPlan.expiresAt <= this.now()) await this.clear();
			if (request.method === "plan-profile") {
				fields(request, ["sourceProfileRoot", "destinationCoreRoot", "handoffId", "sourceKeyBase64"]);
				await this.clear(); this.check();
				const sourceKey = key(request.sourceKeyBase64); delete request.sourceKeyBase64;
				let reader: Source | undefined;
				try {
					const sourceRoot = path(request.sourceProfileRoot), coreRoot = path(request.destinationCoreRoot), handoffId = request.handoffId;
					if (typeof handoffId !== "string" || !PROJECT_HANDOFF_ID.test(handoffId)) throw invalid();
					if (sourceRoot === coreRoot || sourceRoot.startsWith(`${coreRoot}/`) || coreRoot.startsWith(`${sourceRoot}/`)) throw new HostProfileFileTransferError("UNSAFE_PATH", "Choose separate source and destination profiles. Existing data was preserved.");
					if (await manifestPresent(coreRoot)) throw new HostProfileFileTransferError("PROJECT_HANDOFF_RECOVERY_REQUIRED", "A prepared project handoff already exists. Preserve it and review recovery before retrying.");
					reader = await readProjectHandoffSource(sourceRoot); this.check();
					const plan = planHostProfileFileTransfer({ sourceDatabasePath: join(sourceRoot, "database/kestrel.sqlite"), sourceKey, destinationDatabasePath: join(coreRoot, "database/kestrel.sqlite") });
					const refs = reviewHostProfileProjectReferences({ plan, sourceKey });
					const projectIds = [...new Set([...refs.projectIds, ...reader.projects.map(item => item.id)])].sort();
					if (projectIds.length > 500) throw new HostProfileFileTransferError("PROJECT_HANDOFF_LIMIT", "The selected profile exceeds the supported pending-project limit. Existing data was preserved.");
					await reader.verify(); this.check();
					const reviewSha256 = hash({ domain: "kestrel-native-project-transfer-v1", handoffId, coreRoot, planSha256: plan.planSha256, sourceRoot, sourceWitness: reader.witness, projectIds, projects: reader.projects });
					const p: Pending = { id: randomUUID(), handoffId, coreRoot, sourceRoot, reader, plan, sourceKey, projectIds, reviewSha256, expiresAt: this.now() + TTL };
					this.pending = p;
					return { requestId, ok: true, planId: p.id, expiresAt: p.expiresAt, preview: preview(p) };
				} catch (error) { sourceKey.fill(0); await reader?.close(); throw error; }
			}
			if (request.method === "apply-profile") {
				fields(request, ["planId", "acceptedPlanSha256", "approved", "destinationKeyBase64"]);
				const p = this.pending;
				if (!p || request.planId !== p.id) throw new HostProfileFileTransferError("PLAN_EXPIRED", "The project transfer review expired. Review it again.");
				if (request.approved !== true || request.acceptedPlanSha256 !== p.reviewSha256) throw new HostProfileFileTransferError("PLAN_NOT_ACCEPTED", "Review and accept the exact project transfer before applying it.");
				this.pending = undefined;
				let destinationKey: Buffer | undefined, file: NativeProjectHandoffFile | undefined, published = false, preparedRetained = false;
				try {
					destinationKey = key(request.destinationKeyBase64); delete request.destinationKeyBase64;
					if (timingSafeEqual(p.sourceKey, destinationKey)) throw new HostProfileFileTransferError("KEY_REUSE", "Project transfer requires an independent destination key.");
					file = new NativeProjectHandoffFile({ root: p.coreRoot, key: destinationKey });
					await p.reader.verify(); this.check();
					const currentIds = reviewHostProfileProjectReferences({ plan: p.plan, sourceKey: p.sourceKey }).projectIds;
					if (hash([...new Set([...currentIds, ...p.reader.projects.map(item => item.id)])].sort()) !== hash(p.projectIds)) throw new Error();
					const prepared: NativeProjectHandoffState = { format: "kestrel-native-project-handoff", version: 1, handoffId: p.handoffId, state: "prepared", revision: 0,
						reviewSha256: p.reviewSha256, sourceProfileRoot: p.sourceRoot, sourceWitness: p.reader.witness, corePlan: p.plan,
						reviewedProjectIds: p.projectIds, pendingProjectIds: p.projectIds, projects: structuredClone(p.reader.projects), settledProjectIds: [] };
					const created = await file.create(p.handoffId, prepared); preparedRetained = true; this.check();
					await p.reader.verify(); this.check();
					const receipt = applyHostProfileFileTransfer({ plan: p.plan, sourceKey: p.sourceKey, destinationKey, acceptedPlanSha256: p.plan.planSha256, retainRecoveryJournal: true });
					published = true;
					verifyHostProfileFileTransferRecovery(receipt, { sourceKey: p.sourceKey, destinationKey });
					await p.reader.verify(); this.check();
					const ready = { ...prepared, state: "ready" as const, receipt };
					const stored = await file.replace(p.handoffId, ready, created.witness); this.check();
					parseNativeProjectHandoffState(stored.value, p.handoffId);
					const recovery: Recovery = { ...p, id: randomUUID(), destinationKey, receipt, fileWitness: stored.witness, expiresAt: this.now() + RECOVERY_TTL };
					this.recovery = recovery;
					return { requestId, ok: true, recoveryId: recovery.id, handoffId: p.handoffId, expiresAt: recovery.expiresAt, receipt };
				} catch (error) {
					p.sourceKey.fill(0); destinationKey?.fill(0); await p.reader.close();
					if (published || preparedRetained || error instanceof HostProfileFileTransferError && error.published || error instanceof ProjectHandoffFileError && error.created) throw new HostProfileFileTransferError("PROJECT_HANDOFF_RECOVERY_REQUIRED", "The project handoff was prepared or Core data was published. Preserve both profiles and review recovery; do not retry or activate automatically.", published || error instanceof HostProfileFileTransferError && error.published);
					throw error;
				} finally { file?.close(); }
			}
			if (request.method === "inspect-profile") {
				fields(request, ["destinationCoreRoot", "handoffId"]);
				await this.clear(); this.check();
				const coreRoot = path(request.destinationCoreRoot), handoffId = request.handoffId;
				if (typeof handoffId !== "string" || !PROJECT_HANDOFF_ID.test(handoffId)) throw invalid();
				const review = inspectInterruptedHostProfileFileTransfer(join(coreRoot, "database/kestrel.sqlite"));
				const inspection: Inspection = { id: randomUUID(), handoffId, coreRoot, review, expiresAt: this.now() + TTL };
				this.inspection = inspection;
				return { requestId, ok: true, reviewId: inspection.id, expiresAt: inspection.expiresAt, preview: { state: review.state, sourceDatabasePath: review.plan.source.path,
					destinationDatabasePath: review.destinationDatabasePath, counts: review.plan.summary.counts, excluded: review.plan.summary.excluded,
					...(review.plan.summary.legacy ? { legacy: review.plan.summary.legacy } : {}), recoverySha256: review.recoverySha256 } };
			}
			if (request.method === "plan-profile-recovery") {
				fields(request, ["reviewId", "acceptedRecoverySha256", "sourceKeyBase64", "destinationKeyBase64"]);
				const inspection = this.inspection;
				if (!inspection || request.reviewId !== inspection.id) throw new HostProfileFileTransferError("RECOVERY_EXPIRED", "The interrupted transfer review expired. Inspect it again.");
				if (request.acceptedRecoverySha256 !== inspection.review.recoverySha256) throw new HostProfileFileTransferError("PLAN_NOT_ACCEPTED", "Review the exact interrupted transfer before continuing.");
				this.inspection = undefined;
				let sourceKey: Buffer | undefined, destinationKey: Buffer | undefined, reader: Source | undefined, file: NativeProjectHandoffFile | undefined;
				try {
					sourceKey = key(request.sourceKeyBase64); destinationKey = key(request.destinationKeyBase64);
					delete request.sourceKeyBase64; delete request.destinationKeyBase64;
					if (timingSafeEqual(sourceKey, destinationKey)) throw new HostProfileFileTransferError("KEY_REUSE", "Project transfer requires an independent destination key.");
					const review = inspection.review, sourceRoot = dirname(dirname(review.plan.source.path));
					if (join(sourceRoot, "database/kestrel.sqlite") !== review.plan.source.path) throw invalid();
					if (sourceRoot === inspection.coreRoot || sourceRoot.startsWith(`${inspection.coreRoot}/`) || inspection.coreRoot.startsWith(`${sourceRoot}/`)) throw invalid();
					reader = await readProjectHandoffSource(sourceRoot); this.check();
					verifyInterruptedHostProfileFileTransfer({ destinationDatabasePath: review.destinationDatabasePath, sourceKey, destinationKey, acceptedRecoverySha256: review.recoverySha256 });
					const refs = reviewHostProfileProjectReferences({ plan: review.plan, sourceKey });
					const projectIds = [...new Set([...refs.projectIds, ...reader.projects.map(item => item.id)])].sort();
					if (projectIds.length > 500) throw new HostProfileFileTransferError("PROJECT_HANDOFF_LIMIT", "The selected profile exceeds the supported pending-project limit. Existing data was preserved.");
					file = new NativeProjectHandoffFile({ root: inspection.coreRoot, key: destinationKey });
					let manifest: RecoveryPlan["manifest"];
					if (await manifestPresent(inspection.coreRoot)) {
						const stored = await file.read(inspection.handoffId);
						const state = parseNativeProjectHandoffState(stored.value, inspection.handoffId);
						if (state.revision !== 0 || state.settledProjectIds.length || !equal(state.corePlan, review.plan) || !sameProjectHandoffSourceWitness(state.sourceWitness, reader.witness) ||
							!equal(state.reviewedProjectIds, projectIds) || !equal(state.pendingProjectIds, projectIds) || !equal(state.projects, reader.projects)) throw new Error();
						manifest = { value: state, witness: stored.witness };
					}
					await reader.verify(); this.check();
					if (!equal(inspectInterruptedHostProfileFileTransfer(review.destinationDatabasePath), review)) throw new Error();
					const reviewSha256 = hash({ domain: "kestrel-native-project-recovery-v1", handoffId: inspection.handoffId, coreRoot: inspection.coreRoot,
						recoverySha256: review.recoverySha256, sourceRoot, sourceWitness: reader.witness, projectIds, projects: reader.projects, manifest: manifest?.witness ?? null });
					const p: RecoveryPlan = { id: randomUUID(), handoffId: inspection.handoffId, coreRoot: inspection.coreRoot, sourceRoot, reader, plan: review.plan,
						sourceKey, destinationKey, projectIds, reviewSha256, inspection, ...(manifest ? { manifest } : {}), expiresAt: this.now() + TTL };
					this.recoveryPlan = p;
					return { requestId, ok: true, planId: p.id, expiresAt: p.expiresAt, preview: { ...preview(p), projectHandoff: { ...preview(p).projectHandoff, manifestPresent: Boolean(manifest) } } };
				} catch (error) { sourceKey?.fill(0); destinationKey?.fill(0); await reader?.close(); throw error; }
				finally { file?.close(); }
			}
			if (request.method === "recover-profile") {
				fields(request, ["planId", "acceptedPlanSha256", "approved"]);
				const p = this.recoveryPlan;
				if (!p || request.planId !== p.id) throw new HostProfileFileTransferError("PLAN_EXPIRED", "The project recovery review expired. Inspect it again.");
				if (request.approved !== true || request.acceptedPlanSha256 !== p.reviewSha256) throw new HostProfileFileTransferError("PLAN_NOT_ACCEPTED", "Review and accept the exact project recovery before applying it.");
				this.recoveryPlan = undefined;
				const file = new NativeProjectHandoffFile({ root: p.coreRoot, key: p.destinationKey });
				let published = p.inspection.review.state === "published";
				try {
					await p.reader.verify(); this.check();
					verifyInterruptedHostProfileFileTransfer({ destinationDatabasePath: p.inspection.review.destinationDatabasePath, sourceKey: p.sourceKey, destinationKey: p.destinationKey, acceptedRecoverySha256: p.inspection.review.recoverySha256 });
					const refs = reviewHostProfileProjectReferences({ plan: p.plan, sourceKey: p.sourceKey });
					if (!equal([...new Set([...refs.projectIds, ...p.reader.projects.map(item => item.id)])].sort(), p.projectIds)) throw new Error();
					let witness: ProjectHandoffFileWitness;
					if (p.manifest) {
						const current = await file.read(p.handoffId);
						if (!equal(current.witness, p.manifest.witness) || !equal(parseNativeProjectHandoffState(current.value, p.handoffId), p.manifest.value)) throw new Error();
						witness = current.witness;
					} else {
						if (await manifestPresent(p.coreRoot)) throw new Error();
						const prepared: NativeProjectHandoffState = { format: "kestrel-native-project-handoff", version: 1, handoffId: p.handoffId, state: "prepared", revision: 0,
							reviewSha256: p.reviewSha256, sourceProfileRoot: p.sourceRoot, sourceWitness: p.reader.witness, corePlan: p.plan,
							reviewedProjectIds: p.projectIds, pendingProjectIds: p.projectIds, projects: structuredClone(p.reader.projects), settledProjectIds: [] };
						witness = (await file.create(p.handoffId, prepared)).witness;
					}
					await p.reader.verify(); this.check();
					const receipt = recoverInterruptedHostProfileFileTransfer({ destinationDatabasePath: p.inspection.review.destinationDatabasePath, sourceKey: p.sourceKey,
						destinationKey: p.destinationKey, acceptedRecoverySha256: p.inspection.review.recoverySha256, retainRecoveryJournal: true });
					published = true;
					verifyHostProfileFileTransferRecovery(receipt, { sourceKey: p.sourceKey, destinationKey: p.destinationKey });
					await p.reader.verify(); this.check();
					const ready: NativeProjectHandoffState = { format: "kestrel-native-project-handoff", version: 1, handoffId: p.handoffId, state: "ready", revision: 0,
						reviewSha256: p.reviewSha256, sourceProfileRoot: p.sourceRoot, sourceWitness: p.reader.witness, corePlan: p.plan,
						reviewedProjectIds: p.projectIds, pendingProjectIds: p.projectIds, projects: structuredClone(p.reader.projects), settledProjectIds: [], receipt };
					const stored = await file.replace(p.handoffId, ready, witness); this.check(); parseNativeProjectHandoffState(stored.value, p.handoffId);
					const recovery: Recovery = { ...p, id: randomUUID(), receipt, fileWitness: stored.witness, expiresAt: this.now() + RECOVERY_TTL };
					this.recovery = recovery;
					return { requestId, ok: true, recoveryId: recovery.id, handoffId: p.handoffId, expiresAt: recovery.expiresAt, receipt };
				} catch (error) {
					p.sourceKey.fill(0); p.destinationKey.fill(0); await p.reader.close();
					throw new HostProfileFileTransferError("PROJECT_HANDOFF_RECOVERY_REQUIRED", "The interrupted transfer needs recovery. Preserve both profiles; do not retry or activate automatically.", published || error instanceof HostProfileFileTransferError && error.published);
				} finally { file.close(); }
			}
			if (request.method === "verify-profile") {
				fields(request, ["recoveryId"]);
				const p = this.recovery;
				if (!p || request.recoveryId !== p.id) throw new HostProfileFileTransferError("RECOVERY_EXPIRED", "The project transfer verification expired. Preserve both profiles and review recovery.");
				const file = new NativeProjectHandoffFile({ root: p.coreRoot, key: p.destinationKey });
				try {
					await p.reader.verify(); this.check();
					const stored = await file.read(p.handoffId);
					if (hash(stored.witness.file) !== hash(p.fileWitness.file) || stored.witness.sha256 !== p.fileWitness.sha256) throw new Error();
					const state = parseNativeProjectHandoffState(stored.value, p.handoffId);
					if (state.state !== "ready" || state.reviewSha256 !== p.reviewSha256 || state.revision !== 0) throw new Error();
					const recovery = verifyHostProfileFileTransferRecovery(p.receipt, { sourceKey: p.sourceKey, destinationKey: p.destinationKey });
					await p.reader.verify(); this.check();
					return { requestId, ok: true, handoffId: p.handoffId, recovery };
				} finally { file.close(); }
			}
			if (request.method === "cancel-profile") {
				fields(request, ["planId"]);
				if (!this.pending || request.planId !== this.pending.id) throw invalid();
				await this.clear(); return { requestId, ok: true, cancelled: true };
			}
			throw invalid();
		} catch (error) {
			const safe = error instanceof HostProfileFileTransferError ? error : new HostProfileFileTransferError("PROJECT_HANDOFF_UNAVAILABLE", "The project handoff could not be completed safely. All existing and prepared files were preserved.");
			return { requestId, ok: false, error: { code: safe.code, message: safe.message, published: safe.published } };
		} finally {
			delete request.sourceKeyBase64; delete request.destinationKeyBase64;
			this.busy = false; if (this.closed) await this.clear();
		}
	}
}
