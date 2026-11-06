import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { launchCoreTransferFixture, writeCoreTransferCrashPreload } from "../../../scripts/native-core-transfer-crash-fixture.js";
import { KestrelDatabase } from "@kestrel/database";
import { NativeProjectHandoffFile } from "../../desktop/src/main/native-project-handoff-file";
import { parseNativeProjectHandoffState } from "../../desktop/src/main/native-project-handoff-state";
import { NativeProfileProjectTransfer } from "./native-profile-project-transfer";

vi.setConfig({ testTimeout: 20_000 });

const repository = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const corePackage = join(repository, "apps/core-service/package.json");
const buildRoot = await realpath(await mkdtemp(join(tmpdir(), "kestrel-project-recovery-build-")));
const newEntry = join(buildRoot, "project-worker.mjs"), oldEntry = join(buildRoot, "file-worker.mjs");
const roots: string[] = [], clients: ReturnType<typeof launchCoreTransferFixture>[] = [], workers: NativeProfileProjectTransfer[] = [], keys: Buffer[] = [];
const createdAt = "2026-11-06T14:00:00.000Z", privateText = "GENERATED recovery instructions with private detail";
const project = { id: "generated-project-id", path: "/generated/private/workspace", name: "Generated private project", instructions: privateText, createdAt, updatedAt: createdAt, order: 0 };
type ProjectPreview = { projectHandoff: { projects: number; pendingIdentities: number; manifestPresent?: boolean } };
type InspectionResponse = { ok: true; reviewId: string; preview: { state: string; recoverySha256: string } };
type RecoveryPlanResponse = { ok: true; planId: string; preview: ProjectPreview & { planSha256: string } };
type TransferPlanResponse = { ok: true; planId: string; preview: { planSha256: string } };

beforeAll(async () => {
	const runtime = createRequire(corePackage), { build } = runtime("esbuild");
	const plugin = [{ name: "fixture-native-dependency", setup(builder: { onResolve(options: { filter: RegExp }, callback: () => { path: string; external: boolean }): void }) {
		builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: runtime.resolve("better-sqlite3"), external: true }));
	} }];
	const banner = { js: `import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(${JSON.stringify(corePackage)});` };
	await Promise.all([
		build({ entryPoints: [join(repository, "apps/core-service/src/host-profile-project-transfer-worker.ts")], outfile: newEntry, bundle: true, platform: "node", target: "node24", format: "esm", external: ["better-sqlite3", "sharp"], plugins: plugin, banner }),
		build({ entryPoints: [join(repository, "apps/core-service/src/host-profile-file-transfer-worker.ts")], outfile: oldEntry, bundle: true, platform: "node", target: "node24", format: "esm", external: ["better-sqlite3", "sharp"], plugins: plugin, banner }),
	]);
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.close();
	for (const client of clients.splice(0)) { if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGKILL"); await client.exited; }
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	for (const key of keys.splice(0)) key.fill(0);
});
afterAll(async () => { await rm(buildRoot, { recursive: true, force: true }); });

function launch(home: string, entry = newEntry, preload?: string) {
	const value = launchCoreTransferFixture({ executable: process.execPath, entry, home, ...(preload ? { preload } : {}), requestTimeoutMs: 20_000 });
	clients.push(value); return value;
}
async function fixture(withRegistry = true) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-project-recovery-"))); roots.push(root);
	const sourceProfileRoot = join(root, "source"), destinationCoreRoot = join(root, "destination");
	for (const folder of [sourceProfileRoot, destinationCoreRoot]) { await mkdir(folder, { mode: 0o700 }); await mkdir(join(folder, "database"), { mode: 0o700 }); }
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	const source = join(sourceProfileRoot, "database/kestrel.sqlite"), destination = join(destinationCoreRoot, "database/kestrel.sqlite");
	const db = new KestrelDatabase(source, sourceKey);
	db.saveRuntimeSession({ id: "generated-private-session", title: "Generated private session", projectId: project.id, workspaceRoot: project.path, privacyMode: "private", allowedTools: [], status: "active", checkpoints: [], createdAt, updatedAt: createdAt });
	db.saveRuntimeMessage({ id: "generated-private-message", sessionId: "generated-private-session", role: "user", content: privateText, createdAt }); db.close();
	if (withRegistry) await writeFile(join(sourceProfileRoot, "workspace-grants.json"), JSON.stringify([project]), { mode: 0o600 });
	return { root, sourceProfileRoot, destinationCoreRoot, source, destination, sourceKey, destinationKey, handoffId: randomUUID() };
}
function newWorker(now: () => number = Date.now) { const worker = new NativeProfileProjectTransfer(now); workers.push(worker); return worker; }
function request(worker: NativeProfileProjectTransfer, method: string, body: Record<string, unknown> = {}) { return worker.handle({ requestId: randomUUID(), method, ...body }); }
function assertInspection(value: Record<string, unknown>): asserts value is Record<string, unknown> & InspectionResponse {
	const preview = value.preview;
	if (value.ok !== true || typeof value.reviewId !== "string" || !preview || typeof preview !== "object" || Array.isArray(preview) ||
		typeof (preview as Record<string, unknown>).state !== "string" || typeof (preview as Record<string, unknown>).recoverySha256 !== "string") throw new Error("Generated recovery inspection was invalid.");
}
function assertRecoveryPlan(value: Record<string, unknown>): asserts value is Record<string, unknown> & RecoveryPlanResponse {
	const preview = value.preview;
	if (value.ok !== true || typeof value.planId !== "string" || !preview || typeof preview !== "object" || Array.isArray(preview) ||
		typeof (preview as Record<string, unknown>).planSha256 !== "string" || !(preview as Record<string, unknown>).projectHandoff ||
		typeof (preview as Record<string, unknown>).projectHandoff !== "object") throw new Error("Generated recovery plan was invalid.");
}
function assertTransferPlan(value: Record<string, unknown>): asserts value is Record<string, unknown> & TransferPlanResponse {
	const preview = value.preview;
	if (value.ok !== true || typeof value.planId !== "string" || !preview || typeof preview !== "object" || Array.isArray(preview) ||
		typeof (preview as Record<string, unknown>).planSha256 !== "string") throw new Error("Generated transfer plan was invalid.");
}
function assertNoSecrets(value: unknown, f: Awaited<ReturnType<typeof fixture>>) {
	const text = JSON.stringify(value);
	for (const secret of [privateText, project.id, project.path, f.sourceKey.toString("base64"), f.destinationKey.toString("base64")]) expect(text).not.toContain(secret);
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
	const paths = [f.source, f.destination, join(f.destinationCoreRoot, "pending-project-handoff.json"), `${f.destination}.kestrel-transfer-journal`, `${f.destination}.kestrel-transfer-lock`];
	const files = await Promise.all(paths.map(async path => { try { return [path, await readFile(path)] as const; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, null] as const; throw error; } }));
	return files;
}
async function touchRootCtime(root: string) {
	const before = await stat(root);
	await chmod(root, 0o500);
	await chmod(root, 0o700);
	const after = await stat(root);
	expect(after.size).toBe(before.size);
	expect(after.mtimeMs).toBe(before.mtimeMs);
	expect(after.ctimeMs).not.toBe(before.ctimeMs);
}
async function preparedRecovery(f: Awaited<ReturnType<typeof fixture>>, state: "staged" | "published", manifestPresent: boolean) {
	const worker = newWorker();
	const inspected = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId });
	assertInspection(inspected);
	expect(inspected.ok).toBe(true); expect(inspected.preview).toMatchObject({ state }); assertNoSecrets(inspected, f);
	const readOnlyBefore = await snapshot(f);
	const planned = await request(worker, "plan-profile-recovery", { reviewId: inspected.reviewId, acceptedRecoverySha256: inspected.preview.recoverySha256,
		sourceKeyBase64: f.sourceKey.toString("base64"), destinationKeyBase64: f.destinationKey.toString("base64") });
	assertRecoveryPlan(planned);
	expect(planned.ok).toBe(true); expect(planned.preview.projectHandoff).toMatchObject({ projects: 1, pendingIdentities: 1, manifestPresent }); assertNoSecrets(planned, f);
	expect(await snapshot(f)).toEqual(readOnlyBefore);
	return { worker, inspected, planned };
}
async function crashBeforeLink(f: Awaited<ReturnType<typeof fixture>>) {
	const preload = join(f.root, "crash.mjs"); await writeCoreTransferCrashPreload(preload, f.destination, "before-link");
	const owner = launch(f.root, newEntry, preload), plan = await owner.request("plan-profile", { sourceProfileRoot: f.sourceProfileRoot, destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId, sourceKeyBase64: f.sourceKey.toString("base64") });
	assertTransferPlan(plan);
	owner.send("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(await owner.exited).toEqual({ code: null, signal: "SIGKILL" }); expect(owner.errors()).toBe("");
	return owner;
}
async function writeJournalOpenFailurePreload(file: string, destination: string) {
	const journal = `${destination}.kestrel-transfer-journal`;
	await writeFile(file, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const journal=${JSON.stringify(journal)};
const original=fs.openSync;
fs.openSync=function(path,...args){if(path===journal){const error=new Error('Generated fixture blocks journal creation');error.code='EIO';throw error;}return original.call(fs,path,...args);};
syncBuiltinESMExports();
`, { mode: 0o600, flag: "wx" });
}

it("recovers a completed project transfer after its owning worker exits", async () => {
	const f = await fixture(), sourceBefore = await readFile(f.source), registryBefore = await readFile(join(f.sourceProfileRoot, "workspace-grants.json"));
	const owner = launch(f.root);
	const plan = await owner.request("plan-profile", { sourceProfileRoot: f.sourceProfileRoot, destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId, sourceKeyBase64: f.sourceKey.toString("base64") });
	assertTransferPlan(plan);
	expect(plan.ok).toBe(true); assertNoSecrets(plan, f);
	const applied = await owner.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(applied.ok).toBe(true); assertNoSecrets(applied, f);
	expect(await owner.stop()).toEqual({ code: 0, signal: null }); expect(owner.errors()).toBe(""); assertNoSecrets(owner.output(), f);
	await touchRootCtime(f.sourceProfileRoot);
	const { worker, planned } = await preparedRecovery(f, "published", true);
	const beforeRejectedRecovery = await snapshot(f);
	expect(await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: false })).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } });
	expect(await snapshot(f)).toEqual(beforeRejectedRecovery);
	const recovered = await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true });
	expect(recovered.ok).toBe(true); assertNoSecrets(recovered, f);
	expect(await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true })).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(await request(worker, "verify-profile", { recoveryId: recovered.recoveryId })).toMatchObject({ ok: true, recovery: { originalReadable: true, destinationReadable: true, activationPerformed: false } });
	const file = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try { expect(parseNativeProjectHandoffState((await file.read(f.handoffId)).value, f.handoffId)).toMatchObject({ state: "ready", pendingProjectIds: [project.id], projects: [{ id: project.id, pathHint: project.path, instructions: privateText }] }); } finally { file.close(); }
	const destinationDb = new KestrelDatabase(f.destination, f.destinationKey);
	try { expect(destinationDb.getRuntimeSession("generated-private-session")).toMatchObject({ projectId: project.id, workspaceRoot: project.path, privacyMode: "private" }); expect(destinationDb.listRuntimeMessages("generated-private-session")).toMatchObject([{ id: "generated-private-message", content: privateText }]); }
	finally { destinationDb.close(); }
	expect(await readFile(f.source)).toEqual(sourceBefore); expect(await readFile(join(f.sourceProfileRoot, "workspace-grants.json"))).toEqual(registryBefore);
});

it("recovers a real SIGKILL before publication with the prepared project manifest", async () => {
	const f = await fixture(), sourceBefore = await readFile(f.source), preload = join(f.root, "crash.mjs"); await writeCoreTransferCrashPreload(preload, f.destination, "before-link");
	const owner = launch(f.root, newEntry, preload), plan = await owner.request("plan-profile", { sourceProfileRoot: f.sourceProfileRoot, destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId, sourceKeyBase64: f.sourceKey.toString("base64") });
	assertTransferPlan(plan);
	expect(plan.ok).toBe(true);
	owner.send("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(await owner.exited).toEqual({ code: null, signal: "SIGKILL" }); expect(owner.errors()).toBe(""); assertNoSecrets(owner.output(), f);
	await touchRootCtime(f.sourceProfileRoot);
	const { worker, planned } = await preparedRecovery(f, "staged", true);
	const recovered = await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true });
	expect(recovered.ok).toBe(true); expect(await request(worker, "verify-profile", { recoveryId: recovered.recoveryId })).toMatchObject({ ok: true, recovery: { originalReadable: true, destinationReadable: true } });
	const target = new KestrelDatabase(f.destination, f.destinationKey);
	try {
		expect(target.getRuntimeSession("generated-private-session")).toMatchObject({ id: "generated-private-session", privacyMode: "private", projectId: project.id });
		expect(target.listRuntimeMessages("generated-private-session")).toMatchObject([{ id: "generated-private-message", content: privateText }]);
	} finally { target.close(); }
	expect(await readFile(f.source)).toEqual(sourceBefore); assertNoSecrets(recovered, f);
});

it("adds a missing manifest only after a fresh accepted recovery plan for the legacy worker", async () => {
	const f = await fixture(false), sourceBefore = await readFile(f.source), owner = launch(f.root, oldEntry);
	const plan = await owner.request("plan", { sourceDatabasePath: f.source, destinationDatabasePath: f.destination, sourceKeyBase64: f.sourceKey.toString("base64") });
	assertTransferPlan(plan);
	expect(plan.ok).toBe(true);
	const applied = await owner.request("apply", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(applied.ok).toBe(true); expect(await owner.stop()).toEqual({ code: 0, signal: null }); expect(owner.errors()).toBe("");
	expect(await readdir(f.destinationCoreRoot)).toEqual(["database"]);
	const worker = newWorker(), inspected = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId });
	assertInspection(inspected);
	expect(inspected.ok).toBe(true); expect(inspected.preview.state).toBe("published");
	const beforePlan = await snapshot(f);
	const notAccepted = await request(worker, "plan-profile-recovery", { reviewId: inspected.reviewId, acceptedRecoverySha256: "0".repeat(64), sourceKeyBase64: f.sourceKey.toString("base64"), destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(notAccepted).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } }); expect(await snapshot(f)).toEqual(beforePlan);
	const fresh = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId });
	assertInspection(fresh);
	const planned = await request(worker, "plan-profile-recovery", { reviewId: fresh.reviewId, acceptedRecoverySha256: fresh.preview.recoverySha256, sourceKeyBase64: f.sourceKey.toString("base64"), destinationKeyBase64: f.destinationKey.toString("base64") });
	assertRecoveryPlan(planned);
	expect(planned.ok).toBe(true); expect(planned.preview.projectHandoff).toMatchObject({ manifestPresent: false, projects: 0, pendingIdentities: 1 }); expect(await snapshot(f)).toEqual(beforePlan);
	const recovered = await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true });
	expect(recovered.ok).toBe(true); expect(await request(worker, "verify-profile", { recoveryId: recovered.recoveryId })).toMatchObject({ ok: true, recovery: { originalReadable: true, destinationReadable: true } });
	const file = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try { expect(parseNativeProjectHandoffState((await file.read(f.handoffId)).value, f.handoffId)).toMatchObject({ state: "ready", pendingProjectIds: [project.id], projects: [] }); } finally { file.close(); }
	expect(await readFile(f.source)).toEqual(sourceBefore);
});

it("refuses wrong recovery keys and handoff identity, then preserves a corrupted manifest", async () => {
	const f = await fixture(), sourceBefore = await readFile(f.source); await crashBeforeLink(f);
	const worker = newWorker(), initial = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId });
	assertInspection(initial);
	const baseline = await snapshot(f), otherHandoff = randomUUID();
	const otherIdentityReview = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: otherHandoff }); assertInspection(otherIdentityReview);
	const wrongId = await request(worker, "plan-profile-recovery", { reviewId: otherIdentityReview.reviewId, acceptedRecoverySha256: otherIdentityReview.preview.recoverySha256,
		sourceKeyBase64: f.sourceKey.toString("base64"), destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(wrongId.ok).toBe(false); expect(await snapshot(f)).toEqual(baseline);
	const wrongSource = randomBytes(32); keys.push(wrongSource);
	const sourceReview = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId }); assertInspection(sourceReview);
	const sourceDenied = await request(worker, "plan-profile-recovery", { reviewId: sourceReview.reviewId, acceptedRecoverySha256: sourceReview.preview.recoverySha256,
		sourceKeyBase64: wrongSource.toString("base64"), destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(sourceDenied.ok).toBe(false); expect(await snapshot(f)).toEqual(baseline);
	const wrongDestination = randomBytes(32); keys.push(wrongDestination);
	const destinationReview = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId }); assertInspection(destinationReview);
	const destinationDenied = await request(worker, "plan-profile-recovery", { reviewId: destinationReview.reviewId, acceptedRecoverySha256: destinationReview.preview.recoverySha256,
		sourceKeyBase64: f.sourceKey.toString("base64"), destinationKeyBase64: wrongDestination.toString("base64") });
	expect(destinationDenied.ok).toBe(false); expect(await snapshot(f)).toEqual(baseline);
	const { worker: preparedWorker, planned } = await preparedRecovery(f, "staged", true), manifest = join(f.destinationCoreRoot, "pending-project-handoff.json");
	const beforeCorrupt = await readFile(manifest), corrupted = Buffer.from(beforeCorrupt), corruptionIndex = corrupted.length - 2;
	corrupted[corruptionIndex] = corrupted[corruptionIndex]! ^ 1; await writeFile(manifest, corrupted, { mode: 0o600 });
	const corruptSnapshot = await snapshot(f);
	const denied = await request(preparedWorker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true });
	expect(denied).toMatchObject({ ok: false, error: { code: "PROJECT_HANDOFF_RECOVERY_REQUIRED" } });
	expect(await snapshot(f)).toEqual(corruptSnapshot); expect(await readFile(f.source)).toEqual(sourceBefore);
});

it("refuses a changed source registry after recovery planning without changing reviewed files", async () => {
	const f = await fixture(); await crashBeforeLink(f);
	const { worker, planned } = await preparedRecovery(f, "staged", true);
	const changed = [{ ...project, name: "Changed generated workspace name" }];
	await writeFile(join(f.sourceProfileRoot, "workspace-grants.json"), JSON.stringify(changed), { mode: 0o600 });
	const changedSnapshot = await snapshot(f);
	const denied = await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true });
	expect(denied).toMatchObject({ ok: false, error: { code: "PROJECT_HANDOFF_RECOVERY_REQUIRED" } });
	expect(await snapshot(f)).toEqual(changedSnapshot);
});

it("rejects stale and expired recovery acceptance without mutating the staged transfer", async () => {
	const f = await fixture(); await crashBeforeLink(f);
	let now = 10_000;
	const worker = newWorker(() => now), inspected = await request(worker, "inspect-profile", { destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId });
	assertInspection(inspected);
	const planned = await request(worker, "plan-profile-recovery", { reviewId: inspected.reviewId, acceptedRecoverySha256: inspected.preview.recoverySha256,
		sourceKeyBase64: f.sourceKey.toString("base64"), destinationKeyBase64: f.destinationKey.toString("base64") });
	assertRecoveryPlan(planned);
	const before = await snapshot(f);
	expect(await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: "0".repeat(64), approved: true })).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } });
	expect(await snapshot(f)).toEqual(before);
	now += 15 * 60_000; await worker.expire();
	expect(await request(worker, "recover-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true })).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(await snapshot(f)).toEqual(before);
});

it("retains the prepared manifest when journal creation fails before any database transfer metadata", async () => {
	const f = await fixture(), sourceBefore = await readFile(f.source), preload = join(f.root, "deny-journal.mjs");
	await writeJournalOpenFailurePreload(preload, f.destination);
	const owner = launch(f.root, newEntry, preload);
	const plan = await owner.request("plan-profile", { sourceProfileRoot: f.sourceProfileRoot, destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId, sourceKeyBase64: f.sourceKey.toString("base64") });
	assertTransferPlan(plan);
	const failed = await owner.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(failed).toMatchObject({ ok: false, error: { code: "PROJECT_HANDOFF_RECOVERY_REQUIRED", published: false } });
	expect(await owner.stop()).toEqual({ code: 0, signal: null }); expect(owner.errors()).toBe("");
	expect(await readdir(f.destinationCoreRoot)).toEqual(["database", "pending-project-handoff.json"]);
	expect(await readFile(f.source)).toEqual(sourceBefore);
	const file = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try { expect(parseNativeProjectHandoffState((await file.read(f.handoffId)).value, f.handoffId)).toMatchObject({ state: "prepared", pendingProjectIds: [project.id], projects: [{ id: project.id, instructions: privateText }] }); } finally { file.close(); }
});

it("allows a source-root ctime-only change between reviewed plan and apply", async () => {
	const f = await fixture(), sourceBefore = await readFile(f.source), registryBefore = await readFile(join(f.sourceProfileRoot, "workspace-grants.json")), worker = newWorker();
	const plan = await request(worker, "plan-profile", { sourceProfileRoot: f.sourceProfileRoot, destinationCoreRoot: f.destinationCoreRoot, handoffId: f.handoffId, sourceKeyBase64: f.sourceKey.toString("base64") });
	assertTransferPlan(plan);
	await touchRootCtime(f.sourceProfileRoot);
	const applied = await request(worker, "apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(applied.ok).toBe(true);
	expect(await request(worker, "verify-profile", { recoveryId: applied.recoveryId })).toMatchObject({ ok: true, recovery: { originalReadable: true, destinationReadable: true, activationPerformed: false } });
	const handoffFile = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try { expect(parseNativeProjectHandoffState((await handoffFile.read(f.handoffId)).value, f.handoffId)).toMatchObject({ state: "ready", pendingProjectIds: [project.id] }); } finally { handoffFile.close(); }
	expect(await readFile(f.source)).toEqual(sourceBefore); expect(await readFile(join(f.sourceProfileRoot, "workspace-grants.json"))).toEqual(registryBefore);
});
