import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import { createRequire } from "node:module";
import { createHash, createHmac, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an exact disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"));
const evidence = resolve(process.env.KESTREL_NATIVE_AUTHORITY_EVIDENCE || `.tmp/native-authority-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory.");
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-authority-")));
const key = randomBytes(32), databasePath = join(root, "core.sqlite");
const resources = join(candidate, "Contents/Resources/agent-core");
const { CoreSupervisor, nodeCoreProcess } = await import(pathToFileURL(join(resources, "service/native-desktop-runtime.mjs")).href);
const owned = new Set();
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate,
  candidateSha256: await candidateDigest(candidate),
  scope: "Generated fixtures and one valid pending memory job are seeded/edited with source database APIs only while Core is stopped. Actual bundled Node/Core performs protected IPC query, tool, workspace, embedding and restart phases. Offline inspection only after confirmed exit. Protected-host memory-tool approval is simulated for this generated fixture after verifying the unapproved route is blocked. No real profile, credential, Keychain, microphone, desktop input or remote provider.", phases: [] };
let stage = "start", supervisor;
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
async function bounded(promise, milliseconds = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Generated Core check timed out.")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const configuration = { databasePath, encryptionKeyBase64: key.toString("base64"), workspaceRoots: [], configuredWorkspaceRoots: [],
  pluginRoots: [], managedPluginRoots: [], learnedSkillRoot: join(root, "skills"), secureEnvironment: {}, providerAccounts: [] };
async function start() { await bounded(supervisor.start(configuration)); }
async function stop() { await bounded(supervisor.stop()); assert.equal(owned.size, 0); }
async function request(input) { const response = await bounded(supervisor.request(input)); assert.equal(response.ok, true); return response; }
async function maintain() { for (let i = 0; i < 12; i++) await request({ type: "memory-run-maintenance" }); }
function decrypt(row, prefix = "payload") {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row[`${prefix}_iv`], "base64"));
  decipher.setAuthTag(Buffer.from(row[`${prefix}_auth_tag`], "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row[`${prefix}_ciphertext`], "base64")), decipher.final()]).toString("utf8"));
}
function inspect(ownerId, text) {
  assert.equal(owned.size, 0, "Never inspect a live generated Core database.");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const secretRow = db.prepare("SELECT * FROM private_runtime_state WHERE key=?").get("kestrel.embedding-generation.v1.secret");
    const secret = decrypt(secretRow, "value");
    const macKey = Buffer.from(secret.key, "hex");
    try {
      const mac = (domain, value) => createHmac("sha256", macKey).update(domain).update("\0").update(value).digest("hex");
      const ownerKey = `kestrel.embedding-generation.v1.owner.memory.${mac("owner", `memory\0${ownerId}`)}`;
      const state = decrypt(db.prepare("SELECT * FROM private_runtime_state WHERE key=?").get(ownerKey), "value");
      const contentHash = mac("content", text);
      assert.match(state.generation, /^[a-f0-9-]{36}$/);
      const jobs = db.prepare("SELECT * FROM memory_jobs WHERE kind='embed'").all().map(row => {
        const job = decrypt(row);
        for (const [field, column] of Object.entries({ id: "id", kind: "kind", status: "status", dedupeKey: "dedupe_key", attempts: "attempts" }))
          assert.equal(job[field], row[column]);
        return job;
      }).filter(job => job.payload.ownerType === "memory" && job.payload.ownerId === ownerId);
      const embeddingRows = db.prepare("SELECT * FROM memory_embeddings WHERE owner_type='memory' AND owner_id=?").all(ownerId);
      const embeddings = embeddingRows.map(row => { const value = decrypt(row); assert.equal(value.contentHash, row.content_hash); return value; });
      assert(!jobs.some(job => job.dedupeKey.includes(createHash("sha256").update(text).digest("hex").slice(0, 16))));
      assert.notEqual(contentHash, createHash("sha256").update(text).digest("hex"));
      const currentJob = jobs.find(job => job.payload.generation === state.generation && job.status === "completed");
      assert(currentJob, "A current desired generation must have completed real packaged work.");
      assert.equal(currentJob.dedupeKey, `embed:memory:${ownerId}:${state.generation}`);
      assert(embeddings.some(value => value.generation === state.generation && value.contentHash === contentHash && value.status === "ready"));
      return { generation: state.generation, contentHash, jobId: currentJob.id, jobCount: jobs.length };
    } finally { macKey.fill(0); }
  } finally { db.close(); }
}

try {
  supervisor = new CoreSupervisor(undefined, undefined, { restartDelaysMs: [], startupTimeoutMs: 15000,
    processFactory: () => {
      const child = nodeCoreProcess({ executable: join(resources, "node/bin/node"), entryPath: join(resources, "service/index.js"),
        env: { HOME: root, KESTREL_DATA_DIR: root, PATH: "/usr/bin:/bin" }, stdout: "ignore" });
      owned.add(child); child.once("exit", () => owned.delete(child)); return child;
    } });
  const { KestrelDatabase } = await tsImport(fileURLToPath(new URL("../packages/database/src/index.ts", import.meta.url)), import.meta.url);
  const C = await tsImport(fileURLToPath(new URL("../packages/shared-types/src/index.ts", import.meta.url)), import.meta.url);
  const timestamp = new Date().toISOString();
  const sourceId = "generated-authority-source", sourceSessionId = "generated-source-session", ownerId = "generated-authority-memory";
  const text = "Generated native-authority-sentinel sensitive detail";
  const fixtureSession = C.RuntimeSessionSchema.parse({ id: sourceSessionId, title: "Generated source owner", privacyMode: "standard",
    allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
  function edit(operation) {
    assert.equal(owned.size, 0, "Only seed/edit a confirmed stopped generated profile.");
    const database = new KestrelDatabase(databasePath, key); try { operation(database); } finally { database.close(); }
  }
  edit(database => {
    database.saveRuntimeSession(fixtureSession);
    database.upsertTimelineEvent(C.TimelineEventSchema.parse({ id: sourceId, source: "fixture", sourceSessionId, startedAt: timestamp,
      eventType: "note", actor: "user", textSummary: text, structuredData: {}, sensitivity: "personal", retentionPolicy: "durable",
      embeddingStatus: "queued", importance: 0.5, confidence: 1, status: "active", projectIds: [], personIds: [], entityIds: [], createdAt: timestamp, updatedAt: timestamp }));
    database.upsertMemory(C.MemoryRecordSchema.parse({ id: ownerId, type: "semantic", content: text, sourceIds: [sourceId], sourceType: "fixture",
      structuredData: {}, confidence: 1, importance: 0.75, sensitivity: "personal", status: "active", entityIds: [], userConfirmed: true,
      inferred: false, createdAt: timestamp, updatedAt: timestamp }));
    const generation = database.getMemoryEmbeddingInput("memory", ownerId).generation;
    database.queueMemoryJob(C.MemoryJobSchema.parse({ id: "generated-seeded-memory-job", kind: "embed",
      dedupeKey: `embed:memory:${ownerId}:${generation}`, status: "pending", payload: { ownerType: "memory", ownerId, generation },
      attempts: 0, maxAttempts: 4, runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp }));
    database.upsertWorkingTask(C.WorkingTaskSchema.parse({ id: "generated-authority-task", goal: text, sourceIds: [`memory:${ownerId}`],
      status: "planned", plan: [], evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], dependencyTaskIds: [],
      projectIds: [], personIds: [], entityIds: [], startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp }));
  });
  await start(); await request({ type: "snapshot" });
  const sessions = await request({ type: "runtime-list-sessions" });
  const main = sessions.sessions.find(value => value.title === "Main session"); assert(main);
  async function listedByTool() {
    const blocked = await request({ type: "runtime-call-tool", sessionId: main.id, toolName: "memory.list", input: {} });
    assert.equal(blocked.execution?.status, "blocked", "Unapproved sensitive memory tools must stay blocked.");
    const response = await request({ type: "runtime-call-tool", sessionId: main.id, toolName: "memory.list", input: {}, approvalStatus: "approved" });
    assert.equal(response.execution?.status, "verified", response.execution?.error ?? "Memory list must execute through the real Core tool route.");
    return response.execution.output;
  }
  const permitted = await request({ type: "memory-timeline-query", query: "native-authority-sentinel" });
  assert(JSON.stringify(permitted.memoryTimeline).includes(text));
  assert(JSON.stringify(await listedByTool()).includes(text));
  await maintain(); await stop();
  const first = inspect(ownerId, text);
  phase("seeded-generated-source-is-readable-and-embedded-by-real-bundled-Core");
  stage = "same-clock-source-revoke-and-regrant";
  edit(database => { database.saveRuntimeSession({ ...fixtureSession, privacyMode: "private" }); database.saveRuntimeSession(fixtureSession); });
  await start();
  await request({ type: "memory-timeline-query", query: "native-authority-sentinel" });
  await maintain(); await stop();
  const regranted = inspect(ownerId, text);
  assert.notEqual(regranted.generation, first.generation); assert.notEqual(regranted.jobId, first.jobId);
  assert.equal(regranted.contentHash, first.contentHash);
  phase("source-revoke-and-regrant-without-descendant-read-replaces-completed-cache");
  stage = "private-source-export-boundary";
  edit(database => database.saveRuntimeSession({ ...fixtureSession, privacyMode: "private" }));
  await start();
  const denied = await request({ type: "memory-timeline-query", query: "native-authority-sentinel", includeSensitive: true, includeRestricted: true });
  assert(!JSON.stringify(denied.memoryTimeline).includes(text), "A local semantic fallback must not disclose restricted descendants.");
  assert(!JSON.stringify(await listedByTool()).includes(text), "Model memory.list must honor source authority.");
  const workspace = await request({ type: "memory-workspace-read", query: { viewerId: "user" } });
  assert(!JSON.stringify(workspace.memoryWorkspace).includes(text), "Legacy workspace projection must honor source authority.");
  const retained = await request({ type: "memory-list" });
  assert(retained.memories.some(value => value.id === ownerId && value.content === text), "Source restriction must preserve the user's encrypted record.");
  await stop();
  phase("private-source-denied-in-query-tool-and-workspace-with-original-record-retained");
  stage = "local-history-with-paused-capture";
  edit(database => { database.saveRuntimeSession(fixtureSession); database.setPrivateState("memory.capture.configuration", {
    version: 1, enabled: false, defaultRetentionDays: 90, policies: [], updatedAt: timestamp }); });
  await start();
  const paused = await request({ type: "memory-timeline-query", query: "native-authority-sentinel" });
  assert(JSON.stringify(paused.memoryTimeline).includes(text), "Pausing capture must preserve permitted local history.");
  assert(JSON.stringify(await listedByTool()).includes(text));
  await stop();
  phase("capture-pause-retains-permitted-local-history-without-provider-work");

  receipt.result = "passed";
} catch (error) {
  receipt.result = "failed"; receipt.failedStage = stage;
  receipt.error = String(error?.message || error).replaceAll(key.toString("base64"), "[generated-key]").slice(0, 1000);
  console.error(`Native memory authority canary failed at ${stage}: ${receipt.error}`);
  process.exitCode = 1;
} finally {
  await bounded(supervisor?.stop() ?? Promise.resolve()).catch(() => { receipt.shutdownFailed = true; receipt.result = "failed"; process.exitCode = 1; });
  for (const child of owned) child.kill();
  receipt.ownedProcessesRemaining = owned.size;
  if (owned.size) { receipt.result = "failed"; process.exitCode = 1; }
  receipt.candidateSha256After = await candidateDigest(candidate);
  if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  key.fill(0);
  if (!owned.size) await rm(root, { recursive: true, force: true });
}
