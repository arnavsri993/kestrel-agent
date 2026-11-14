import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { afterEach, expect, it, vi } from "vitest";
import { NativeProfileProjectTransfer } from "../../../core-service/src/native-profile-project-transfer";
import { NativeWorkspaceHost } from "./native-workspace-host";
import { NativeProjectHandoffFile } from "./native-project-handoff-file";
import { parseNativeProjectHandoffState } from "./native-project-handoff-state";
import { WorkspaceGrantStore, projectIdForPath } from "./workspace-grant-store";

const roots: string[] = [], hosts: NativeWorkspaceHost[] = [], workers: NativeProfileProjectTransfer[] = [], keys: Buffer[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const worker of workers.splice(0)) await worker.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
const at = "2026-11-06T14:00:00.000Z";
const record = { id: "original-custom-project", name: "Original project", instructions: "Keep custom instructions\nexactly.", path: "/never-probe-this-imported-folder", createdAt: at, updatedAt: at, order: 0 };
async function fixture(idForSelected?: (path: string) => string) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-workspace-handoff-"))); roots.push(root);
	const sourceRoot = join(root, "source"), coreRoot = join(root, "native-core"), selected = join(root, "native-picked-folder");
	for (const directory of [sourceRoot, coreRoot, selected]) await mkdir(directory, { mode: 0o700 });
	for (const directory of [sourceRoot, coreRoot]) await mkdir(join(directory, "database"), { mode: 0o700 });
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	const sourceRecord = { ...record, id: idForSelected?.(selected) ?? record.id };
	const source = new KestrelDatabase(join(sourceRoot, "database/kestrel.sqlite"), sourceKey);
	source.saveRuntimeSession({ id: "source-session", title: "Generated", projectId: sourceRecord.id, workspaceRoot: sourceRecord.path, privacyMode: "private", allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
	source.saveRuntimeMessage({ id: "source-message", sessionId: "source-session", role: "user", content: "Generated encrypted message", createdAt: at }); source.close();
	await writeFile(join(sourceRoot, "workspace-grants.json"), JSON.stringify([sourceRecord]), { mode: 0o600 });
	const worker = new NativeProfileProjectTransfer(); workers.push(worker); const handoffId = randomUUID();
	const planned = await worker.handle({ requestId: randomUUID(), method: "plan-profile", sourceProfileRoot: sourceRoot, destinationCoreRoot: coreRoot, handoffId, sourceKeyBase64: sourceKey.toString("base64") });
	expect(planned.ok).toBe(true);
	const applied = await worker.handle({ requestId: randomUUID(), method: "apply-profile", planId: planned.planId, acceptedPlanSha256: (planned.preview as { planSha256: string }).planSha256, approved: true, destinationKeyBase64: destinationKey.toString("base64") });
	expect(applied.ok).toBe(true); await worker.close();
	const selectFolder = vi.fn(async (_signal: AbortSignal): Promise<string | null> => selected);
	const options = { root: coreRoot, projectHandoff: { id: handoffId, keyBase64: destinationKey.toString("base64") }, selectFolder, reconfigure: async <T>(operation: () => Promise<T>) => operation() };
	function host(overrides: Partial<typeof options> = {}) { const value = new NativeWorkspaceHost({ ...options, ...overrides }); hosts.push(value); return value; }
	async function file<T>(operation: (file: NativeProjectHandoffFile) => Promise<T>) { const value = new NativeProjectHandoffFile({ root: coreRoot, key: destinationKey }); try { return await operation(value); } finally { value.close(); } }
	const grantFile = join(coreRoot, "workspace-grants.json"), handoffFile = join(coreRoot, "pending-project-handoff.json");
	return { root, coreRoot, selected, options, selectFolder, host, file, handoffId, grantFile, handoffFile };
}

it("supplies pending IDs before Core starts without treating imported hints as configured or active roots", async () => {
	const f = await fixture(), host = f.host();
	expect(await host.runtimeConfiguration()).toEqual({ workspaceRoots: [], configuredWorkspaceRoots: [], projects: [], pendingProjectIds: [record.id] });
	expect(await host.handle({ type: "get-workspace-grants" })).toMatchObject({ ok: true, projects: [], workspaceGrants: [], pendingWorkspaceProjects: [{ id: record.id, name: record.name }] });
	expect(f.selectFolder).not.toHaveBeenCalled(); expect(await readdir(f.coreRoot)).not.toContain("workspace-grants.json");
});

it("refuses an Add folder choice that would collide with a pending identity and keeps reconnection usable", async () => {
	const f = await fixture(projectIdForPath), host = f.host(), id = projectIdForPath(f.selected), before = await readFile(f.handoffFile);
	expect(await host.handle({ type: "select-workspace-folder" })).toMatchObject({ ok: false, error: expect.stringContaining("Choose folder") });
	expect(await readFile(f.handoffFile)).toEqual(before); expect(await readdir(f.coreRoot)).not.toContain("workspace-grants.json");
	expect(await host.runtimeConfiguration()).toMatchObject({ workspaceRoots: [], pendingProjectIds: [id] });
	expect(await host.handle({ type: "reconnect-workspace-project", projectId: id })).toMatchObject({ ok: true, pendingWorkspaceProjects: [], projects: [{ id, path: f.selected }] });
});

it("reconnects only the native choice under the original identity and preserves literal metadata across restart", async () => {
	const f = await fixture(), host = f.host();
	await expect(host.handle({ type: "reconnect-workspace-project", projectId: "unknown" })).rejects.toThrow();
	expect(f.selectFolder).not.toHaveBeenCalled();
	expect(await host.handle({ type: "reconnect-workspace-project", projectId: record.id, path: record.path })).toMatchObject({ ok: false });
	const result = await host.handle({ type: "reconnect-workspace-project", projectId: record.id });
	expect(result).toMatchObject({ ok: true, selectedWorkspacePath: f.selected, pendingWorkspaceProjects: [], projects: [{ id: record.id, path: f.selected, name: record.name, instructions: record.instructions, createdAt: at, updatedAt: at }] });
	expect(await f.host().runtimeConfiguration()).toMatchObject({ workspaceRoots: [f.selected], configuredWorkspaceRoots: [f.selected], pendingProjectIds: [] });
	expect(await readFile(f.grantFile, "utf8")).not.toContain(record.path);
	await f.file(async file => expect(parseNativeProjectHandoffState((await file.read(f.handoffId)).value, f.handoffId)).toMatchObject({ pendingProjectIds: [], settledProjectIds: [{ id: record.id, disposition: "connected" }] }));
});

it("keeps cancellation and a stale picker choice from creating a grant", async () => {
	const f = await fixture(), host = f.host(), before = await readFile(f.handoffFile);
	f.selectFolder.mockResolvedValueOnce(null);
	expect(await host.handle({ type: "reconnect-workspace-project", projectId: record.id })).toMatchObject({ ok: true, cancelled: true });
	expect(await readFile(f.handoffFile)).toEqual(before); expect(await readdir(f.coreRoot)).not.toContain("workspace-grants.json");
	let choose!: (path: string) => void;
	f.selectFolder.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));
	const pending = host.handle({ type: "reconnect-workspace-project", projectId: record.id });
	await vi.waitFor(() => expect(choose).toBeTypeOf("function"));
	await host.handle({ type: "remove-pending-workspace-project", projectId: record.id }); choose(f.selected);
	await expect(pending).rejects.toThrow(); expect(await readdir(f.coreRoot)).not.toContain("workspace-grants.json");
	expect((await f.host().runtimeConfiguration()).pendingProjectIds).toEqual([]);
});

it.each(["before", "after"] as const)("reconciles an interrupted %s-grant handoff without making a grant during recovery", async position => {
	const f = await fixture(), store = new WorkspaceGrantStore(f.grantFile);
	const metadata = { id: record.id, name: record.name, instructions: record.instructions, createdAt: at, updatedAt: at };
	const connect = () => store.connectFromHandoff(f.selected, metadata, async connection => {
		await f.file(async file => { const loaded = await file.read(f.handoffId); await file.replace(f.handoffId, { ...loaded.value, revision: 1, connection }, loaded.witness); });
		if (position === "before") throw new Error("Generated interruption");
	});
	if (position === "before") await expect(connect()).rejects.toThrow(); else await connect();
	const before = position === "after" ? await readFile(f.grantFile) : undefined;
	const configuration = await f.host().runtimeConfiguration();
	expect(configuration.pendingProjectIds).toEqual(position === "before" ? [record.id] : []);
	expect(configuration.workspaceRoots).toEqual(position === "before" ? [] : [f.selected]);
	if (before) expect(await readFile(f.grantFile)).toEqual(before); else expect(await readdir(f.coreRoot)).not.toContain("workspace-grants.json");
	await f.file(async file => expect((await file.read(f.handoffId)).value).not.toHaveProperty("connection"));
});

it("refuses unknown interrupted grant contents and preserves both files", async () => {
	const f = await fixture(), store = new WorkspaceGrantStore(f.grantFile);
	await expect(store.connectFromHandoff(f.selected, { id: record.id, name: record.name, createdAt: at, updatedAt: at }, async connection => {
		await f.file(async file => { const loaded = await file.read(f.handoffId); await file.replace(f.handoffId, { ...loaded.value, revision: 1, connection }, loaded.witness); });
		throw new Error("Generated interruption");
	})).rejects.toThrow();
	await writeFile(f.grantFile, "[]", { mode: 0o600 });
	const grantBytes = await readFile(f.grantFile), handoffBytes = await readFile(f.handoffFile);
	await expect(f.host().runtimeConfiguration()).rejects.toThrow();
	expect(await readFile(f.grantFile)).toEqual(grantBytes); expect(await readFile(f.handoffFile)).toEqual(handoffBytes);
});

it("requires the selected ready identity and refuses missing, unexpected or prepared metadata before configuration", async () => {
	const f = await fixture();
	const legacy = new NativeWorkspaceHost({ root: f.coreRoot, selectFolder: f.selectFolder, reconfigure: f.options.reconfigure }); hosts.push(legacy);
	await expect(legacy.runtimeConfiguration()).rejects.toThrow();
	await expect(f.host({ projectHandoff: { ...f.options.projectHandoff, id: randomUUID() } }).runtimeConfiguration()).rejects.toThrow();
	await f.file(async file => { const loaded = await file.read(f.handoffId); const { receipt: _receipt, ...prepared } = loaded.value; await file.replace(f.handoffId, { ...prepared, state: "prepared" }, loaded.witness); });
	await expect(f.host().runtimeConfiguration()).rejects.toThrow();
});
