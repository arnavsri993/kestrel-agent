import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ provision: vi.fn(), open: vi.fn() }));
vi.mock("./native-vault-provisioner", () => ({ withProvisionedNativeVault: seam.provision, NativeVaultProvisioningCleanupError: class extends Error {} }));
vi.mock("./native-profile-export-worker", () => ({ NativeProfileExportWorker: { open: seam.open } }));
import { NativeProfileExportHost, type NativeProfileExportHostOptions } from "./native-profile-export-host";
import { NativeVaultProvisioningCleanupError } from "./native-vault-provisioner";

const roots: string[] = [];
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "kestrel-export-host-test-")); roots.push(root);
	const source = join(root, "source"), parent = join(root, "destination");
	for (const path of [source, parent]) mkdirSync(path, { mode: 0o700 });
	writeFileSync(join(source, "sentinel"), "original preserved", { mode: 0o600 });
	let ready = true, running = true;
	const stop = vi.fn(async () => { ready = false; running = false; });
	const resume = vi.fn(async () => { ready = true; running = true; });
	const key = Buffer.alloc(32, 73);
	const broker = { withCachedDatabaseKey: vi.fn(async (operation: (key: Buffer) => unknown) => {
		const borrowed = Buffer.from(key); try { return await operation(borrowed); } finally { borrowed.fill(0); }
	}) };
	let provisionedKey: Buffer | undefined, generatedProfile = "";
	seam.provision.mockImplementation(async (request, operation) => {
		generatedProfile = join(request.parent, "profile"); mkdirSync(generatedProfile, { mode: 0o700 });
		writeFileSync(join(generatedProfile, ".kestrel-local-vault-v1"), "encrypted fixture", { mode: 0o600 });
		provisionedKey = Buffer.alloc(32, 29);
		try { return await operation({ profile: generatedProfile, key: provisionedKey, vaultSha256: "e".repeat(64) }); }
		finally { provisionedKey.fill(0); }
	});
	const close = vi.fn(async () => ({ confirmed: true, clean: true }));
	const requests: string[] = [];
	const request = vi.fn(async (method: string, value: Record<string, any>) => {
		requests.push(method);
		if (method === "plan-profile") return { ok: true, planId: "b6517281-e409-4a69-b09c-c9c738a48fa8", preview: {
			sourceDatabasePath: join(source, "database/kestrel.sqlite"), destinationDatabasePath: join(value.destinationCoreRoot, "database/kestrel.sqlite"),
			planSha256: "a".repeat(64), counts: { runtime_sessions: 2, runtime_messages: 4, memories: 1 }, excluded: { scheduledJobsCancelled: 1 },
			projectHandoff: { id: value.handoffId, projects: 1, pendingIdentities: 0, instructions: 1 },
		} };
		if (method === "apply-profile") return { ok: true, recoveryId: "f2f53e3e-3ba2-40a8-9c12-0951cd58657c", receipt: { activationPerformed: false } };
		return { ok: true, recovery: { originalReadable: true, destinationReadable: true, activationPerformed: false } };
	});
	seam.open.mockResolvedValue({ request, close });
	const options: NativeProfileExportHostOptions = {
		sourceRoot: source, broker: broker as any,
		core: { get isReady() { return ready; }, get hasProcess() { return running; }, stop, resumeLastConfiguration: resume },
		workerExecutable: "/fixture/node", workerEntry: "/fixture/worker", vaultProvisioner: "/fixture/provisioner",
		isBusy: vi.fn(() => false), shouldRestoreCore: () => true,
		chooseParent: vi.fn(async () => parent), approve: vi.fn(async () => true), changed: vi.fn(),
	};
	const host = new NativeProfileExportHost(options);
	return { host, options, source, parent, stop, resume, broker, close, request, requests, get key() { return provisionedKey; }, get profile() { return generatedProfile; } };
}

describe("source-host Chromium transfer", () => {
	it("requires an already-unlocked key before showing a picker or stopping Core", async () => {
		const f = fixture(); f.broker.withCachedDatabaseKey.mockRejectedValueOnce(new Error("not cached"));
		await expect(f.host.execute()).rejects.toThrow("could not be prepared");
		expect(f.options.chooseParent).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(seam.provision).not.toHaveBeenCalled();
	});
	it("cancels the picker without stopping Core, provisioning a key, or making a folder", async () => {
		const f = fixture(); vi.mocked(f.options.chooseParent).mockResolvedValueOnce(null);
		await expect(f.host.execute()).resolves.toEqual({ state: "cancelled" });
		expect(f.stop).not.toHaveBeenCalled(); expect(seam.provision).not.toHaveBeenCalled(); expect(f.host.outputFolder).toBeUndefined();
	});
	it.each(["source", "descendant"])("refuses a %s destination before stopping or writing source data", async type => {
		const f = fixture(), target = type === "source" ? f.source : join(f.source, "inside");
		if (type === "descendant") mkdirSync(target, { mode: 0o700 });
		vi.mocked(f.options.chooseParent).mockResolvedValueOnce(target);
		await expect(f.host.execute()).rejects.toThrow(); expect(f.stop).not.toHaveBeenCalled(); expect(seam.provision).not.toHaveBeenCalled();
		expect(readFileSync(join(f.source, "sentinel"), "utf8")).toBe("original preserved");
	});
	it("refuses a concurrent operation and rechecks active work after the picker", async () => {
		const f = fixture(); let selected!: (value: string) => void;
		vi.mocked(f.options.chooseParent).mockImplementationOnce(() => new Promise(resolve => { selected = resolve; }));
		const pending = f.host.execute(); await vi.waitFor(() => expect(f.options.chooseParent).toHaveBeenCalled());
		await expect(f.host.execute()).rejects.toThrow("Wait for active work");
		vi.mocked(f.options.isBusy).mockReturnValue(true); selected(f.parent);
		await expect(pending).rejects.toThrow(); expect(f.stop).not.toHaveBeenCalled();
	});
	it("requires a clean and confirmed source stop, retaining a restart barrier on failure", async () => {
		const f = fixture(); f.stop.mockRejectedValueOnce(new Error("forced exit"));
		await expect(f.host.execute()).rejects.toThrow();
		expect(f.stop).toHaveBeenCalledWith({ requireCleanExit: true, gracefulTimeoutMs: 60000 });
		expect(f.host.restartRequired).toBe(true); expect(seam.provision).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
		await expect(f.host.execute()).rejects.toThrow("Wait for active work");
	});
	it("cancels the bounded preview without copying data or publishing a usable profile, then resumes the source", async () => {
		const f = fixture(); vi.mocked(f.options.approve).mockResolvedValueOnce(false);
		await expect(f.host.execute()).resolves.toMatchObject({ state: "cancelled" });
		expect(f.requests).toEqual(["plan-profile"]); expect(f.close).toHaveBeenCalled(); expect(f.resume).toHaveBeenCalledOnce();
		expect(existsSync(join(f.profile, ".kestrel-desktop.lock"))).toBe(false); expect(f.key).toEqual(Buffer.alloc(32));
	});
	it("publishes a native profile only after approved apply, authenticated verification and clean worker exit", async () => {
		const f = fixture(); const result = await f.host.execute();
		expect(result.state).toBe("prepared"); expect(f.requests).toEqual(["plan-profile", "apply-profile", "verify-profile"]);
		expect(f.options.approve).toHaveBeenCalledWith({ counts: { runtime_sessions: 2, runtime_messages: 4, memories: 1 }, excluded: { scheduledJobsCancelled: 1 }, projects: 1, pendingProjects: 0, instructions: 1 }, expect.any(AbortSignal));
		const selection = JSON.parse(readFileSync(join(f.profile, "native-core-profile.json"), "utf8"));
		expect(selection).toMatchObject({ version: 2, active: "", previous: "", handoffs: { "": expect.any(String) } });
		expect(readFileSync(join(f.profile, ".kestrel-desktop.lock"), "utf8")).toBe("");
		const status = JSON.parse(readFileSync(join(f.host.outputFolder!, "transfer-status.json"), "utf8"));
		expect(status).toMatchObject({ state: "prepared", deviceBound: true, activationPerformed: false });
		expect(JSON.stringify(status)).not.toMatch(/sourceKey|destinationKey|Base64|recoveryId|planId/);
		expect(f.resume).toHaveBeenCalledOnce(); expect(readFileSync(join(f.source, "sentinel"), "utf8")).toBe("original preserved"); expect(f.key).toEqual(Buffer.alloc(32));
	});
	it.each(["invalid-plan", "unreadable-destination", "activated-copy"])("does not publish a native profile after %s", async mode => {
		const f = fixture(), implementation = f.request.getMockImplementation()!;
		f.request.mockImplementation(async (method, value) => {
			const result = await implementation(method, value);
			if (mode === "invalid-plan" && method === "plan-profile") result.preview!.sourceDatabasePath = "/unreviewed/path";
			if (mode === "unreadable-destination" && method === "verify-profile") result.recovery!.destinationReadable = false;
			if (mode === "activated-copy" && method === "apply-profile") result.receipt!.activationPerformed = true;
			return result;
		});
		await expect(f.host.execute()).rejects.toThrow(); expect(f.resume).toHaveBeenCalledOnce();
		expect(existsSync(join(f.profile, ".kestrel-desktop.lock"))).toBe(false);
	});
	it("keeps the source stopped and requires restart if worker exit cannot be confirmed", async () => {
		const f = fixture(); f.close.mockResolvedValue({ confirmed: false, clean: false });
		await expect(f.host.execute()).rejects.toThrow(); expect(f.host.restartRequired).toBe(true); expect(f.resume).not.toHaveBeenCalled();
		expect(existsSync(join(f.profile, ".kestrel-desktop.lock"))).toBe(false);
	});
	it("never restarts the source when Quit cancels a pending review", async () => {
		const f = fixture(); vi.mocked(f.options.approve).mockImplementationOnce((_preview, signal) => new Promise(resolve => { signal.addEventListener("abort", () => resolve(false), { once: true }); }));
		const pending = f.host.execute(); await vi.waitFor(() => expect(f.options.approve).toHaveBeenCalled());
		await f.host.close(); await expect(pending).rejects.toThrow(); expect(f.resume).not.toHaveBeenCalled();
		expect(existsSync(join(f.profile, ".kestrel-desktop.lock"))).toBe(false); expect(f.host.busy).toBe(false);
	});
	it("reports a required restart if restoring the retained source configuration fails", async () => {
		const f = fixture(); f.resume.mockRejectedValueOnce(new Error("failed startup"));
		await expect(f.host.execute()).rejects.toThrow("Restart Kestrel"); expect(f.host.restartRequired).toBe(true);
		expect(existsSync(join(f.profile, ".kestrel-desktop.lock"))).toBe(true);
	});
	it("settles cancellation even if a native picker or review promise ignores the abort signal", async () => {
		for (const stage of ["picker", "review"]) {
			const f = fixture();
			if (stage === "picker") vi.mocked(f.options.chooseParent).mockImplementationOnce(() => new Promise(() => {}));
			else vi.mocked(f.options.approve).mockImplementationOnce(() => new Promise(() => {}));
			const pending = f.host.execute(), rejected = expect(pending).rejects.toThrow();
			await vi.waitFor(() => expect(stage === "picker" ? f.options.chooseParent : f.options.approve).toHaveBeenCalled());
			await f.host.close(); await rejected;
			expect(f.host.busy).toBe(false); expect(f.resume).not.toHaveBeenCalled();
		}
	});
	it("expedites the same in-flight maintenance stop on Quit and never starts an export", async () => {
		const f = fixture(); let stopping = false, running = true, refuse!: (error: Error) => void;
		Object.defineProperties(f.options.core, { isReady: { get: () => !stopping }, hasProcess: { get: () => running } });
		f.stop.mockImplementationOnce(async () => { stopping = true; return new Promise((_resolve, reject) => { refuse = reject; }); });
		f.stop.mockImplementationOnce(async () => { running = false; refuse(new Error("forced maintenance stop")); });
		const pending = f.host.execute(), rejected = expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
		await f.host.close(); await rejected;
		expect(f.stop).toHaveBeenLastCalledWith({ gracefulTimeoutMs: 0 }); expect(seam.provision).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
	});
	it("waits for the provisioner's abort cleanup before allowing the host to exit", async () => {
		const f = fixture(); let finishCleanup!: () => void, reaped = false, closed = false;
		seam.provision.mockImplementationOnce(async (request) => new Promise((_resolve, reject) => {
			request.signal.addEventListener("abort", () => { finishCleanup = () => { reaped = true; reject(new Error("cancelled after owned-child exit")); }; }, { once: true });
		}));
		const pending = f.host.execute(), rejected = expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(seam.provision).toHaveBeenCalled());
		const close = f.host.close().then(() => { closed = true; });
		await Promise.resolve(); expect(closed).toBe(false); expect(reaped).toBe(false);
		finishCleanup(); await close; await rejected;
		expect(reaped).toBe(true); expect(f.host.busy).toBe(false); expect(f.resume).not.toHaveBeenCalled();
	});
	it("requires restart without resuming the source when provisioner cleanup is unconfirmed", async () => {
		const f = fixture(); seam.provision.mockRejectedValueOnce(new NativeVaultProvisioningCleanupError());
		await expect(f.host.execute()).rejects.toThrow(); expect(f.host.restartRequired).toBe(true); expect(f.resume).not.toHaveBeenCalled();
	});
});
