import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, createHmac, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an exact disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"));
const evidence = resolve(process.env.KESTREL_NATIVE_GENERATION_EVIDENCE || `.tmp/native-generations-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory.");
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-generations-")));
const key = randomBytes(32), databasePath = join(root, "core.sqlite");
const resources = join(candidate, "Contents/Resources/agent-core");
const { CoreSupervisor, nodeCoreProcess } = await import(pathToFileURL(join(resources, "service/native-desktop-runtime.mjs")).href);
const owned = new Set();
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate,
  candidateSha256: await candidateDigest(candidate),
  scope: "Real bundled Node and standalone Core over protected IPC with a generated encrypted profile/key. Offline SQLite inspection only after confirmed Core exit. No remote provider, real profile, credential, Keychain, microphone or desktop capture/input.", phases: [] };
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
async function maintain() { for (let i = 0; i < 3; i++) await request({ type: "memory-run-maintenance" }); }
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
  await start(); await request({ type: "snapshot" }); phase("bundled-node-and-real-protected-Core-ready");
  stage = "original-generation";
  const text = "Generated alpha release preference";
  const response = await request({ type: "memory-remember", memoryType: "semantic", content: text, sensitivity: "personal", sourceId: "generated-generation-probe" });
  const ownerId = response.memories?.[0]?.id; assert(ownerId);
  await maintain(); await stop();
  const first = inspect(ownerId, text); phase("current-random-generation-and-keyed-hash-complete-in-packaged-Core");
  stage = "completed-A-B-A";
  await start();
  await request({ type: "memory-correct", id: ownerId, content: "Generated beta release preference" });
  await request({ type: "memory-correct", id: ownerId, content: text });
  await maintain(); await stop();
  const returned = inspect(ownerId, text);
  assert.notEqual(returned.generation, first.generation); assert.notEqual(returned.jobId, first.jobId);
  assert.equal(returned.contentHash, first.contentHash); assert(returned.jobCount >= 2);
  phase("completed-A-to-B-to-A-uses-distinct-job-and-new-ready-vector");
  stage = "restart-and-retrieval";
  await start();
  const listed = await request({ type: "memory-list" }); assert(listed.memories.some(value => value.id === ownerId && value.content === text));
  const queried = await request({ type: "memory-timeline-query", query: "alpha release preference" });
  assert(queried.memoryTimeline?.results?.some(value => value.kind === "memory" && value.id === ownerId), "Current remembered content must remain searchable.");
  await stop();
  const restarted = inspect(ownerId, text); assert.equal(restarted.generation, returned.generation); assert.equal(restarted.jobId, returned.jobId);
  phase("same-key-restart-and-query-retain-current-completed-generation");
  receipt.result = "passed";
} catch (error) {
  receipt.result = "failed"; receipt.failedStage = stage;
  receipt.error = String(error?.message || error).replaceAll(key.toString("base64"), "[generated-key]").slice(0, 1000);
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
