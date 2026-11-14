import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { afterEach, expect, it } from "vitest";
import { NativeProjectHandoffFile } from "../../desktop/src/main/native-project-handoff-file";
import { parseNativeProjectHandoffState, type NativeProjectHandoffState } from "../../desktop/src/main/native-project-handoff-state";
import { NativeWorkspaceHost } from "../../desktop/src/main/native-workspace-host";
import { NativeProfileProjectTransfer } from "./native-profile-project-transfer";
import { readProjectHandoffSource } from "./project-handoff-source";

const roots: string[] = [], workers: NativeProfileProjectTransfer[] = [];
afterEach(async () => {
 for (const worker of workers.splice(0)) await worker.close();
 for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const at = "2026-11-06T14:00:00.000Z";
const records = ["pending", "connected", "removed"].map((id, order) => ({ id, name: `Original ${id}`, instructions: `Private ${id}\nCafé 🦅`,
 path: `/never-probe/${id}`, createdAt: at, updatedAt: at, order }));
async function request(worker: NativeProfileProjectTransfer, method: string, values: Record<string, unknown> = {}): Promise<any> {
 return worker.handle({ requestId: randomUUID(), method, ...values });
}
async function stage(root: string, name: string, source: string, sourceKey: Buffer) {
 const destination = join(root, name); await mkdir(destination, { mode: 0o700 }); await mkdir(join(destination, "database"), { mode: 0o700 });
 const key = randomBytes(32), id = randomUUID(), worker = new NativeProfileProjectTransfer(); workers.push(worker);
 const plan = () => request(worker, "plan-profile", { sourceProfileRoot: source, sourceKeyBase64: sourceKey.toString("base64"), destinationCoreRoot: destination, handoffId: id });
 const apply = (p: any) => request(worker, "apply-profile", { planId: p.planId, acceptedPlanSha256: p.preview.planSha256, approved: true, destinationKeyBase64: key.toString("base64") });
 return { destination, key, id, worker, plan, apply };
}
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-two-hop-"))); roots.push(root);
 const source = join(root, "source"); await mkdir(source, { mode: 0o700 });
 const key = randomBytes(32), db = new KestrelDatabase(join(source, "database/kestrel.sqlite"), key);
 for (const project of records) {
  db.saveRuntimeSession({ id: `session-${project.id}`, title: project.name, projectId: project.id, workspaceRoot: project.path, privacyMode: "private", allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
  db.saveRuntimeMessage({ id: `message-${project.id}`, sessionId: `session-${project.id}`, role: "user", content: project.instructions, createdAt: at });
 }
 db.close(); await writeFile(join(source, "workspace-grants.json"), JSON.stringify(records), { mode: 0o600 });
 const first = await stage(root, "first", source, key), plan = await first.plan(); expect(plan.ok).toBe(true);
 const applied = await first.apply(plan); expect(applied.ok).toBe(true);
 expect((await request(first.worker, "verify-profile", { recoveryId: applied.recoveryId })).ok).toBe(true);
 await first.worker.close();
 const second = await stage(root, "second", first.destination, first.key);
 return { root, source, first, second };
}
async function state(stage: { destination: string; key: Buffer; id: string }) {
 const file = new NativeProjectHandoffFile({ root: stage.destination, key: stage.key });
 try { return parseNativeProjectHandoffState((await file.read(stage.id)).value, stage.id); } finally { file.close(); }
}
async function mutate(stage: { destination: string; key: Buffer; id: string }, change: (value: NativeProjectHandoffState) => unknown) {
 const file = new NativeProjectHandoffFile({ root: stage.destination, key: stage.key });
 try {
  const current = await file.read(stage.id);
  await file.replace(stage.id, change(parseNativeProjectHandoffState(current.value, stage.id)) as Record<string, unknown>, current.witness);
 } finally { file.close(); }
}
async function tree(root: string): Promise<Record<string, string>> {
 const result: Record<string, string> = {};
 for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isDirectory()) for (const [name, hash] of Object.entries(await tree(join(root, entry.name)))) result[`${entry.name}/${name}`] = hash;
  else result[entry.name] = createHash("sha256").update(await readFile(join(root, entry.name))).digest("hex");
 }
 return result;
}

it("preserves exact pending metadata through two encrypted transfers without source mutations or grants", async () => {
 const f = await fixture(), before = await tree(f.first.destination), original = await tree(f.source);
 const plan = await f.second.plan(); expect(plan.ok).toBe(true); expect(plan.preview.projectHandoff).toMatchObject({ projects: 3, pendingIdentities: 3, registryPresent: false });
 expect(JSON.stringify(plan)).not.toContain("Private pending");
 const applied = await f.second.apply(plan); expect(applied.ok).toBe(true);
 expect((await request(f.second.worker, "verify-profile", { recoveryId: applied.recoveryId })).ok).toBe(true);
 const imported = await state(f.second);
 expect(imported.projects).toEqual(records.map(({ path, ...record }) => ({ ...record, pathHint: path })));
 expect(imported.pendingProjectIds).toEqual(["connected", "pending", "removed"]); expect(imported.settledProjectIds).toEqual([]);
 const host = new NativeWorkspaceHost({ root: f.second.destination, projectHandoff: { id: f.second.id, keyBase64: f.second.key.toString("base64") }, selectFolder: async () => { throw Error("No folder picker allowed"); }, reconfigure: async fn => fn() });
 try { expect(await host.runtimeConfiguration()).toMatchObject({ projects: [], workspaceRoots: [], configuredWorkspaceRoots: [], pendingProjectIds: ["connected", "pending", "removed"] }); }
 finally { await host.close(); }
 expect(await tree(f.first.destination)).toEqual(before); expect(await tree(f.source)).toEqual(original);
 expect((await readdir(f.second.destination)).includes("workspace-grants.json")).toBe(false);
 const db = new KestrelDatabase(join(f.second.destination, "database/kestrel.sqlite"), f.second.key);
 try { for (const project of records) expect(db.listRuntimeMessages(`session-${project.id}`).some(row => row.content === project.instructions)).toBe(true); }
 finally { db.close(); }
});

it("keeps current connected edits, pending details and removal tombstones across subsequent transfers", async () => {
 const f = await fixture(), connected = { ...records[1]!, name: "Reconnected and renamed", instructions: "Updated after reconnect", path: "/never-probe/new-location", updatedAt: "2026-11-07T14:00:00.000Z" };
 await writeFile(join(f.first.destination, "workspace-grants.json"), JSON.stringify([connected]), { mode: 0o600 });
 await mutate(f.first, value => ({ ...value, revision: 3, pendingProjectIds: ["pending"], settledProjectIds: [{ id: "connected", disposition: "connected" }, { id: "removed", disposition: "removed" }], projects: value.projects.filter(project => project.id !== "removed") }));
 const before = await tree(f.first.destination), plan = await f.second.plan(); expect(plan.ok).toBe(true);
 expect((await f.second.apply(plan)).ok).toBe(true);
 const result = await state(f.second);
 expect(result.pendingProjectIds).toEqual(["connected", "pending"]); expect(result.settledProjectIds).toEqual([{ id: "removed", disposition: "removed" }]);
 expect(result.projects).toEqual([connected, records[0]!].map(({ path, ...record }) => ({ ...record, pathHint: path })));
 expect(await tree(f.first.destination)).toEqual(before);
 await f.second.worker.close();
 // This in-process test owns the transfer journal. Give its generated recovery
 // fixture an already-reaped worker identity; this is not crash evidence.
 const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 5000, stdio: "ignore" }); expect(exited.status).toBe(0);
 const journalPath = join(f.second.destination, "database/kestrel.sqlite.kestrel-transfer-journal");
 const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.ownerPid = exited.pid;
 await writeFile(journalPath, JSON.stringify(journal));
 const recovery = new NativeProfileProjectTransfer(); workers.push(recovery);
 const inspected = await request(recovery, "inspect-profile", { destinationCoreRoot: f.second.destination, handoffId: f.second.id }); expect(inspected.ok).toBe(true);
 const reviewed = await request(recovery, "plan-profile-recovery", { reviewId: inspected.reviewId, acceptedRecoverySha256: inspected.preview.recoverySha256,
  sourceKeyBase64: f.first.key.toString("base64"), destinationKeyBase64: f.second.key.toString("base64") }); expect(reviewed.ok).toBe(true);
 const recovered = await request(recovery, "recover-profile", { planId: reviewed.planId, acceptedPlanSha256: reviewed.preview.planSha256, approved: true }); expect(recovered.ok).toBe(true);
 expect((await request(recovery, "verify-profile", { recoveryId: recovered.recoveryId })).ok).toBe(true); await recovery.close();
 const third = await stage(f.root, "third", f.second.destination, f.second.key), next = await third.plan(); expect(next.ok).toBe(true); expect((await third.apply(next)).ok).toBe(true);
 expect(await state(third)).toMatchObject({ pendingProjectIds: result.pendingProjectIds, projects: result.projects, settledProjectIds: result.settledProjectIds });
});

it("preserves pending IDs without display hints and does not resurrect disconnected settled metadata", async () => {
 const f = await fixture();
 await mutate(f.first, value => ({ ...value, revision: 2, reviewedProjectIds: [...value.reviewedProjectIds, "hintless"], pendingProjectIds: ["pending", "hintless"],
  settledProjectIds: [{ id: "connected", disposition: "connected" }, { id: "removed", disposition: "removed" }], projects: value.projects.filter(project => project.id !== "removed") }));
 const plan = await f.second.plan(); expect(plan.ok).toBe(true); expect((await f.second.apply(plan)).ok).toBe(true);
 const result = await state(f.second);
 expect(result.pendingProjectIds).toEqual(["hintless", "pending"]);
 expect(result.settledProjectIds).toEqual([{ id: "connected", disposition: "removed" }, { id: "removed", disposition: "removed" }]);
 expect(result.projects.map(item => item.id)).toEqual(["pending"]);
});

it("requires a key for existing pending metadata and detects a new pending manifest after review", async () => {
 const f = await fixture(); await expect(readProjectHandoffSource(f.first.destination)).rejects.toThrow();
 const source = await readProjectHandoffSource(f.source, randomBytes(32));
 try {
  await writeFile(join(f.source, "pending-project-handoff.json"), await readFile(join(f.first.destination, "pending-project-handoff.json")), { mode: 0o600 });
  await expect(source.verify()).rejects.toThrow();
 } finally { await source.close(); }
});

it.each(["pending-grant", "path-collision", "prepared", "connection", "destination", "unknown-field", "duplicate-id"])("rejects ambiguous or incomplete authenticated pending metadata (%s)", async problem => {
 const f = await fixture();
 if (problem === "pending-grant") await writeFile(join(f.first.destination, "workspace-grants.json"), JSON.stringify([records[0]]), { mode: 0o600 });
 else if (problem === "path-collision") await writeFile(join(f.first.destination, "workspace-grants.json"), JSON.stringify([{ ...records[0], id: "different" }]), { mode: 0o600 });
 else await mutate(f.first, value => {
  if (problem === "prepared") { const { receipt: _, ...rest } = value; return { ...rest, state: "prepared" }; }
  if (problem === "connection") return { ...value, connection: { project: { ...records[0] }, beforeSha256: null, afterSha256: "a".repeat(64) } };
  if (problem === "destination") return { ...value, corePlan: { ...value.corePlan, destination: { ...value.corePlan.destination, path: join(f.root, "elsewhere/database/kestrel.sqlite") } } };
  if (problem === "unknown-field") return { ...value, unknown: true };
  return { ...value, pendingProjectIds: ["pending", "pending", "removed"] };
 });
 const before = await tree(f.first.destination);
 expect((await f.second.plan()).ok).toBe(false); expect(await readdir(f.second.destination)).toEqual(["database"]); expect(await tree(f.first.destination)).toEqual(before);
});

it.each(["wrong-key", "tamper", "symlink", "hardlink", "oversize", "permissions", "foreign-root"])("rejects unsafe pending envelopes (%s)", async problem => {
 const f = await fixture(), filename = join(f.first.destination, "pending-project-handoff.json");
 if (problem === "wrong-key") { await expect(readProjectHandoffSource(f.first.destination, randomBytes(32))).rejects.toThrow(); return; }
 if (problem === "tamper") { const value = JSON.parse(await readFile(filename, "utf8")); value.authTag = Buffer.alloc(16).toString("base64"); await writeFile(filename, JSON.stringify(value)); }
 if (problem === "symlink") { await rename(filename, `${filename}.old`); await symlink(`${filename}.old`, filename); }
 if (problem === "hardlink") await link(filename, `${filename}.link`);
 if (problem === "oversize") await writeFile(filename, Buffer.alloc(4 * 1024 * 1024 + 1));
 if (problem === "permissions") await chmod(filename, 0o644);
 if (problem === "foreign-root") {
  const other = join(f.root, "foreign"); await mkdir(other, { mode: 0o700 }); await writeFile(join(other, "pending-project-handoff.json"), await readFile(filename), { mode: 0o600 });
  await expect(readProjectHandoffSource(other, f.first.key)).rejects.toThrow(); return;
 }
 expect((await f.second.plan()).ok).toBe(false); expect(await readdir(f.second.destination)).toEqual(["database"]);
});

it.each(["rewrite", "replace", "remove"])("retains a strict pending-manifest witness between review and apply (%s)", async change => {
 const f = await fixture(), plan = await f.second.plan(); expect(plan.ok).toBe(true);
 const filename = join(f.first.destination, "pending-project-handoff.json"), bytes = await readFile(filename);
 if (change === "rewrite") await writeFile(filename, bytes);
 if (change === "replace") { await rename(filename, `${filename}.old`); await writeFile(filename, bytes, { mode: 0o600 }); }
 if (change === "remove") await rm(filename);
 expect((await f.second.apply(plan)).ok).toBe(false); expect(await readdir(f.second.destination)).toEqual(["database"]);
});
