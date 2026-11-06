import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an explicit native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "Use a separate candidate, never an installed app.");
const evidence = resolve(process.env.KESTREL_NATIVE_PENDING_PROJECT_EVIDENCE || ".tmp/native-pending-project-evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory.");
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate,
  candidateSha256: await candidateDigest(candidate),
  scope: "Generated encrypted database transfer and real bundled Node/Core IPC only. Pending IDs are supplied by this test as trusted bootstrap metadata. This does not prove native manifest persistence, transfer UI, trusted picker reconnection, actual profile activation, or canonical installation.",
  phases: [] };
const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-pending-project-")));
const sourceKey = randomBytes(32), destinationKey = randomBytes(32);
const resources = join(candidate, "Contents/Resources/agent-core");
const sourceRoot = join(fixture, "source"), destinationRoot = join(fixture, "destination");
const source = join(sourceRoot, "kestrel.sqlite"), target = join(destinationRoot, "kestrel.sqlite");
const workspace = join(fixture, "other-granted-folder"), reconnected = join(fixture, "chosen-reconnection");
for (const directory of [sourceRoot, destinationRoot, workspace, reconnected]) await mkdir(directory, { mode: 0o700 });
const sentinel = "Generated pending-project confidential message";
await writeFile(join(workspace, "README.md"), "Another project's generated file.\n", { mode: 0o600 });
await writeFile(join(reconnected, "README.md"), "Explicitly reconnected generated file.\n", { mode: 0o600 });
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const C = await tsImport("../packages/shared-types/src/index.ts", import.meta.url);
const { launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
const { CoreSupervisor, nodeCoreProcess } = await import(pathToFileURL(join(resources, "service/native-desktop-runtime.mjs")).href);
const owned = new Set();
let transfer, stage = "seed", sourceBytes;
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
const timestamp = "2026-11-06T05:00:00.000Z";
const pendingId = "custom-imported-project", deletedId = "deleted-imported-project", absentId = "absent-imported-project";
const project = (id, path) => ({ id, path, name: "Generated project", order: 0, createdAt: timestamp, updatedAt: timestamp, available: true });
const configuration = { databasePath: target, encryptionKeyBase64: destinationKey.toString("base64"),
  workspaceRoots: [workspace], configuredWorkspaceRoots: [workspace], projects: [project("other-project", workspace)],
  pendingProjectIds: [pendingId, deletedId, absentId], pluginRoots: [], managedPluginRoots: [],
  learnedSkillRoot: join(fixture, "skills"), secureEnvironment: {}, providerAccounts: [] };
const supervisor = new CoreSupervisor(undefined, undefined, { restartDelaysMs: [], startupTimeoutMs: 15_000,
  processFactory: () => {
    const child = nodeCoreProcess({ executable: join(resources, "node/bin/node"), entryPath: join(resources, "service/index.js"),
      env: { HOME: fixture, KESTREL_DATA_DIR: fixture, PATH: "/usr/bin:/bin", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" }, stdout: "ignore" });
    owned.add(child); child.once("exit", () => owned.delete(child)); return child;
  } });
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Generated pending-project check timed out.")), 20_000); })]); }
  finally { clearTimeout(timer); }
}
async function request(input) {
  const response = await bounded(supervisor.request(input));
  assert.equal(response.ok, true, "The generated Core request must succeed.");
  return response;
}
async function stop() { await bounded(supervisor.stop()); assert.equal(owned.size, 0); }
function inspect(operation) {
  assert.equal(owned.size, 0, "Never inspect the database while its Core is alive.");
  const database = new KestrelDatabase(target, destinationKey);
  try { return operation(database); } finally { database.close(); }
}
let expectedEntity, expectedDeleted;
function unchangedEntities() {
  inspect(database => {
    assert.deepEqual(database.db.prepare("SELECT * FROM memory_entities WHERE id = ?").get(`memory-project-${pendingId}`), expectedEntity);
    assert.deepEqual(database.db.prepare("SELECT * FROM memory_entities WHERE id = ?").get(`memory-project-${deletedId}`), expectedDeleted);
    assert.equal(database.getMemoryEntity(`memory-project-${absentId}`), undefined);
  });
}
try {
  const database = new KestrelDatabase(source, sourceKey);
  try {
    for (const privacyMode of ["private", "incognito"]) {
      const id = `generated-pending-${privacyMode}`;
      database.saveRuntimeSession(C.RuntimeSessionSchema.parse({ id, title: "Generated pending session", privacyMode,
        projectId: pendingId, workspaceRoot: workspace, allowedTools: ["workspace.read"], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp }));
      database.saveRuntimeMessage({ id: `generated-message-${privacyMode}`, sessionId: id, role: "user", content: sentinel, createdAt: timestamp });
    }
    for (const [id, status] of [[pendingId, "active"], [deletedId, "deleted"]]) {
      database.upsertMemoryEntity(C.EntityRecordSchema.parse({ id: `memory-project-${id}`, kind: "project", canonicalName: "Generated retained project",
        aliases: [], description: "Generated custom project instructions", structuredData: { projectId: id, path: workspace, available: true },
        sourceIds: [`project:${id}`], confidence: 1, sensitivity: "restricted", status,
        firstSeenAt: timestamp, lastSeenAt: timestamp, createdAt: timestamp, updatedAt: timestamp }));
    }
  } finally { database.close(); }
  sourceBytes = await readFile(source);
  stage = "bundled-transfer";
  transfer = launchCoreTransferFixture({ executable: join(resources, "node/bin/node"), entry: join(resources, "service/host-profile-file-transfer.js"), home: fixture });
  const planned = await transfer.request("plan", { sourceDatabasePath: source, destinationDatabasePath: target, sourceKeyBase64: sourceKey.toString("base64") });
  assert.equal(planned.ok, true);
  const applied = await transfer.request("apply", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: destinationKey.toString("base64") });
  assert.equal(applied.ok, true); assert.equal(applied.receipt.activationPerformed, false);
  const verified = await transfer.request("verify-recovery", { recoveryId: applied.recoveryId });
  assert.equal(verified.ok, true); assert.equal(verified.recovery.originalReadable, true); assert.equal(verified.recovery.destinationReadable, true);
  assert.deepEqual(await transfer.stop(), { code: 0, signal: null });
  assert.equal(transfer.errors(), "");
  for (const value of [sourceKey.toString("base64"), destinationKey.toString("base64"), sentinel]) assert(!transfer.output().includes(value));
  transfer = undefined;
  assert.deepEqual(await readFile(source), sourceBytes);
  inspect(database => {
    expectedEntity = database.db.prepare("SELECT * FROM memory_entities WHERE id = ?").get(`memory-project-${pendingId}`);
    expectedDeleted = database.db.prepare("SELECT * FROM memory_entities WHERE id = ?").get(`memory-project-${deletedId}`);
    assert(expectedEntity && expectedDeleted);
  });
  phase("bundled-encrypted-transfer-and-independent-key-verification-preserve-source");

  stage = "invalid-bootstrap";
  const beforeInvalid = await readFile(target);
  await assert.rejects(async () => supervisor.start({ ...configuration, pendingProjectIds: "abc" }));
  assert.equal(owned.size, 0); assert.deepEqual(await readFile(target), beforeInvalid);
  phase("invalid-pending-bootstrap-refused-before-child-or-database-mutation");

  for (let iteration = 0; iteration < 2; iteration++) {
    stage = `pending-start-${iteration}`;
    await bounded(supervisor.start(configuration));
    const listed = await request({ type: "runtime-list-sessions" });
    for (const privacyMode of ["private", "incognito"]) {
      const id = `generated-pending-${privacyMode}`;
      const session = listed.sessions.find(value => value.id === id);
      assert.equal(session?.projectId, pendingId); assert.equal(session.privacyMode, privacyMode); assert.equal(session.workspaceRoot, undefined);
      const messages = await request({ type: "runtime-list-messages", sessionId: id });
      assert(messages.messages.some(message => message.content === sentinel));
      const denied = await bounded(supervisor.request({ type: "runtime-call-tool", sessionId: id, toolName: "workspace.read", input: { path: "README.md" } }));
      assert.equal(denied.ok, false, "Another grant covering the old folder must not authorize this pending session.");
      if (iteration === 0) {
        const fork = await request({ type: "runtime-fork-session", sessionId: id });
        assert.equal(fork.session.projectId, pendingId); assert.equal(fork.session.privacyMode, privacyMode); assert.equal(fork.session.workspaceRoot, undefined);
      }
    }
    await stop(); unchangedEntities();
    phase(iteration === 0 ? "first-Core-start-and-private-forks-retain-identities-without-workspace-access" : "Core-restart-retains-identities-and-does-not-create-or-revive-project-entities");
  }
  stage = "explicit-host-reconnection";
  const connected = { ...configuration, workspaceRoots: [workspace, reconnected], configuredWorkspaceRoots: [workspace, reconnected],
    projects: [...configuration.projects, project(pendingId, reconnected)], pendingProjectIds: [deletedId, absentId] };
  await bounded(supervisor.start(connected));
  const connectedSessions = await request({ type: "runtime-list-sessions" });
  const session = connectedSessions.sessions.find(value => value.id === "generated-pending-private");
  assert.equal(session.projectId, pendingId); assert.equal(session.workspaceRoot, reconnected);
  const read = await request({ type: "runtime-call-tool", sessionId: session.id, toolName: "workspace.read", input: { path: "README.md" } });
  assert.equal(read.execution.status, "verified"); assert.equal(read.execution.output.content, "Explicitly reconnected generated file.\n");
  await stop();
  phase("explicit-host-grant-reconnects-stable-identity-to-only-the-new-folder");

  stage = "revoke-connected-project";
  await bounded(supervisor.start({ ...configuration, pendingProjectIds: [deletedId, absentId] }));
  const revoked = (await request({ type: "runtime-list-sessions" })).sessions.find(value => value.id === session.id);
  assert.equal(revoked.projectId, undefined); assert.equal(revoked.workspaceRoot, undefined);
  const denied = await bounded(supervisor.request({ type: "runtime-call-tool", sessionId: revoked.id, toolName: "workspace.read", input: { path: "README.md" } }));
  assert.equal(denied.ok, false);
  await stop();
  inspect(database => {
    const id = `memory-project-${pendingId}`;
    assert.equal(database.getMemoryEntity(id), undefined, "Deleted projects must be absent from ordinary retrieval.");
    assert.equal(database.db.prepare("SELECT status FROM memory_entities WHERE id = ?").get(id)?.status, "deleted", "Revocation must retain a deleted project tombstone.");
  });
  assert.deepEqual(await readFile(source), sourceBytes);
  phase("ordinary-revocation-still-detaches-and-denies-access-with-original-source-intact");
  receipt.result = "passed";
} catch {
  // Generated contents and keys must not escape through assertion diagnostics.
  receipt.result = "failed"; receipt.failedStage = stage; process.exitCode = 1;
  console.error(`Native pending-project canary failed at ${stage}.`);
} finally {
  await stop().catch(() => { receipt.shutdownFailed = true; receipt.result = "failed"; process.exitCode = 1; });
  if (transfer) await transfer.stop().catch(() => { receipt.transferShutdownFailed = true; receipt.result = "failed"; process.exitCode = 1; });
  if (owned.size) {
    const exits = [...owned].map(child => new Promise(resolveExit => { child.once("exit", resolveExit); child.kill("SIGTERM"); }));
    await bounded(Promise.all(exits)).catch(async () => {
      for (const child of owned) child.kill("SIGKILL");
      await bounded(Promise.all(exits)).catch(() => {});
    });
  }
  receipt.ownedProcessesRemaining = owned.size;
  if (owned.size) { receipt.result = "failed"; process.exitCode = 1; }
  receipt.candidateSha256After = await candidateDigest(candidate);
  if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  sourceKey.fill(0); destinationKey.fill(0);
  if (!owned.size && !receipt.transferShutdownFailed) await rm(fixture, { recursive: true, force: true });
}
