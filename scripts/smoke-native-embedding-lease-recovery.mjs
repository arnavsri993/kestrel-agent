import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

// Disposable development candidate and generated data only. Never points at the
// installed app, real profile, Keychain, microphone, or external provider.
assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an exact disposable native candidate.");
assert(process.env.KESTREL_NATIVE_LEASE_EVIDENCE, "Select an empty evidence directory.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(app.endsWith(".app") && !app.startsWith("/Applications/"));
const executable = await realpath(join(app, "Contents/MacOS/Kestrel"));
const evidence = resolve(process.env.KESTREL_NATIVE_LEASE_EVIDENCE);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Evidence directory must be empty.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-lease-ui-")));
const profile = join(temporary, "browser"), coreRoot = join(profile, "native-core");
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
const key = await readFile(join(profile, ".kestrel-native-test-core-key-v1"));
const databasePath = join(coreRoot, "database/kestrel.sqlite");
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const C = await tsImport("../packages/shared-types/src/index.ts", import.meta.url);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), scope: "Generated private profile and key; actual native Memory UI and supervised Core. Offline fixture writes only. No real profile, Keychain, messages, microphone or remote provider.", phases: [] };
let running, browser, home, memory, endpoint, interrupted = false, stage = "seed";
const jobId = "generated-lease-blocker", memoryId = "generated-lease-owner";
const stamp = new Date().toISOString();
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
function processTable() {
 return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").map(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
 }).filter(Boolean);
}
function assertCandidateStopped() {
 assert(!processTable().some(row => row.command.includes(executable)), "Candidate already running; use a separate stopped candidate.");
}
function descendants(root) {
 const rows = processTable(), owned = new Set([root]);
 for (let changed = true; changed;) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
 return rows.filter(row => owned.has(row.pid));
}
function corePids() { return descendants(running.child.pid).filter(row => row.command.includes("agent-core/service/index.js")).map(row => row.pid); }
async function eventually(fn, message, timeout = 30000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { if (interrupted) throw Error("Interrupted."); if (await fn()) return; await delay(100); }
 throw Error(message);
}
async function corePid() { let ids; await eventually(() => { ids = corePids(); return ids.length === 1; }, "Expected one supervised Core process."); return ids[0]; }
async function changedCore(previous) {
 let current; await eventually(() => { current = corePids(); return current.length === 1 && current[0] !== previous && !processTable().some(row => row.pid === previous); }, "Core did not stop and restart cleanly.");
 return current[0];
}
function offline(operation) {
 assert(!running, "Fixture access requires the entire owned app to be stopped.");
 const db = new KestrelDatabase(databasePath, key);
 try { return operation(db); } finally { db.close(); }
}
// Read from the database's bounded private copy, never opening live source WAL
// through SQLite. This check never mutates the running Core's database.
function snapshotJob() {
 const db = KestrelDatabase.openForHostLegacyEmbeddingRecovery(databasePath, key, { readonly: true });
 try { return db.getMemoryJob(jobId); } finally { db.close(); }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; running?.child.kill("SIGTERM"); });
async function start() {
 assertCandidateStopped();
 const state = { output: "" };
 state.child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], { stdio: ["ignore", "pipe", "pipe"] });
 state.exited = new Promise(done => state.child.once("exit", (code, signal) => done({ code, signal })));
 for (const stream of [state.child.stdout, state.child.stderr]) stream.on("data", bytes => { if (state.output.length < 200000) state.output += bytes; });
 running = state; endpoint = undefined;
 await eventually(() => { assert.equal(state.child.exitCode, null, "Candidate exited."); endpoint = state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1]; return endpoint; }, "Native endpoint missing.");
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 await eventually(async () => {
  home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
  if (home) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send("Target.getTargets"); await session.detach();
  if (targets.targetInfos.some(target => /chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
  return false;
 }, "Native Home missing.");
 await home.waitForFunction(() => typeof window.kestrel?.request === "function");
 await home.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 await home.reload(); await home.locator(".kestrel-sidebar").waitFor(); await corePid();
}
async function stop() {
 if (!running) return;
 const current = running; const children = descendants(current.child.pid).map(row => row.pid);
 if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGTERM");
 const result = await Promise.race([current.exited, delay(15000).then(() => { current.child.kill("SIGKILL"); throw Error("Native shutdown timed out."); })]);
 assert.deepEqual(result, { code: 0, signal: null });
 await browser?.close().catch(() => {}); browser = undefined;
 await eventually(() => !processTable().some(row => children.includes(row.pid)), "Owned processes remain after app shutdown.");
 running = undefined;
}
async function rawRequest(input) { return home.evaluate(value => window.kestrel.request(value), input); }
async function request(input) { const result = await rawRequest(input); assert.equal(result.ok, true, result.error); return result; }
async function reviewWhenIdle() {
 let result;
 await eventually(async () => {
  result = await rawRequest({ type: "native-embedding-recovery-review" });
  if (result.ok) return true;
  assert(["Core is busy. Try again when its current operation is complete.", "Finish or cancel active work before reviewing memory processing."].includes(result.error), result.error);
  return false;
 }, "The generated profile never became idle for review.");
 return result;
}
async function openMemory() {
 await request({ type: "browser-create-tab", input: "kestrel://memory" });
 await eventually(async () => {
  memory = browser.contexts().flatMap(context => context.pages()).find(page => /index\.html\?app=memory(?:&|$)/.test(page.url()));
  if (memory) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send("Target.getTargets"); await session.detach();
  if (targets.targetInfos.some(target => /index\.html\?app=memory(?:&|$)/.test(target.url))) {
   await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
   home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
  }
  return false;
 }, "Memory page missing.");
 await memory.getByRole("navigation", { name: "Memory views" }).getByRole("button", { name: "Memory", exact: true }).click();
 await memory.locator("summary").filter({ hasText: /^Repair memory processing$/ }).click();
}
try {
 assertCandidateStopped(); await mkdir(join(coreRoot, "database"), { recursive: true, mode: 0o700 });
 offline(db => {
  const sessionId = "generated-lease-source-session", eventId = "generated-lease-source-event";
  db.saveRuntimeSession(C.RuntimeSessionSchema.parse({ id: sessionId, title: "Generated repair source", privacyMode: "standard", allowedTools: [], status: "active", checkpoints: [], createdAt: stamp, updatedAt: stamp }));
  db.upsertTimelineEvent(C.TimelineEventSchema.parse({ id: eventId, source: "fixture", sourceSessionId: sessionId, startedAt: stamp, eventType: "note", actor: "user", textSummary: "Generated repair source event", structuredData: {}, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "queued", importance: 0.5, confidence: 1, status: "active", projectIds: [], personIds: [], entityIds: [], createdAt: stamp, updatedAt: stamp }));
  db.upsertMemory(C.MemoryRecordSchema.parse({ id: memoryId, type: "semantic", content: "Generated permitted recovery fixture", sourceIds: [eventId], sourceType: "fixture", structuredData: {}, confidence: 1, importance: 0.75, sensitivity: "personal", status: "active", entityIds: [], userConfirmed: true, inferred: false, createdAt: stamp, updatedAt: stamp }));
  db.queueMemoryJob(C.MemoryJobSchema.parse({ id: jobId, kind: "embed", dedupeKey: "generated-legacy-dedupe", status: "running", payload: { ownerType: "memory", ownerId: memoryId }, attempts: 2, maxAttempts: 3, runAfter: stamp, lockedAt: stamp, createdAt: stamp, updatedAt: stamp }));
  const blocked = db.migrateLegacyMemoryEmbeddingIdentifiers(stamp); assert.equal(blocked.blocked, true); assert.equal(db.getMemoryJob(jobId).status, "running");
 });
 phase("offline-generated-generationless-missing-lease-blocks-migration");
 stage = "startup"; await start(); await request({ type: "memory-run-maintenance" });
 const initial = snapshotJob(); assert.equal(initial.status, "running"); assert.equal(initial.leaseUntil, undefined); assert.equal(initial.payload.generation, undefined);
 phase("actual-core-maintenance-leaves-legacy-blocker-running");
 stage = "stale-review";
 let previous = await corePid();
 const review = await reviewWhenIdle();
 assert.equal(review.nativeEmbeddingRecoveryPreview?.state, "review"); assert.equal(review.nativeEmbeddingRecoveryPreview.cancelledJobs, 1); assert.equal(review.nativeEmbeddingRecoveryPreview.coreStatus, "ready");
 await changedCore(previous); assert.deepEqual(snapshotJob(), initial);
 await request({ type: "memory-correct", id: memoryId, content: "Generated source correction invalidates review" });
 const stale = await rawRequest({ type: "native-embedding-recovery-apply", planId: review.nativeEmbeddingRecoveryPreview.planId }); assert.equal(stale.ok, false);
 assert.equal((await rawRequest({ type: "native-embedding-recovery-apply", planId: review.nativeEmbeddingRecoveryPreview.planId })).ok, false);
 assert.equal(snapshotJob().status, "running");
 phase("review-stops-and-restarts-core-without-mutation-source-change-stales-and-consumes-plan");
 stage = "restart-invalidation";
 const old = await reviewWhenIdle(); assert.equal(old.nativeEmbeddingRecoveryPreview.state, "review");
 await stop();
 // The deliberate product correction above may queue a fresh-generation job.
 // Remove only this generated fixture's new jobs while every owned process is
 // stopped, so the subsequent scenario starts with just the stranded job.
 offline(db => {
  for (const job of db.listMemoryJobs({ kind: "embed", limit: 500 })) {
   if (job.id !== jobId && job.payload.ownerType === "memory" && job.payload.ownerId === memoryId)
    db.db.prepare("DELETE FROM memory_jobs WHERE id=?").run(job.id);
  }
 });
 await start(); assert.equal((await rawRequest({ type: "native-embedding-recovery-apply", planId: old.nativeEmbeddingRecoveryPreview.planId })).ok, false);
 assert.equal(snapshotJob().status, "running"); phase("restart-invalidates-one-use-review");
 stage = "ui-repair"; await openMemory(); previous = await corePid();
 await memory.getByRole("button", { name: "Review", exact: true }).click();
 await memory.getByRole("region", { name: "Memory processing repair review" }).waitFor();
 await changedCore(previous); assert.equal(snapshotJob().status, "running");
 await memory.screenshot({ path: join(evidence, "repair-review.png") }); previous = await corePid();
 await memory.getByRole("button", { name: "Cancel old indexing task", exact: true }).click();
 await memory.getByRole("status").filter({ hasText: "The old indexing task was cancelled." }).waitFor();
 await changedCore(previous); await memory.screenshot({ path: join(evidence, "repair-applied.png") });
 phase("actual-memory-ui-review-and-cancellation-each-restart-supervised-core");
 const status = await request({ type: "native-embedding-recovery-status" });
 assert.deepEqual(status.nativeEmbeddingRecoveryStatus, { state: "applied", cancelledJobs: 1, coreStatus: "ready" });
 await memory.reload();
 await memory.getByRole("navigation", { name: "Memory views" }).getByRole("button", { name: "Memory", exact: true }).click();
 await memory.locator("summary").filter({ hasText: /^Repair memory processing$/ }).click();
 await memory.getByRole("status").filter({ hasText: "The old indexing task was cancelled." }).waitFor();
 phase("committed-repair-status-survives-renderer-reload");
 stage = "migration";
 for (let i = 0; i < 16; i++) await request({ type: "memory-run-maintenance" });
 await stop();
 offline(db => {
  const jobs = db.listMemoryJobs({ kind: "embed", limit: 500 }).filter(job => job.payload.ownerId === memoryId);
  assert(!jobs.some(job => ["pending", "running"].includes(job.status)), "Recovered generation must not be runnable.");
  assert(jobs.some(job => job.status === "cancelled" && job.attempts === 2 && job.maxAttempts === 3 && job.payload.generation), "Expected preserved cancelled generation guard.");
  assert.equal(db.listMemoryEmbeddings({ ownerType: "memory", ownerId: memoryId }).length, 0, "Recovered generation must not insert a vector.");
 });
 phase("normal-migration-preserves-cancelled-guard-attempts-and-no-vector");
 stage = "normal-work"; await start();
 await request({ type: "memory-correct", id: memoryId, content: "Generated new work after repair" });
 for (let i = 0; i < 16; i++) await request({ type: "memory-run-maintenance" });
 await stop();
 offline(db => {
  const input = db.getMemoryEmbeddingInput("memory", memoryId); assert(input);
  const job = db.getMemoryJobByDedupeKey(`embed:memory:${memoryId}:${input.generation}`);
  assert(job && job.status === "completed", "New generation should complete after repair.");
  assert(db.listMemoryEmbeddings({ ownerType: "memory", ownerId: memoryId }).some(vector => vector.generation === input.generation && vector.status === "ready"));
 });
 phase("new-explicit-memory-work-completes-after-repair");
 receipt.result = "passed";
} catch (error) {
 if (memory && !memory.isClosed()) await memory.screenshot({ path: join(evidence, "failed-memory.png") }).catch(() => {});
 receipt.result = "failed"; receipt.failedStage = stage; receipt.error = String(error?.message || error).replaceAll(key.toString("base64"), "[generated-key]").slice(0, 1000); console.error(`Native lease recovery failed at ${stage}: ${receipt.error}`); process.exitCode = 1;
}
finally {
 await stop().catch(error => { receipt.result = "failed"; receipt.shutdownError = error.message; process.exitCode = 1; });
 receipt.candidateSha256After = await candidateDigest(app);
 if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString(); key.fill(0);
 if (!running) await rm(temporary, { recursive: true, force: true });
 await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
