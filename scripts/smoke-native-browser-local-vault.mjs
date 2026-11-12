#!/usr/bin/env node
// Production storage only, in a new private profile. Never accepts a profile path.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { assertNoExactExecutableRunning } from "./native-real-keychain-candidate.mjs";
import { validateVaultCanaryCandidate } from "./native-vault-canary-candidate.mjs";
import { browserStorageProtocolError, recordBrowserStorageDiagnostic, waitForBrowserStorageHome } from "./native-browser-storage-readiness.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT, "1", "Explicit generated-profile vault test opt-in required.");
assert.equal(process.argv.length, 2, "This test accepts no profile or other command-line arguments.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Validate before creating a profile, opening a port, or starting any native process.
const { candidate, executable, buildName, metadata, frameworkSha256 } =
 await validateVaultCanaryCandidate(process.env.KESTREL_NATIVE_TEST_APP, { root });
const bundleId = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(candidate, "Contents/Info.plist")], { encoding: "utf8" }).trim();
assert.equal(bundleId, "com.kestrel.native-chromium-host.dev", "Select a disposable development bundle.");
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const evidence = join(root, ".tmp", `native-browser-local-vault-${Date.now()}-${randomUUID()}`);
await mkdir(evidence, { mode: 0o700 });
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-production-vault-")));
const profileInfo = await lstat(profile);
assert(profileInfo.isDirectory() && !profileInfo.isSymbolicLink() && profileInfo.uid === process.getuid() && (profileInfo.mode & 0o077) === 0);
assert.deepEqual(await readdir(profile), []);
// Do not markDisposableNativeTestProfile: that helper creates a raw test key.
const homeId = [...createHash("sha256").update(join(profile, "kestrel-ui-bundle")).digest("hex").slice(0, 32)]
 .map(digit => "abcdefghijklmnop"[parseInt(digit, 16)]).join("");
const homeUrl = `chrome-extension://${homeId}/index.html`;
const cookieName = `kestrel_canary_${randomBytes(12).toString("hex")}`;
const cookieValue = randomBytes(32).toString("hex");
const coreValue = `kestrel-vault-message:${randomBytes(32).toString("hex")}`;
const receipt = { version: 1, result: "failed", startedAt: new Date().toISOString(),
 candidate: `.tmp/${buildName}/Kestrel.app`, frameworkSha256, sourceFrameworkSha256: metadata.sourceFrameworkSha256,
 pins: metadata.pins, patches: metadata.patches, sourceProvenance: metadata.sourceProvenance,
 launches: [], stops: [], phases: [], protocolDiagnostics: [],
 scope: "Generated production-vault cookie and encrypted Core message restart only. Keychain-item API claim concerns the reviewed storage providers and the native host/helper imports, not unrelated macOS certificate APIs. Source provenance is a builder attestation. No password-manager, migration, signing identity, installed app or user-profile acceptance." };
let child, browser, interrupted, stage = "preflight", stopped = true, cleanStop = false, serverListening = false;
let seedEnabled = true, seedResponses = 0, checks = 0, sessionId, vaultBytes;
function interrupt(signal) {
 interrupted ??= signal;
 process.exitCode = signal === "SIGINT" ? 130 : 143;
 if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}
process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));
function checkInterrupt() { if (interrupted) throw Error("Interrupted."); }
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
function setStage(name) { stage = name; console.log(`STAGE ${name}`); }
function noCandidateProcesses() {
 const rows = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000 });
 for (const line of rows.split(/\r?\n/)) {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  assert(!match || !match[2].startsWith(`${candidate}/`), "A candidate bundle process remains running.");
 }
}
const server = createServer((req, res) => {
 res.setHeader("Cache-Control", "no-store");
 if (req.url === "/seed" && seedEnabled && seedResponses === 0) {
  seedResponses++;
  res.setHeader("Set-Cookie", `${cookieName}=${cookieValue}; HttpOnly; Path=/; Max-Age=3600; SameSite=Lax`);
 }
 if (req.url === "/check" && req.headers.cookie === `${cookieName}=${cookieValue}`) checks++;
 res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("generated local vault fixture");
});
async function eventually(fn, timeout = 30000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) { checkInterrupt(); const result = await fn(); if (result) return result; await delay(100); }
 throw Error("Timed out in recorded stage.");
}
async function connect(endpoint) {
 const socket = new WebSocket(endpoint), pending = new Map(); let next = 0, closed = false;
 const rejectPending = () => {
  closed = true;
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("CDP transport closed.")); }
  pending.clear();
 };
 socket.addEventListener("message", event => {
  let message;
  try { message = JSON.parse(event.data); } catch { rejectPending(); socket.close(); return; }
  const waiter = pending.get(message.id); if (!waiter) return;
  pending.delete(message.id); clearTimeout(waiter.timer);
  if (message.error) {
   const error = browserStorageProtocolError(waiter.method, message.error);
   recordBrowserStorageDiagnostic(receipt.protocolDiagnostics, error); waiter.reject(error);
  } else waiter.resolve(message.result);
 });
 socket.addEventListener("close", rejectPending);
 socket.addEventListener("error", rejectPending);
 await new Promise((ok, fail) => {
  const timer = setTimeout(() => { socket.close(); fail(Error("CDP connection timeout.")); }, 10000);
  socket.addEventListener("open", () => { clearTimeout(timer); ok(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); fail(Error("CDP connection failed.")); }, { once: true });
  socket.addEventListener("close", () => { clearTimeout(timer); fail(Error("CDP connection closed.")); }, { once: true });
 });
 return {
  send(method, params = {}, session, timeoutMs = 15000) {
   checkInterrupt();
   if (closed) return Promise.reject(Error("CDP transport closed."));
   return new Promise((ok, fail) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); fail(Error("CDP command timeout.")); }, timeoutMs);
    pending.set(id, { method, resolve: ok, reject: fail, timer });
    try { socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })); }
    catch { clearTimeout(timer); pending.delete(id); fail(Error("CDP send failed.")); }
   });
  }, close() { rejectPending(); socket.close(); },
 };
}
async function evaluate(target, expression, onOperation = () => {}) {
 onOperation("attach");
 const { sessionId: session } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
 try {
  onOperation("evaluate");
  const result = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
  assert(!result.exceptionDetails, "Target evaluation failed."); return result.result?.value;
 } finally { await browser.send("Target.detachFromTarget", { sessionId: session }).catch(() => {}); }
}
async function coreRequest(home, request) {
 const result = await evaluate(home, `window.kestrel.request(${JSON.stringify(request)})`);
 assert.equal(result?.ok, true, "Native Core request failed."); return result;
}
async function start() {
 checkInterrupt(); assertNoExactExecutableRunning(executable); noCandidateProcesses();
 assert.equal(await candidateDigest(candidate), receipt.candidateSha256);
 setStage("launch");
 let output = "", failed = false;
 child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile,
  "--kestrel-durable-profile", "--enable-automation", "--remote-debugging-port=0"], {
  stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "",
   TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: "en_US.UTF-8",
   KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" },
 });
 stopped = false; cleanStop = false;
 child.once("error", () => { failed = true; });
 for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-131072); });
 setStage("native-browser-endpoint");
 const endpoint = await eventually(() => {
  assert(!failed && child.exitCode === null && child.signalCode === null, "Candidate exited during launch.");
  assert(!output.includes("KESTREL_NATIVE_KEYCHAIN_POLICY selected=mock"), "Mock provider unexpectedly selected.");
  return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
 }, 60000);
 browser = await connect(endpoint); setStage("effective-command-line");
 const { arguments: args } = await browser.send("Browser.getBrowserCommandLine");
 assert(Array.isArray(args) && args.includes("--kestrel-durable-profile"));
 assert(!args.some(arg => /^--(?:use-mock-keychain|kestrel-real-keychain|kestrel-test-profile-key)(?:=|$)/.test(arg)), "Non-production storage switch present.");
 setStage("home-ready");
 const home = await waitForBrowserStorageHome({ send: (...args) => browser.send(...args),
  evaluateHome: (target, onOperation) => evaluate(target, "typeof window.kestrel?.request === 'function'", onOperation),
  homeUrl, checkInterrupt });
 setStage("provider-discovery-opt-out");
 const subscriptions = await coreRequest(home, { type: "subscription-cli-status" });
 assert(Array.isArray(subscriptions.subscriptionClis) && subscriptions.subscriptionClis.length > 0);
 assert(subscriptions.subscriptionClis.every(item => !item.detected && !item.enabled && !item.path && !item.authenticated));
 receipt.launches.push({ pid: child.pid, productionStorageSwitches: true, subscriptionDiscoveryDisabled: true });
 return home;
}
async function openTab(home, url) {
 setStage(new URL(url).pathname === "/seed" ? "seed-tab" : "check-tab");
 await coreRequest(home, { type: "browser-create-tab", input: url, active: true });
 const page = await eventually(async () => (await browser.send("Target.getTargets")).targetInfos.find(t => t.type === "page" && t.url === url));
 assert.deepEqual(await evaluate(page, "({bridge: typeof window.kestrel, nativeQuery: typeof window.__kestrelNativeQuery})"),
  { bridge: "undefined", nativeQuery: "undefined" });
}
async function stop() {
 if (browser) { browser.close(); browser = undefined; }
 if (!child || stopped) return;
 const owned = child;
 const wait = timeout => new Promise(resolveWait => {
  if (owned.exitCode !== null || owned.signalCode !== null) return resolveWait({ code: owned.exitCode, signal: owned.signalCode });
  const onExit = (code, signal) => { clearTimeout(timer); resolveWait({ code, signal }); };
  const timer = setTimeout(() => { owned.off("exit", onExit); resolveWait(null); }, timeout);
  owned.once("exit", onExit);
 });
 if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGTERM");
 let forced = false, outcome = await wait(15000);
 if (!outcome) { forced = true; owned.kill("SIGKILL"); outcome = await wait(5000); }
 if (!outcome) throw Error("Owned process did not stop.");
 receipt.stops.push({ pid: owned.pid, exitCode: outcome.code, signal: outcome.signal, forced });
 stopped = true; cleanStop = !forced && outcome.code === 0 && outcome.signal === null;
 assert(cleanStop, "Owned process did not stop cleanly.");
 await eventually(() => { try { noCandidateProcesses(); return true; } catch { return false; } }, 10000);
}
async function regularFile(path, maximum = 64 * 1024 * 1024) {
 assert.equal(await realpath(path), path, "Generated file resolves through a link.");
 const info = await lstat(path);
 assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && info.size <= maximum,
  "Unexpected generated storage file.");
 return info;
}
async function inspectRawDatabase(path, plaintext) {
 await regularFile(path);
 for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const file = path + suffix;
  const info = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!info) continue;
  await regularFile(file);
  assert(!(await readFile(file)).includes(Buffer.from(plaintext)), "Generated plaintext present in raw database or journal.");
 }
}
async function inspectStorage() {
 assert(stopped && cleanStop); noCandidateProcesses();
 const vault = join(profile, ".kestrel-local-vault-v1"), info = await regularFile(vault, 16384);
 assert.equal(info.mode & 0o777, 0o600);
 const bytes = await readFile(vault);
 assert(bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x4b, 0x53, 0x54, 0x56, 0x4c, 0x54, 1, 0])));
 if (vaultBytes) assert(bytes.equals(vaultBytes), "Vault was replaced between starts."); else vaultBytes = bytes;
 for (const path of [join(profile, ".kestrel-native-test-core-key-v1"), join(profile, "native-core/database.key")])
  await assert.rejects(lstat(path), { code: "ENOENT" });
 const choices = [join(profile, "Default/Network/Cookies"), join(profile, "Default/Cookies")];
 const existing = [];
 for (const path of choices) {
  const found = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (found) existing.push(path);
 }
 assert.equal(existing.length, 1, "Expected one generated cookie database.");
 const cookiePath = existing[0]; await regularFile(cookiePath);
 const cookies = new Database(cookiePath, { readonly: true, fileMustExist: true });
 try {
  const rows = cookies.prepare("SELECT value, encrypted_value, is_persistent, is_httponly FROM cookies WHERE host_key = ? AND name = ?").all("127.0.0.1", cookieName);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.value, ""); assert.equal(row.is_persistent, 1); assert.equal(row.is_httponly, 1);
  assert(Buffer.isBuffer(row.encrypted_value) && row.encrypted_value.length > 3 + 12 + 16 && row.encrypted_value.subarray(0, 3).toString("ascii") === "v99",
   "Cookie did not use the custom vault provider ciphertext format.");
 } finally { cookies.close(); }
 await inspectRawDatabase(cookiePath, cookieValue);
 const corePath = join(profile, "native-core/database/kestrel.sqlite"); await regularFile(corePath);
 const core = new Database(corePath, { readonly: true, fileMustExist: true });
 try {
  const rows = core.prepare("SELECT content_ciphertext, content_iv, content_auth_tag FROM runtime_messages WHERE session_id = ? AND role = 'user'").all(sessionId);
  assert.equal(rows.length, 1);
  for (const value of Object.values(rows[0])) assert(typeof value === "string" && value.length > 0 && !value.includes(coreValue), "Core message is missing its encrypted fields.");
 } finally { core.close(); }
 await inspectRawDatabase(corePath, coreValue);
}
async function writeGate(gate, checks) {
 const kind = gate === "native-local-vault" ? "native-local-vault-canary" : "native-browser-local-vault-canary";
 const proof = { version: 1, kind, gate, result: "passed", provider: gate === "native-local-vault" ? "secure-enclave-local-vault" : "chromium-local-vault",
  candidateSha256: receipt.candidateSha256, candidateSha256After: receipt.candidateSha256After, observedAt: receipt.finishedAt,
  checks, scope: receipt.scope, frameworkSha256, sourceProvenance: metadata.sourceProvenance };
 const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`), name = `${gate}.json`;
 await writeFile(join(evidence, name), bytes, { mode: 0o600, flag: "wx" });
 const wrapper = { version: 1, gate, result: "passed", candidateSha256: receipt.candidateSha256, observedAt: receipt.finishedAt,
  summary: gate === "native-local-vault" ? "Production native Core encrypted message decrypted after clean restart." : "Production Chromium v99 encrypted persistent cookie returned after clean restart without reseeding.",
  artifacts: [{ kind, path: name, sha256: createHash("sha256").update(bytes).digest("hex") }] };
 await writeFile(join(evidence, `${gate}-receipt.json`), `${JSON.stringify(wrapper, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
try {
 checkInterrupt(); receipt.candidateSha256 = await candidateDigest(candidate);
 await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { serverListening = true; ok(); }); });
 const base = `http://127.0.0.1:${server.address().port}`;
 let home = await start();
 setStage("core-encrypted-write");
 const created = await coreRequest(home, { type: "runtime-create-session", title: "Generated local vault test", kind: "conversation" });
 sessionId = created.session?.id; assert(typeof sessionId === "string" && sessionId);
 await coreRequest(home, { type: "runtime-append-message", sessionId, role: "user", content: coreValue });
 assert((await coreRequest(home, { type: "runtime-list-messages", sessionId })).messages?.some(message => message.content === coreValue));
 await openTab(home, `${base}/seed`); await eventually(() => seedResponses === 1);
 seedEnabled = false; receipt.seedingDisabledBeforeShutdown = true;
 await openTab(home, `${base}/check`); await eventually(() => checks >= 1);
 setStage("first-clean-stop"); await stop();
 setStage("first-storage-inspection"); await inspectStorage(); phase("first-start-core-message-and-v99-cookie");
 home = await start();
 setStage("core-restart-readback");
 assert((await coreRequest(home, { type: "runtime-list-messages", sessionId })).messages?.some(message => message.content === coreValue), "Core message did not decrypt after restart.");
 phase("core-production-restart-readback");
 const previousChecks = checks; await openTab(home, `${base}/check`); await eventually(() => checks > previousChecks);
 phase("browser-cookie-restart-without-reseeding");
 setStage("second-clean-stop"); await stop();
 setStage("second-storage-inspection"); await inspectStorage(); phase("second-start-encrypted-storage-inspection");
 assert.equal(seedResponses, 1); assert.equal(receipt.launches.length, 2); assert.equal(receipt.stops.length, 2);
 receipt.candidateSha256After = await candidateDigest(candidate); assert.equal(receipt.candidateSha256After, receipt.candidateSha256);
 checkInterrupt(); receipt.result = "passed";
} catch (error) {
 receipt.result = "failed"; receipt.failedStage = stage;
 receipt.failureCategory = error?.code === "ERR_ASSERTION" ? "assertion" : error?.message === "CDP command timeout." ? "cdp-command-timeout" : "recorded-stage-failure";
 process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
 console.error(`Production local vault canary failed at ${stage}.`);
} finally {
 try { await stop(); } catch { receipt.result = "failed"; receipt.failedStage ??= "owned-process-cleanup"; process.exitCode = 1; }
 if (serverListening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
 let bundleStopped = stopped;
 if (bundleStopped) { try { noCandidateProcesses(); } catch { bundleStopped = false; } }
 if (interrupted) { receipt.result = "failed"; receipt.failedStage ??= stage; process.exitCode = interrupted === "SIGINT" ? 130 : 143; }
 if (bundleStopped && receipt.result === "passed") {
  try { await rm(profile, { recursive: true }); receipt.profileCleanup = "generated profile removed"; }
  catch { receipt.result = "failed"; process.exitCode = 1; }
 }
 if (receipt.result !== "passed") { receipt.profileCleanup = "failed generated profile retained"; receipt.profilePath = profile; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString(); receipt.fixtureProgress = { seedResponses, checks, seedEnabled };
 if (receipt.result === "passed") {
  try {
   checkInterrupt();
   const shared = { freshGeneratedProfile: true, productionProvider: true, cleanRestart: true, sameProfileRestartReadback: true,
    encryptedDataVerified: true, plaintextAbsent: true, noMockProvider: true, noTestKey: true, noKeychainItemAPIs: true };
   await writeGate("native-local-vault", shared);
   await writeGate("native-browser-local-vault", { ...shared, persistentCookieReadback: true, encryptedCookieRow: true });
   checkInterrupt();
  } catch {
   receipt.result = "failed"; receipt.failedStage = "gate-artifact-output"; process.exitCode = 1;
   for (const gate of ["native-local-vault", "native-browser-local-vault"])
    for (const suffix of [".json", "-receipt.json"]) await rm(join(evidence, gate + suffix), { force: true });
  }
 }
 await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
 console.log(`Production local vault ${receipt.result}; receipt: ${join(evidence, "receipt.json")}`);
}
