// Bundled private Native Core protocol proof with SIMULATED picker replies.
// This does not launch Chromium, exercise Cocoa, or prove any visible UI flow.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Supply an explicit disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "This canary must not use an installed app.");
assert.notEqual(candidate, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
assert(candidate.endsWith(".app"), "Supply an explicit app bundle.");
const evidence = resolve(process.env.KESTREL_NATIVE_DIAGNOSTIC_PROTOCOL_EVIDENCE || ".tmp/native-diagnostic-protocol-evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use an empty evidence directory.");
const fingerprint = await candidateDigest(candidate);
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-diagnostic-protocol-")));
await mkdir(join(profile, "native-core"), { mode: 0o700 });
const resources = join(candidate, "Contents/Resources");
const testKey = randomBytes(32);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidateSha256: fingerprint,
  simulatedPickerReplies: true, simulatedPermissionProbe: true, cocoaUiExercised: false,
  scope: "Bundled Node/private Native Core protocol; generated profile, home and key only. No real Keychain, profile, provider login, Chromium, microphone or desktop control.", phases: [] };
let ready = false, sequence = 0, mode = "select", selectedPath, held, failure, stderr = "", stopping = false, syntheticPermissionReplies = 0;
const pending = new Map(), dialogs = [], cancellations = new Set(), owned = new Map();
const child = spawn(join(resources, "agent-core/node/bin/node"), [join(resources, "native-desktop-core.mjs"), "--profile-root", profile, "--browser-profile-root", profile, "--durable-profile"], {
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", TMPDIR: profile, HOME: profile,
    KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
const exited = new Promise(resolveExit => {
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
  child.once("error", () => resolveExit({ code: "SPAWN_ERROR", signal: null }));
});
child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-100_000); });
child.stdin.on("error", () => {});
child.once("error", error => { failure = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned Native Core could not start.")); } pending.clear(); });
function write(value) { child.stdin.write(JSON.stringify(value) + "\n"); }
function fail(error) {
  failure = error;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Private diagnostic protocol violated its fixture contract.")); }
  pending.clear(); child.kill("SIGTERM");
}
createInterface({ input: child.stdout }).on("line", line => {
  try {
    const message = JSON.parse(line);
    if (message.kind === "native-core-profile-key-request") {
      assert.equal(message.requestId, "native-core-profile-key-v1");
      write({ kind: "native-core-profile-key-response", requestId: message.requestId, ok: true, keyBase64: testKey.toString("base64") });
    } else if (message.type === "ready") ready = true;
    else if (message.type === "response") {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer); item.resolve(message.response);
    } else if (message.type === "browser-backend-reset") write({ type: "browser-backend-reset-response", requestId: message.requestId, ok: true });
    else if (message.type === "native-dialog-cancel") cancellations.add(message.requestId);
    else if (message.type === "native-dialog-request") {
      assert.deepEqual(Object.keys(message).sort(), ["operation", "requestId", "type"]);
      assert.equal(message.operation, "save-diagnostic-report");
      assert.match(message.requestId, /^native-dialog-\d+$/); dialogs.push(message.requestId);
      if (mode === "hold") { held = message; return; }
      write({ type: "native-dialog-response", requestId: message.requestId,
        response: mode === "cancel" ? { ok: true, cancelled: true } : { ok: true, selectedDiagnosticPath: selectedPath } });
    } else if (message.type === "native-computer-request" && message.request?.operation === "native-computer-permissions") {
      // Readiness asks for permission status. Reply synthetically; never query
      // the operating system or grant capture/control during this protocol test.
      assert.deepEqual(message.request, { operation: "native-computer-permissions" });
      assert.match(message.requestId, /^native-computer-\d+$/);
      syntheticPermissionReplies++;
      write({ type: "native-computer-response", requestId: message.requestId, ok: true,
        result: { screenRecording: "unavailable", accessibility: "unavailable" } });
    } else if (message.type === "native-computer-request" || message.type === "browser-backend-request") {
      throw Error("Diagnostic export must not request desktop or browser actions.");
    }
  } catch (error) { fail(error); }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  failure = Error("Generated diagnostic protocol canary interrupted.");
  if (child.exitCode === null && child.signalCode === null && !stopping) { stopping = true; write({ type: "shutdown" }); }
});
function issue(request, host = true) {
  const id = `diagnostic-fixture-${++sequence}`;
  const promise = new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Private diagnostic request timed out.")); }, 20_000);
    pending.set(id, { resolve: resolveResponse, reject, timer }); write({ type: host ? "host-request" : "request", id, request });
  });
  return { id, promise };
}
async function wait(check, label, milliseconds = 20_000) {
  for (const end = Date.now() + milliseconds; Date.now() < end;) {
    if (failure) throw failure;
    assert(child.exitCode === null && child.signalCode === null, "Owned Native Core exited unexpectedly.");
    if (check()) return; await delay(25);
  }
  throw Error(label);
}
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name} (simulated picker; no Cocoa UI)`); }
async function absent(path) { await assert.rejects(access(path), error => error.code === "ENOENT"); }
function processRows() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }));
}
function rememberOwned() {
  const rows = processRows(), ids = new Set([child.pid]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  for (const row of rows) if (ids.has(row.pid)) owned.set(row.pid, row.command);
}
function liveOwned() { return processRows().filter(row => owned.get(row.pid) === row.command); }
async function awaitShutdown(milliseconds = 15_000) {
  return Promise.race([exited, delay(milliseconds, undefined, { ref: false }).then(() => { throw Error("Owned Native Core shutdown timed out."); })]);
}
function verifyReport(encoded) {
  const report = JSON.parse(encoded);
  const allowed = new Set(["version", "generatedAt", "appVersion", "platform", "arch", "runtime", "node", "packaged", "distribution", "readinessSummary", "lastFailureClass", "lastFailureAt"]);
  for (const [key, value] of Object.entries(report)) {
    assert(allowed.has(key), "Diagnostic report contains an unexpected field.");
    if (key === "readinessSummary") {
      assert.deepEqual(Object.keys(value).sort(), ["fail", "pass", "readyForLiveWork", "warning"]);
      assert.equal(typeof value.readyForLiveWork, "boolean");
      for (const count of [value.pass, value.warning, value.fail]) assert(Number.isSafeInteger(count) && count >= 0 && count <= 1000);
    } else assert(["string", "number", "boolean"].includes(typeof value) && value !== null, "Only allowlisted diagnostic scalars are permitted.");
  }
  assert.equal(report.version, 1); assert.equal(report.runtime, "native-chromium");
  assert.equal(report.platform, process.platform); assert.equal(report.arch, process.arch);
  assert.equal(report.packaged, true); assert.equal(report.distribution, "unknown");
  assert(Number.isFinite(Date.parse(report.generatedAt))); assert(report.readinessSummary);
  assert(report.appVersion === "unknown" || /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,4})?)?$/i.test(report.appVersion));
  if (report.node !== undefined) assert.match(report.node, /^\d+\.\d+\.\d+$/);
  assert(!encoded.includes(profile)); assert(!encoded.includes(testKey.toString("base64")));
  assert(!/GENERATED_DIAGNOSTIC_PRIVATE_TITLE|openai|anthropic|ollama|codex|credential|prompt|provider|\/Users\/|\/private\/|kestrel-native-diagnostic-protocol-/i.test(encoded));
  return report;
}

try {
  await wait(() => ready, "Native Core did not become ready."); rememberOwned();
  const seeded = await issue({ type: "runtime-create-session", title: "GENERATED_DIAGNOSTIC_PRIVATE_TITLE", kind: "conversation" }, false).promise;
  assert.equal(seeded.ok, true);
  selectedPath = join(profile, "new-diagnostic.json");
  const saved = await issue({ type: "export-diagnostic-report" }).promise;
  assert.deepEqual(saved, { ok: true, diagnosticReportSaved: true });
  const info = await lstat(selectedPath);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1); assert.equal(info.mode & 0o777, 0o600);
  assert.equal(info.uid, process.getuid());
  const encodedReport = await readFile(selectedPath, "utf8"); verifyReport(encodedReport);
  const reportArtifact = "generated-diagnostic-report.json";
  await writeFile(join(evidence, reportArtifact), encodedReport, { mode: 0o600 });
  receipt.artifacts = [{ path: reportArtifact, sha256: createHash("sha256").update(encodedReport).digest("hex") }];
  phase("bundled-Core-report-private-file-allowlisted-content-free-scalars-and-metadata-only-receipt");

  mode = "cancel"; const cancelledPath = join(profile, "cancelled-diagnostic.json");
  assert.deepEqual(await issue({ type: "export-diagnostic-report" }).promise, { ok: true, cancelled: true });
  await absent(cancelledPath); phase("simulated-picker-cancel-returns-cancelled-without-file");

  mode = "select"; selectedPath = join(profile, "existing-diagnostic.json");
  const existing = Buffer.from("Generated existing destination must remain unchanged.\n");
  await writeFile(selectedPath, existing, { mode: 0o600 });
  const refused = await issue({ type: "export-diagnostic-report" }).promise;
  assert.equal(refused.ok, false); assert.deepEqual(Object.keys(refused).sort(), ["error", "ok"]);
  assert(!refused.error.includes(profile)); assert.deepEqual(await readFile(selectedPath), existing);
  phase("existing-destination-refused-with-generated-bytes-unchanged");

  const target = join(profile, "symlink-target.json"), link = join(profile, "symlink-diagnostic.json");
  await writeFile(target, existing, { mode: 0o600 }); await symlink(target, link); selectedPath = link;
  assert.equal((await issue({ type: "export-diagnostic-report" }).promise).ok, false);
  assert((await lstat(link)).isSymbolicLink()); assert.equal(await readlink(link), target);
  assert.deepEqual(await readFile(target), existing); phase("final-symlink-refused-with-target-and-link-unchanged");

  mode = "hold"; held = undefined;
  const waiting = issue({ type: "export-diagnostic-report" });
  await wait(() => held, "Pending diagnostic picker did not start.");
  const heldDialog = held.requestId;
  write({ type: "host-cancel", id: "unrelated-generated-request" }); await delay(100);
  assert(pending.has(waiting.id)); assert(!cancellations.has(heldDialog));
  write({ type: "host-cancel", id: waiting.id });
  assert.deepEqual(await waiting.promise, { ok: true, cancelled: true });
  await wait(() => cancellations.has(heldDialog), "Matching host cancellation did not dismiss its private picker.");
  const latePath = join(profile, "late-diagnostic.json");
  write({ type: "native-dialog-response", requestId: heldDialog, response: { ok: true, selectedDiagnosticPath: latePath } });
  mode = "cancel";
  assert.deepEqual(await issue({ type: "export-diagnostic-report" }).promise, { ok: true, cancelled: true });
  await absent(latePath); phase("host-cancel-matches-request-id-cancels-private-dialog-and-ignores-late-selection");

  mode = "hold"; held = undefined;
  const duringShutdown = issue({ type: "export-diagnostic-report" });
  const shutdownResponse = duringShutdown.promise.catch(() => undefined);
  await wait(() => held, "Shutdown fixture picker did not start.");
  const shutdownDialog = held.requestId; rememberOwned();
  stopping = true; write({ type: "shutdown" });
  assert.deepEqual(await awaitShutdown(), { code: 0, signal: null });
  assert(cancellations.has(shutdownDialog), "Clean shutdown must dismiss the pending private picker.");
  for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ ok: true, cancelled: true }); } pending.clear(); await shutdownResponse;
  assert.equal(liveOwned().length, 0, "Owned Node/Core workers must all exit.");
  assert(!stderr.includes(testKey.toString("base64")), "Generated test key must not enter child diagnostics.");
  assert(syntheticPermissionReplies > 0, "Readiness should receive synthetic unavailable permission status.");
  receipt.syntheticUnavailablePermissionReplies = syntheticPermissionReplies;
  receipt.ownedProcessesObserved = owned.size;
  phase("pending-picker-clean-shutdown-no-owned-Node-workers-left");
  receipt.result = "passed";
} catch (error) { receipt.result = "failed"; receipt.error = error.message; process.exitCode = 1; }
finally {
  if (child.exitCode === null && child.signalCode === null) {
    rememberOwned(); if (!stopping) { stopping = true; write({ type: "shutdown" }); }
    await awaitShutdown(5000).catch(async () => {
      for (const row of liveOwned().reverse()) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
      await exited;
    });
  }
  for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ ok: false, error: "Fixture stopped." }); } pending.clear();
  const survivors = liveOwned();
  if (survivors.length) {
    receipt.result = "failed"; receipt.ownedWorkerCleanupRequired = true; process.exitCode = 1;
    for (const row of survivors.reverse()) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
  }
  testKey.fill(0);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  receipt.candidateSha256After = await candidateDigest(candidate);
  if (receipt.candidateSha256After !== fingerprint) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(`Native diagnostic private protocol ${receipt.result}; picker replies were simulated. Cocoa UI was not exercised.`);
}
