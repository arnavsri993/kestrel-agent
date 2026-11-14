import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import { createRequire } from "node:module";
import { createHash, createHmac, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an exact disposable native candidate.");
assert(process.env.KESTREL_NATIVE_LEGACY_EVIDENCE, "Select a fresh evidence directory.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"));
const evidence = resolve(process.env.KESTREL_NATIVE_LEGACY_EVIDENCE);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory.");
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-legacy-")));
const key = randomBytes(32), databasePath = join(root, "core.sqlite");
const resources = join(candidate, "Contents/Resources/agent-core");
const { CoreSupervisor, nodeCoreProcess } = await import(pathToFileURL(join(resources, "service/native-desktop-runtime.mjs")).href);
const { KestrelDatabase } = await tsImport(fileURLToPath(new URL("../packages/database/src/index.ts", import.meta.url)), import.meta.url);
const C = await tsImport(fileURLToPath(new URL("../packages/shared-types/src/index.ts", import.meta.url)), import.meta.url);
const owned = new Set();
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate, candidateSha256: await candidateDigest(candidate),
 scope: "Generated isolated database and key only. Source APIs seed and edit fixtures while bundled Core is stopped; actual candidate Node/Core performs protected IPC migration, maintenance, correction and restart. No real profile, Keychain, microphone, desktop input or remote provider. Reviewed-file-transfer plan rejection is covered by database unit tests, not this probe.", phases: [] };
let supervisor, stage = "initialize";
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
async function bounded(promise, milliseconds = 20000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Generated Core check timed out.")), milliseconds); })]); } finally { clearTimeout(timer); } }
const config = { databasePath, encryptionKeyBase64: key.toString("base64"), workspaceRoots: [], configuredWorkspaceRoots: [], pluginRoots: [], managedPluginRoots: [], learnedSkillRoot: join(root, "skills"), secureEnvironment: {}, providerAccounts: [] };
async function start() { await bounded(supervisor.start(config)); }
async function stop() { await bounded(supervisor.stop()); assert.equal(owned.size, 0, "Owned Core must be stopped before offline access."); }
async function request(input) { const response = await bounded(supervisor.request(input)); assert.equal(response.ok, true, "Core request must succeed."); return response; }
async function maintain(count) { for (let i = 0; i < count; i++) await request({ type: "memory-run-maintenance" }); }
function edit(operation) { assert.equal(owned.size, 0); const db = new KestrelDatabase(databasePath, key); try { return operation(db); } finally { db.close(); } }
function decrypt(row, prefix = "payload") { assert(row); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row[`${prefix}_iv`], "base64")); decipher.setAuthTag(Buffer.from(row[`${prefix}_auth_tag`], "base64")); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row[`${prefix}_ciphertext`], "base64")), decipher.final()]).toString("utf8")); }
const texts = { pending: "Generated legacy pending alpha sentinel", failed: "Generated legacy terminal failed sentinel", cancelled: "Generated legacy terminal cancelled sentinel" };
const ids = { pending: "generated-legacy-pending", failed: "generated-legacy-failed", cancelled: "generated-legacy-cancelled" };
const corrected = "Generated legacy terminal corrected sentinel";
const sha = value => createHash("sha256").update(value).digest("hex");
const oldHashes = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha(text)]));
const oldIds = Object.fromEntries(Object.keys(ids).map(name => [name, `memory-job-${sha(`embed:memory:${ids[name]}:${oldHashes[name].slice(0, 16)}`).slice(0, 40)}`]));
function inspect() {
 assert.equal(owned.size, 0);
 const db = new Database(databasePath, { readonly: true, fileMustExist: true });
 try {
  const secret = decrypt(db.prepare("SELECT * FROM private_runtime_state WHERE key=?").get("kestrel.embedding-generation.v1.secret"), "value");
  const macKey = Buffer.from(secret.key, "hex");
  try {
   const mac = (domain, value) => createHmac("sha256", macKey).update(domain).update("\0").update(value).digest("hex");
   const jobs = db.prepare("SELECT * FROM memory_jobs WHERE kind='embed'").all().map(row => {
    const value = decrypt(row);
    for (const [field, column] of Object.entries({ id: "id", kind: "kind", status: "status", dedupeKey: "dedupe_key", attempts: "attempts", maxAttempts: "max_attempts", runAfter: "run_after", createdAt: "created_at", updatedAt: "updated_at" })) assert.equal(value[field], row[column]);
    assert(!Object.values(oldIds).includes(row.id));
    for (const hash of Object.values(oldHashes)) { assert(!row.id.includes(hash.slice(0, 16))); assert(!row.dedupe_key.includes(hash.slice(0, 16))); }
    return value;
   });
   const vectors = db.prepare("SELECT * FROM memory_embeddings").all().map(row => {
    const value = decrypt(row);
    for (const [field, column] of Object.entries({ id: "id", ownerType: "owner_type", ownerId: "owner_id", provider: "provider", model: "model", dimension: "dimension", contentHash: "content_hash", status: "status", createdAt: "created_at", updatedAt: "updated_at" })) assert.equal(value[field], row[column]);
    assert(!Object.values(oldHashes).includes(row.content_hash)); return value;
   });
   const current = {};
   for (const [name, ownerId] of Object.entries(ids)) {
    const stateKey = `kestrel.embedding-generation.v1.owner.memory.${mac("owner", `memory\0${ownerId}`)}`;
    const row = db.prepare("SELECT * FROM private_runtime_state WHERE key=?").get(stateKey);
    const state = row && decrypt(row, "value");
    current[name] = { generation: state?.generation, jobs: jobs.filter(job => job.payload.ownerType === "memory" && job.payload.ownerId === ownerId), vectors: vectors.filter(vector => vector.ownerType === "memory" && vector.ownerId === ownerId), contentHash: mac("content", name === "failed" && stage === "correct-and-restart" ? corrected : texts[name]) };
   }
   return current;
  } finally { macKey.fill(0); }
 } finally { db.close(); }
}
function ready(value) { return value.vectors.some(vector => vector.generation === value.generation && vector.contentHash === value.contentHash && vector.status === "ready"); }
try {
 supervisor = new CoreSupervisor(undefined, undefined, { restartDelaysMs: [], startupTimeoutMs: 15000, processFactory: () => {
  const child = nodeCoreProcess({ executable: join(resources, "node/bin/node"), entryPath: join(resources, "service/index.js"), env: { HOME: root, KESTREL_DATA_DIR: root, PATH: "/usr/bin:/bin" }, stdout: "ignore" });
  owned.add(child); child.once("exit", () => owned.delete(child)); return child;
 } });
 const timestamp = new Date().toISOString(), sessionId = "generated-legacy-source-session", eventId = "generated-legacy-source-event";
 const session = C.RuntimeSessionSchema.parse({ id: sessionId, title: "Generated legacy source", privacyMode: "standard", allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
 edit(db => {
  db.saveRuntimeSession(session);
  db.upsertTimelineEvent(C.TimelineEventSchema.parse({ id: eventId, source: "fixture", sourceSessionId: sessionId, startedAt: timestamp, eventType: "note", actor: "user", textSummary: "Generated legacy source event", structuredData: {}, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "queued", importance: 0.5, confidence: 1, status: "active", projectIds: [], personIds: [], entityIds: [], createdAt: timestamp, updatedAt: timestamp }));
  for (const name of Object.keys(ids)) {
   db.upsertMemory(C.MemoryRecordSchema.parse({ id: ids[name], type: "semantic", content: texts[name], sourceIds: name === "pending" ? [] : [eventId], sourceType: "fixture", structuredData: {}, confidence: 1, importance: 0.75, sensitivity: "personal", status: "active", entityIds: [], userConfirmed: true, inferred: false, createdAt: timestamp, updatedAt: timestamp }));
   const dedupeKey = `embed:memory:${ids[name]}:${oldHashes[name].slice(0, 16)}`;
   db.queueMemoryJob(C.MemoryJobSchema.parse({ id: oldIds[name], kind: "embed", dedupeKey, status: name === "pending" ? "pending" : name, payload: { ownerType: "memory", ownerId: ids[name] }, attempts: name === "failed" ? 3 : 0, maxAttempts: 3, runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp }));
  }
  db.upsertMemoryEmbedding({ id: "generated-legacy-vector", ownerType: "memory", ownerId: ids.pending, provider: "legacy", model: "legacy", dimension: 1, contentHash: oldHashes.pending, vector: [1], status: "ready", createdAt: timestamp, updatedAt: timestamp });
  db.saveRuntimeSession({ ...session, privacyMode: "private" });
 });
 const before = edit(db => db.exportHostProfileTransferSnapshot());
 const reopened = edit(db => db.exportHostProfileTransferSnapshot());
 assert.equal(before.semanticSha256, reopened.semanticSha256); assert.deepEqual(before.counts, reopened.counts);
 phase("constructor-and-read-only-export-preserve-generated-legacy-snapshot");
 stage = "initial-activation";
 await start(); await maintain(12); await stop();
 const first = inspect();
 const legacyVector = first.pending.vectors.find(value => value.id === "generated-legacy-vector");
 assert(legacyVector); assert.equal(legacyVector.generation, undefined); assert.notEqual(legacyVector.contentHash, oldHashes.pending);
 assert(first.pending.jobs.some(job => job.payload.generation === first.pending.generation && job.status === "completed")); assert(ready(first.pending));
 assert.equal(first.failed.vectors.length, 0); assert.equal(first.cancelled.vectors.length, 0);
 phase("bundled-core-neutralizes-legacy-identifiers-and-embeds-only-permitted-owner");
 stage = "regrant-terminal-sources";
 edit(db => db.saveRuntimeSession(session));
 await start(); await maintain(24); await stop();
 const second = inspect(), guards = {};
 for (const name of ["failed", "cancelled"]) {
  guards[name] = second[name].jobs.find(job => job.payload.generation === second[name].generation);
  assert(guards[name]); assert.equal(guards[name].status, name); assert.equal(guards[name].attempts, name === "failed" ? 3 : 0); assert.equal(guards[name].maxAttempts, 3);
  assert.equal(second[name].vectors.length, 0);
 }
 phase("regrant-preserves-exhausted-and-cancelled-generation-guards");
 stage = "correct-and-restart";
 await start(); await request({ type: "memory-correct", id: ids.failed, content: corrected }); await maintain(12); await stop();
 const third = inspect(); assert.notEqual(third.failed.generation, guards.failed.payload.generation); assert(ready(third.failed));
 const oldGuard = third.failed.jobs.find(job => job.id === guards.failed.id); assert(oldGuard); assert.equal(oldGuard.status, "failed"); assert.equal(oldGuard.attempts, 3);
 await start(); const listed = await request({ type: "memory-list" }); assert(listed.memories.some(memory => memory.id === ids.failed && memory.content === corrected)); await stop();
 phase("explicit-correction-embeds-new-generation-and-survives-restart");
 receipt.result = "passed";
} catch (error) {
 receipt.result = "failed"; receipt.failedStage = stage;
 receipt.error = String(error?.message || error).replaceAll(key.toString("base64"), "[generated-key]").replaceAll(key.toString("hex"), "[generated-key]").slice(0, 1000);
 console.error(`Native legacy probe failed at ${stage}: ${receipt.error}`); process.exitCode = 1;
} finally {
 await bounded(supervisor?.stop() ?? Promise.resolve()).catch(() => { receipt.shutdownFailed = true; receipt.result = "failed"; process.exitCode = 1; });
 for (const child of owned) child.kill(); receipt.ownedProcessesRemaining = owned.size;
 if (owned.size) { receipt.result = "failed"; process.exitCode = 1; }
 receipt.candidateSha256After = await candidateDigest(candidate);
 if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
 key.fill(0); if (!owned.size) await rm(root, { recursive: true, force: true });
}
