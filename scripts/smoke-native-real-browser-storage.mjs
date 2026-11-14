#!/usr/bin/env node
throw new Error("Keychain diagnostics are disabled. Production storage now requires the native local-vault integration; no app was launched.");
// Disposable Chromium cookie persistence canary. Never accepts a profile path.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { assertNoExactExecutableRunning, validateRealKeychainCandidate } from "./native-real-keychain-candidate.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "darwin");
assert.equal(process.env.KESTREL_TEST_NATIVE_REAL_BROWSER_KEYCHAIN, "1", "Explicit browser Keychain opt-in required.");
const supplied = process.env.KESTREL_NATIVE_TEST_APP;
assert(supplied, "An absolute disposable candidate is required.");
const { candidate, executable, buildName } = await validateRealKeychainCandidate(supplied, { root });
const bundleId = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(candidate, "Contents/Info.plist")], { encoding: "utf8" }).trim();
assert.equal(bundleId, "com.kestrel.native-chromium-host.dev");
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const evidence = join(root, ".tmp", `native-real-browser-storage-${Date.now()}-${randomUUID()}`);
await mkdir(evidence, { mode: 0o700 });
const evidenceInfo = await lstat(evidence);
assert(evidenceInfo.isDirectory() && !evidenceInfo.isSymbolicLink() && evidenceInfo.uid === process.getuid() && (evidenceInfo.mode & 0o077) === 0);
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-browser-storage-")));
let child, browser, interrupted, stage = "preflight", stopped = true, serverListening = false;
let cleanStop = false, seedEnabled = true, seeded = false, checks = 0, seedResponses = 0;
const cookieName = `kestrel_canary_${randomBytes(12).toString("hex")}`;
const nonce = randomBytes(32).toString("hex");
const receipt = { version: 1, startedAt: new Date().toISOString(), gate: "native-chromium-system-configured-cookie-persistence-diagnostic", mode: "system-configured", systemKeychainCustodyVerified: false, candidate: `.tmp/${buildName}/Kestrel.app`, result: "failed", launches: [], stops: [], phases: [], scope: "Generated encrypted-cookie persistence under system-configured policy only; not independent proof of successful system Keychain use, website passwords, release signing identity, or user credentials. One native system safe-storage Keychain item may remain." };
function interrupt(signal) {
 interrupted ??= signal;
 process.exitCode = signal === "SIGINT" ? 130 : 143;
 if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}
process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));
function checkInterrupt() { if (interrupted) throw Error("Interrupted."); }
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
function noCandidateProcesses() {
 const rows = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000 });
 for (const line of rows.split(/\r?\n/)) {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  assert(!match || !match[2].startsWith(`${candidate}/`), "A candidate bundle process remains running.");
 }
}
const server = createServer((req, res) => {
 res.setHeader("Cache-Control", "no-store");
 if (req.url === "/seed" && seedEnabled && !seeded) {
  seeded = true;
  seedResponses++;
  console.log("COOKIE_SEED_RESPONSE_ONCE");
  res.setHeader("Set-Cookie", `${cookieName}=${nonce}; HttpOnly; Path=/; Max-Age=3600; SameSite=Lax`);
 }
 if (req.url === "/check" && req.headers.cookie === `${cookieName}=${nonce}`) { checks++; console.log("COOKIE_CHECK_RECEIVED"); }
 res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("canary");
});
async function eventually(fn, timeout = 30000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) { checkInterrupt(); const result = await fn(); if (result) return result; await delay(100); }
 throw Error("Timed out in recorded stage.");
}
async function connect(endpoint) {
 const socket = new WebSocket(endpoint), pending = new Map(); let next = 0;
 socket.addEventListener("message", event => {
  const message = JSON.parse(event.data), waiter = pending.get(message.id);
  if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer);
  message.error ? waiter.reject(Error("CDP command failed.")) : waiter.resolve(message.result);
 });
 socket.addEventListener("close", () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("CDP closed.")); } pending.clear(); });
 await new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(Error("CDP connection timeout.")), 10000);
  socket.addEventListener("open", () => { clearTimeout(timer); ok(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); fail(Error("CDP connection failed.")); }, { once: true });
 });
 return {
  send(method, params = {}, sessionId, timeoutMs = 15000) { return new Promise((ok, fail) => {
   const id = ++next, timer = setTimeout(() => { pending.delete(id); fail(Error("CDP command timeout.")); }, timeoutMs);
   pending.set(id, { resolve: ok, reject: fail, timer });
   try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
   catch { clearTimeout(timer); pending.delete(id); fail(Error("CDP send failed.")); }
  }); }, close() { socket.close(); },
 };
}
async function targetFor(predicate) {
 return eventually(async () => (await browser.send("Target.getTargets")).targetInfos.find(t => t.type === "page" && predicate(t.url)));
}
async function evaluate(target, expression, timeoutMs = 15000) {
 const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
 try {
  const result = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
  assert(!result.exceptionDetails, "Target evaluation failed."); return result.result?.value;
 } finally { await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {}); }
}
async function start() {
 checkInterrupt(); assertNoExactExecutableRunning(executable); noCandidateProcesses();
 assert.equal(await candidateDigest(candidate), receipt.candidateSha256); checkInterrupt();
 stage = "launch"; console.log(`STAGE ${stage}`);
 let output = "", failed = false;
 child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--kestrel-real-keychain", "--use-mock-keychain", "--enable-automation", "--remote-debugging-port=0"], {
  stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? "en_US.UTF-8", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" },
 });
 stopped = false; cleanStop = false;
 console.log(`OWNED_APP_PID ${child.pid}`);
 child.once("error", () => { failed = true; });
 child.once("exit", (code, signal) => console.log(`OWNED_APP_EXIT code=${code} signal=${signal}`));
 for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-131072); });
 stage = "system-policy-and-endpoint"; console.log(`STAGE ${stage}`);
 const endpoint = await eventually(() => {
  assert(!failed && child.exitCode === null && child.signalCode === null, "Candidate exited during launch.");
  const found = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
  return found && output.includes("KESTREL_NATIVE_KEYCHAIN_POLICY selected=system") ? found : undefined;
 }, 310000);
 checkInterrupt(); browser = await connect(endpoint);
 stage = "effective-command-line"; console.log(`STAGE ${stage}`);
 const { arguments: args } = await browser.send("Browser.getBrowserCommandLine");
 assert(Array.isArray(args) && args.includes("--kestrel-real-keychain") && !args.some(arg => arg === "--use-mock-keychain" || arg.startsWith("--use-mock-keychain=")));
 receipt.launches.push({ pid: child.pid, policyMarker: "system", effectiveMockSwitchAbsent: true });
 stage = "home-ready"; console.log(`STAGE ${stage}`);
 const home = await targetFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 await eventually(async () => await evaluate(home, "typeof window.kestrel?.request === 'function'"));
 stage = "provider-discovery-opt-out"; console.log(`STAGE ${stage}`);
 const subscriptions = await evaluate(home, "window.kestrel.request({type:'subscription-cli-status'})");
 assert(subscriptions?.ok && Array.isArray(subscriptions.subscriptionClis) && subscriptions.subscriptionClis.length > 0);
 assert(subscriptions.subscriptionClis.every(item => !item.detected && !item.enabled && !item.path && !item.authenticated), "Provider discovery opt-out was not honored.");
 receipt.launches.at(-1).subscriptionDiscoveryOptOutVerified = true;
 return home;
}
async function openTab(home, url) {
 const operation = new URL(url).pathname === "/seed" ? "seed" : "check";
 stage = `${operation}:create-tab`; console.log(`STAGE ${stage}`);
 // The first storage operation can wait for a protected macOS authorization.
 // Keep ordinary CDP deadlines; only this explicit permission window is longer.
 const result = await evaluate(home, `window.kestrel.request(${JSON.stringify({ type: "browser-create-tab", input: url, active: true })})`, operation === "seed" ? 310000 : 15000);
 assert(result?.ok === true, "Kestrel could not create the canary tab.");
 stage = `${operation}:attach-page`; console.log(`STAGE ${stage}`);
 const page = await targetFor(value => value === url);
 stage = `${operation}:public-page-isolation`; console.log(`STAGE ${stage}`);
 const exposed = await evaluate(page, "({bridge: typeof window.kestrel, nativeQuery: typeof window.__kestrelNativeQuery})");
 assert.deepEqual(exposed, { bridge: "undefined", nativeQuery: "undefined" });
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
 const deadline = Date.now() + 10000;
 while (true) {
  try { noCandidateProcesses(); break; }
  catch (error) { if (Date.now() >= deadline) throw error; await delay(100); }
 }
}
async function inspectCookie() {
 assert(stopped && cleanStop); noCandidateProcesses();
 const choices = [join(profile, "Default/Network/Cookies"), join(profile, "Default/Cookies")];
 const existing = [];
 for (const path of choices) { const info = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; }); if (info) existing.push({ path, info }); }
 assert.equal(existing.length, 1, "Expected one generated cookie database.");
 const { path, info } = existing[0];
 assert.equal(await realpath(path), path, "Cookie database resolves outside its generated path.");
 assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1);
 const db = new Database(path, { readonly: true, fileMustExist: true });
 try {
  const rows = db.prepare("SELECT host_key, name, value, encrypted_value, is_persistent, is_httponly FROM cookies WHERE host_key = ? AND name = ?").all("127.0.0.1", cookieName);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.value, ""); assert.equal(row.is_persistent, 1); assert.equal(row.is_httponly, 1);
  assert(Buffer.isBuffer(row.encrypted_value) && row.encrypted_value.length > 16 && !row.encrypted_value.includes(Buffer.from(nonce)));
 } finally { db.close(); }
 for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const file = path + suffix; const entry = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!entry) continue;
  assert.equal(await realpath(file), file);
  assert(entry.isFile() && !entry.isSymbolicLink() && entry.uid === process.getuid() && entry.nlink === 1);
  assert(!(await readFile(file)).includes(Buffer.from(nonce)), "Nonce found in raw cookie storage.");
 }
}
try {
 await markDisposableNativeTestProfile(profile); checkInterrupt();
 receipt.candidateSha256 = await candidateDigest(candidate); checkInterrupt();
 await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { serverListening = true; ok(); }); });
 const base = `http://127.0.0.1:${server.address().port}`;
 let home = await start(); stage = "seed-and-first-check"; console.log(`STAGE ${stage}`);
 await openTab(home, `${base}/seed`); await eventually(() => seeded);
 // Disable all future cookie writes before any shutdown, including restored tabs.
 seedEnabled = false;
 receipt.seedingDisabledBeforeShutdown = true;
 await openTab(home, `${base}/check`); await eventually(() => checks >= 1);
 stage = "first-clean-stop"; console.log(`STAGE ${stage}`);
 await stop();
 stage = "first-cookie-storage-inspection"; console.log(`STAGE ${stage}`);
 await inspectCookie(); phase("first-start-cookie-and-encrypted-row");
 checkInterrupt(); home = await start(); stage = "restart-check"; console.log(`STAGE ${stage}`);
 const firstChecks = checks; await openTab(home, `${base}/check`); await eventually(() => checks > firstChecks);
 stage = "second-clean-stop"; console.log(`STAGE ${stage}`);
 await stop();
 stage = "second-cookie-storage-inspection"; console.log(`STAGE ${stage}`);
 await inspectCookie(); phase("restart-cookie-and-encrypted-row");
 assert.equal(seedResponses, 1, "A restored or later tab reseeded the generated cookie.");
 receipt.totalCookieSeedResponses = seedResponses;
 checkInterrupt(); receipt.candidateSha256After = await candidateDigest(candidate);
 assert.equal(receipt.candidateSha256After, receipt.candidateSha256); checkInterrupt();
 receipt.result = "passed";
} catch (error) {
 receipt.result = "failed"; receipt.failedStage = stage; process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
 receipt.failureCategory = error?.message === "CDP command timeout." ? "cdp-command-timeout" : error?.code === "ERR_ASSERTION" ? "assertion" : "recorded-stage-failure";
 console.error(`Browser storage canary failed at ${stage}.`);
} finally {
 try { await stop(); } catch { receipt.result = "failed"; receipt.failedStage ??= "owned-process-cleanup"; process.exitCode = 1; }
 if (serverListening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
 let bundleStopped = stopped;
 if (bundleStopped) { try { noCandidateProcesses(); } catch { bundleStopped = false; } }
 if (bundleStopped && receipt.result === "passed") {
  try { await rm(profile, { recursive: true, force: true }); receipt.profileCleanup = "generated profile removed"; }
  catch { receipt.result = "failed"; receipt.profileCleanup = "generated profile retained"; receipt.profilePath = profile; process.exitCode = 1; }
 } else { receipt.result = "failed"; receipt.profileCleanup = bundleStopped ? "failed generated profile retained" : "owned process not confirmed stopped; generated profile retained"; receipt.profilePath = profile; process.exitCode = 1; }
 if (interrupted) { receipt.result = "failed"; receipt.failedStage ??= stage; process.exitCode = interrupted === "SIGINT" ? 130 : 143; }
 receipt.finishedAt = new Date().toISOString();
 receipt.fixtureProgress = { seedResponses, checks, seedEnabled };
 await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
 if (interrupted && receipt.result === "passed") {
  receipt.result = "failed"; receipt.failedStage ??= stage;
  await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
 }
}
if (receipt.result === "passed") console.log("Generated cookie persisted through two starts with encrypted rows under system-configured policy; system Keychain custody remains unverified.");
