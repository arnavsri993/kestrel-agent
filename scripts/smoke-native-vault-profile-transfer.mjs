#!/usr/bin/env node
// Generated-profile native-to-native transfer canary. Operator stages exercise
// the real native menu and dialogs; this is not a release gate or crash test.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { validateVaultCanaryCandidate } from "./native-vault-canary-candidate.mjs";
import { selectNativeBrowserFixtureStorage, prepareNativeBrowserFixtureProfile, nativeBrowserFixtureStorageArgs,
 nativeBrowserFixtureStorageEnv, captureNativeBrowserFixtureStorage, assertNativeBrowserFixtureStopped } from "./native-browser-fixture-storage.mjs";

assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT, "1", "Explicit generated-profile production-vault opt-in required.");
assert.equal(process.argv.length, 2, "This harness accepts no command-line arguments.");
assert(process.env.KESTREL_NATIVE_TEST_APP, "Set the exact disposable native candidate.");
assert(process.env.KESTREL_NATIVE_PROFILE_UI_EVIDENCE, "Set a fresh KESTREL_NATIVE_PROFILE_UI_EVIDENCE directory.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { candidate, executable } = await validateVaultCanaryCandidate(process.env.KESTREL_NATIVE_TEST_APP, { root });
const evidence = resolve(process.env.KESTREL_NATIVE_PROFILE_UI_EVIDENCE);
assert.equal(await realpath(dirname(evidence)).catch(() => dirname(evidence)), dirname(evidence), "Evidence parent must be canonical.");
await mkdir(evidence, { recursive: true, mode: 0o700 });
const evidenceInfo = await lstat(evidence);
assert.equal(await realpath(evidence), evidence);
assert(evidenceInfo.isDirectory() && !evidenceInfo.isSymbolicLink() && evidenceInfo.uid === process.getuid() && (evidenceInfo.mode & 0o777) === 0o700);
assert.equal((await readdir(evidence)).length, 0, "Evidence directory must be fresh and empty.");
const run = randomUUID().slice(0, 8), temp = await realpath(await mkdtemp(join(tmpdir(), "kestrel-vault-transfer-")));
const profiles = {}, descriptors = {}, fixtureEvidence = {};
const modalQuitRequested = process.env.KESTREL_TEST_NATIVE_TRANSFER_MODAL_QUIT === "1";
const receipt = { kind: "native-vault-profile-transfer-canary", version: 1, result: "failed", startedAt: new Date().toISOString(), candidate,
 candidateSha256: await candidateDigest(candidate), modalQuitRequested, phases: [], stages: [],
 scope: "Generated private temporary profiles, production local vaults, loopback CDP and operator-driven native menus/dialogs. No real profile, test key, provider credential, mock key, external fixture/provider request, Store, release gate or crash-recovery claim. Browser background network traffic is not measured." };
let running, browser, currentStage = "preflight", interrupted = false;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function eventually(fn, message, timeout = 30_000) {
 const until = Date.now() + timeout;
 while (Date.now() < until) { assert(!interrupted, "Harness interrupted."); try { const result = await fn(); if (result) return result; } catch (error) { if (error?.code === "ERR_ASSERTION") throw error; }
  await delay(150); }
 throw Error(message);
}
function assertNoCandidate() {
 const rows = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000 });
 for (const row of rows.split(/\r?\n/)) { const m = row.trim().match(/^\d+\s+(.+)$/); assert(!m || !m[1].startsWith(`${candidate}/`), "An owned candidate bundle process remains."); }
}
async function setup(name) {
 const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-chromium-desktop-canary-")));
 profiles[name] = profile;
 const storage = descriptors[name] = await selectNativeBrowserFixtureStorage({ candidate, root });
 assert.equal(storage.mode, "production-vault");
 await prepareNativeBrowserFixtureProfile({ profile, storage });
 return profile;
}
async function start(name) {
 const profile = profiles[name], storage = descriptors[name];
 assert(profile && storage); assertNoCandidate();
 assert.equal(await candidateDigest(candidate), receipt.candidateSha256);
 const env = nativeBrowserFixtureStorageEnv(storage);
 assert.equal(env.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY, "1", "Provider discovery must remain disabled for this local fixture.");
 assert(!Object.keys(env).some(key => /TOKEN|SECRET|COOKIE|API_KEY|AUTH/i.test(key) && !["PATH"].includes(key)), "Unexpected credential-like environment entry.");
 const args = ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--enable-automation", "--remote-debugging-port=0", ...nativeBrowserFixtureStorageArgs(storage)];
 assert(!args.some(arg => /test-profile-key|mock-keychain|real-keychain/i.test(arg)));
 const state = { output: "", name, profile };
 state.child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env });
 state.exited = new Promise(done => state.child.once("exit", (code, signal) => done({ code, signal })));
 for (const stream of [state.child.stdout, state.child.stderr]) stream.on("data", bytes => { state.output = (state.output + bytes).slice(-250_000); });
 running = state;
 receipt.stages.push({ stage: `start-${name}`, pid: state.child.pid, profile });
 const endpoint = await eventually(() => {
  assert(state.child.exitCode === null && state.child.signalCode === null, "Owned candidate exited on start.");
  assert(!state.output.includes("KESTREL_NATIVE_KEYCHAIN_POLICY selected=mock"), "Mock storage provider selected.");
  return state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
 }, "Native loopback CDP endpoint missing.", 60_000);
 state.endpoint = endpoint; browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 const command = await browser.newBrowserCDPSession();
 try {
  const { arguments: effective } = await command.send("Browser.getBrowserCommandLine");
  assert(Array.isArray(effective) && effective.includes("--kestrel-durable-profile"));
  assert(!effective.some(arg => /^--(?:use-mock-keychain|kestrel-real-keychain|kestrel-test-profile-key)(?:=|$)/.test(arg)), "Non-production storage switch present.");
 } finally { await command.detach(); }
 let home;
 await eventually(async () => {
  home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
  if (home) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send("Target.getTargets"); await session.detach();
  if (targets.targetInfos.some(item => /chrome-extension:\/\/[^/]+\/index\.html$/.test(item.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
  return false;
 }, "Native Home missing.");
 await home.waitForFunction(() => typeof window.kestrel?.request === "function");
 await home.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 await home.reload(); await home.locator(".kestrel-sidebar").waitFor();
 const subscriptions = await request(home, { type: "subscription-cli-status" });
 assert(Array.isArray(subscriptions.subscriptionClis) && subscriptions.subscriptionClis.length > 0);
 assert(subscriptions.subscriptionClis.every(item => !item.detected && !item.enabled && !item.path && !item.authenticated), "Provider discovery unexpectedly enabled.");
 return { state, home };
}
async function request(home, request) { const result = await home.evaluate(value => window.kestrel.request(value), request); assert.equal(result?.ok, true, `Native Core request failed: ${request.type}`); return result; }
async function stop() {
 if (!running) return;
 const current = running;
 await browser?.close().catch(() => {}); browser = undefined;
 if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGTERM");
 const outcome = await Promise.race([current.exited, delay(15_000).then(() => null)]);
 assert(outcome, "Owned candidate shutdown was not confirmed; fixture retained.");
 assert.deepEqual(outcome, { code: 0, signal: null }, "Owned candidate did not stop cleanly.");
 await eventually(() => {
  try { assertNativeBrowserFixtureStopped(descriptors[current.name]); assertNoCandidate(); return true; }
  catch (error) { if (/process is still running|bundle process remains/.test(error.message)) return false; throw error; }
 }, "Exact owned candidate process remains.", 10_000);
 running = undefined;
 fixtureEvidence[current.name] = await captureNativeBrowserFixtureStorage({ profile: current.profile, storage: descriptors[current.name] });
 receipt.stages.push({ stage: `clean-stop-${current.name}`, pid: current.child.pid, code: outcome.code, signal: outcome.signal });
}
async function snapshotSource(profile) {
 const current = await selection(profile);
 const selectedRoot = current.active ? join(profile, current.active) : profile;
 const roots = [...new Set([profile, selectedRoot])];
 const result = {};
 for (const base of roots) {
  for (const forbidden of [".kestrel-native-test-profile-v1", ".kestrel-native-test-core-key-v1", "native-core/database.key"])
   assert(!(await exists(join(base, forbidden))), "Generated production profile contains test-key material.");
  const prefix = base === profile ? "owner" : "active";
  for (const relative of [".kestrel-local-vault-v1", ".kestrel-desktop.lock", "workspace-grants.json", "native-core-profile.json",
   "native-core/workspace-grants.json", "native-core/database/kestrel.sqlite", "native-core/database/kestrel.sqlite-wal",
   "native-core/database/kestrel.sqlite-shm", "native-core/database/kestrel.sqlite-journal"]) {
   if (relative === "native-core-profile.json" && base !== profile) continue;
   const key = `${prefix}/${relative}`, path = join(base, relative);
   if (!(await exists(path))) { result[key] = null; continue; }
   const info = await lstat(path); assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1);
   if (relative === ".kestrel-desktop.lock") assert((info.mode & 0o777) === 0o600 && info.size === 0, "Native desktop coordination lock must remain empty and private.");
   result[key] = { mode: info.mode & 0o777, size: info.size, sha256: hash(await readFile(path)) };
  }
 }
 const parent = join(profile, "native-core-profiles");
 if (await exists(parent)) {
  result["native-core-profiles"] = []; result.reservations = {};
  for (const name of (await readdir(parent)).sort()) {
   const path = join(parent, name), info = await lstat(path);
   if (/^\.kestrel-profile-[a-f0-9]{64}\.lock$/.test(name)) {
    assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o7777) === 0o600 && info.size === 0,
     "Only an exact empty private native source-coordination lock is permitted.");
    result.reservations[name] = { dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, nlink: info.nlink, size: info.size }; continue;
   }
   assert(info.isDirectory() && !info.isSymbolicLink());
   result["native-core-profiles"].push(name);
  }
 } else { result["native-core-profiles"] = null; result.reservations = {}; }
 return result;
}
async function verifySourceUnchanged(profile, before) {
 const after = await snapshotSource(profile), { reservations: oldGuards, ...oldData } = before, { reservations: newGuards, ...newData } = after;
 assert.deepEqual(newData, oldData, "Native transfer changed source database, vault, selection, registry or unrelated profile children.");
 const selected = await selection(profile), activeRoot = selected.active ? join(profile, selected.active) : profile;
 const allowed = activeRoot === profile ? null : `.kestrel-profile-${hash(Buffer.from(activeRoot))}.lock`;
 for (const name of Object.keys(oldGuards)) assert.deepEqual(newGuards[name], oldGuards[name], "Existing source reservation metadata changed.");
 for (const name of Object.keys(newGuards)) assert(Object.hasOwn(oldGuards, name) || name === allowed, "An unrelated source coordination file was created.");
}
async function selection(profile) {
 let value;
 try { value = JSON.parse(await readFile(join(profile, "native-core-profile.json"), "utf8")); }
 catch (error) { if (error.code !== "ENOENT") throw error; value = { version: 2, active: "", previous: "", handoffs: { "": null } }; }
 for (const field of ["active", "previous"]) assert(typeof value[field] === "string" && (value[field] === "" || /^native-core-profiles\/[a-f0-9-]{36}$/i.test(value[field])));
 assert.equal(value.version, 2); assert(value.handoffs && typeof value.handoffs === "object" && !Array.isArray(value.handoffs));
 return value;
}
async function operator(name, instruction, metadata = {}) {
 const ack = join(evidence, `continue-${name}`), state = { stage: name, instruction, acknowledgement: ack, candidate,
  pid: running?.child.pid, ...metadata };
 await writeFile(join(evidence, `stage-${name}.json`), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
 console.log(`NATIVE_VAULT_TRANSFER_${name.toUpperCase().replaceAll("-", "_")} ${instruction}; acknowledge by creating ${ack}`);
 await eventually(() => exists(ack), `Operator acknowledgement missing for ${name}.`, 10 * 60_000);
}
async function beginNativeTransfer(owner, sourceProfile, label) {
 const { state } = owner;
 await operator(`${label}-choose-review`, `In the visible native app menu choose Kestrel > Transfer Conversations & Memory…, choose this exact source profile in the native folder picker, then stop at the transfer review without applying.`, { sourceProfile, ownerProfile: state.profile });
 await eventually(() => state.output.includes("KESTREL_NATIVE_CORE_TRANSFER_REVIEW_READY"), "Native transfer review did not appear.", 10 * 60_000);
}
async function applyNativeTransfer(owner, label, oldSelection, oldSnapshot, sourceProfile, liveSessionId, incomingSessionId) {
 const relative = await eventually(async () => {
  const now = await selection(owner.state.profile);
  if (!now.handoffs || typeof now.handoffs !== "object") return false;
  const added = Object.keys(now.handoffs).filter(key => !Object.hasOwn(oldSelection.handoffs ?? {}, key));
  if (added.length !== 1) return false;
  assert.deepEqual({ ...now, handoffs: oldSelection.handoffs ?? {} }, oldSelection, "Review changed selection fields other than registering exactly one prepared profile.");
  assert.match(added[0], /^native-core-profiles\/[a-f0-9-]{36}$/i);
  return added[0];
 }, "Native review did not register exactly one prepared destination.");
 const child = join(owner.state.profile, relative);
 assert.equal(await realpath(child), child); assert.deepEqual((await readdir(child)).sort(), ["native-core", ".kestrel-local-vault-v1", "native-transfer-source-v1.json"].sort(), "Prepared native child has an unexpected layout.");
 await verifySourceUnchanged(sourceProfile, oldSnapshot);
 assert.deepEqual(await selection(owner.state.profile), { ...oldSelection, handoffs: { ...(oldSelection.handoffs ?? {}), [relative]: (await selection(owner.state.profile)).handoffs[relative] } },
  "Selection must still point at the old live Core before Apply Transfer.");
 await operator(`${label}-apply`, "Review the visible native transfer summary. Confirm the source is closed checkbox, choose Apply Transfer, then dismiss the Transfer complete alert.", { ownerProfile: owner.state.profile, sourceProfile, destination: child });
 await eventually(() => owner.state.output.includes("KESTREL_NATIVE_CORE_TRANSFER_SELECTED"), "Native Apply Transfer did not complete and select its verified destination.", 10 * 60_000);
 const after = await selection(owner.state.profile);
 assert.equal(after.active, relative, "Transfer must select the imported child for the next launch.");
 assert.equal(after.previous, oldSelection.active ?? "", "Transfer must record the old selection for native rollback.");
 assert.equal(after.handoffs[relative], (await selection(owner.state.profile)).handoffs[relative]);
 const stillLive = await request(owner.home, { type: "runtime-list-sessions" });
 assert(stillLive.sessions.some(item => item.id === liveSessionId) && !stillLive.sessions.some(item => item.id === incomingSessionId),
  "The current app must remain on its old live Core until restart.");
 await verifySourceUnchanged(sourceProfile, oldSnapshot);
 return { relative, child, after };
}
async function previous(owner, label) {
 await operator(`${label}-rollback`, "Use the visible native menu Kestrel > Use Previous Data Profile…, confirm Use Previous Data Profile, then stop.", { ownerProfile: owner.profile });
 await eventually(() => owner.state.output.includes("KESTREL_NATIVE_CORE_PREVIOUS_SELECTED"), "Native previous-profile action was not confirmed.", 10 * 60_000);
 const selected = await selection(owner.profile); assert.equal(selected.active, "");
 return selected;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; process.exitCode = signal === "SIGINT" ? 130 : 143; });

try {
 currentStage = "seed-A"; const A = await setup("A"), a = await start("A");
 const aTitle = `Vault transfer A ${run}`, aText = `Generated A message ${run}`;
 const aSession = (await request(a.home, { type: "runtime-create-session", title: aTitle, kind: "conversation" })).session;
 assert(aSession?.id); await request(a.home, { type: "runtime-append-message", sessionId: aSession.id, role: "user", content: aText });
 assert((await request(a.home, { type: "runtime-list-messages", sessionId: aSession.id })).messages.some(item => item.content === aText));
 await stop(); const aRestart = await start("A");
 assert((await request(aRestart.home, { type: "runtime-list-messages", sessionId: aSession.id })).messages.some(item => item.content === aText));
 await stop(); const aBefore = await snapshotSource(A);
 receipt.sourceSnapshots = { A: aBefore };
 phase("A-production-vault-generated-session-restart-readback-and-snapshot");

 currentStage = "seed-B"; const B = await setup("B"), b = await start("B");
 const bTitle = `Vault transfer B original ${run}`;
 const bSession = (await request(b.home, { type: "runtime-create-session", title: bTitle, kind: "conversation" })).session; assert(bSession?.id);
 await stop(); const bOwnSnapshot = await snapshotSource(B); phase("B-production-vault-own-session-stopped-and-snapshotted");
 const oldBSelection = await selection(B), beforeA = await snapshotSource(A);
 currentStage = "B-import-A-review"; let bLive = await start("B");
 if (modalQuitRequested) {
  currentStage = "B-native-error-modal-quit";
  const invalidSource = join(temp,"invalid-source"); await mkdir(invalidSource,{mode:0o700});
  await operator("B-empty-source-error", "Choose Transfer Conversations & Memory in the native menu, select the exact empty generated folder, and leave the Profile unavailable alert open. The script will send SIGTERM while that alert is still open.",
   { invalidSource, ownerProfile: B, modalPresenceEvidence: "operator-observed-native-alert" });
  await stop();
  bLive = await start("B");
  assert((await request(bLive.home,{type:"runtime-list-sessions"})).sessions.some(item => item.id === bSession.id), "B's original Core session must survive clean Quit from the native error modal.");
  phase("operator-observed-native-error-modal-clean-SIGTERM-and-Core-restart");
 }
 currentStage = "B-import-A-review";
 await beginNativeTransfer(bLive, A, "B-import-A");
 const importedA = await applyNativeTransfer(bLive, "B-import-A", oldBSelection, beforeA, A, bSession.id, aSession.id);
 assert.equal((await selection(B)).active, importedA.relative); phase("native-UI-apply-selected-A-for-next-launch-with-B-still-live");
 await operator("B-restart-for-A", "The script will close the old B Core cleanly and reopen B so its selected imported A data becomes live.", { profile: B }); await stop();
 currentStage = "B-restart-A"; let bA = await start("B");
 let sessions = await request(bA.home, { type: "runtime-list-sessions" });
 assert(sessions.sessions.some(item => item.id === aSession.id) && !sessions.sessions.some(item => item.id === bSession.id), "Restarted B must show A and exclude B's previous own session.");
 let messages = await request(bA.home, { type: "runtime-list-messages", sessionId: aSession.id }); assert(messages.messages.some(item => item.content === aText));
 await stop(); phase("B-restart-readback-A-present-B-original-absent");

 currentStage = "append-child-only"; bA = await start("B");
 const childTitle = `Vault transfer B child only ${run}`, childText = `Generated B child-only message ${run}`;
 const childSession = (await request(bA.home, { type: "runtime-create-session", title: childTitle, kind: "conversation" })).session; assert(childSession?.id && childSession.id !== aSession.id);
 await request(bA.home, { type: "runtime-append-message", sessionId: childSession.id, role: "user", content: childText });
 await stop(); bA = await start("B");
 assert((await request(bA.home, { type: "runtime-list-messages", sessionId: childSession.id })).messages.some(item => item.content === childText));
 await stop(); phase("active-B-import-child-extended-and-read-after-restart");

 currentStage = "seed-C"; const C = await setup("C"), c = await start("C");
 const cTitle = `Vault transfer C original ${run}`;
 const cSession = (await request(c.home, { type: "runtime-create-session", title: cTitle, kind: "conversation" })).session; assert(cSession?.id);
 await stop(); const oldCSelection = await selection(C), beforeB = await snapshotSource(B);
 receipt.sourceSnapshots.B = beforeB;
 currentStage = "C-import-active-B-review"; const cLive = await start("C");
 await beginNativeTransfer(cLive, B, "C-import-active-B");
 const importedB = await applyNativeTransfer(cLive, "C-import-active-B", oldCSelection, beforeB, B, cSession.id, childSession.id);
 await operator("C-restart-for-B", "The script will close C cleanly and reopen C so its selected imported B profile becomes live.", { profile: C }); await stop();
 currentStage = "C-restart-B"; let cB = await start("C");
 sessions = await request(cB.home, { type: "runtime-list-sessions" });
 assert(sessions.sessions.some(item => item.id === aSession.id) && sessions.sessions.some(item => item.id === childSession.id) && !sessions.sessions.some(item => item.id === bSession.id) && !sessions.sessions.some(item => item.id === cSession.id), "C must contain A and B child-only data, excluding both own sessions and old B data.");
 messages = await request(cB.home, { type: "runtime-list-messages", sessionId: childSession.id }); assert(messages.messages.some(item => item.content === childText));
 await stop(); phase("C-restart-readback-proves-exact-active-B-child");

 currentStage = "rollback-C"; cB = await start("C"); await previous({ ...cB, profile: C }, "C"); await stop();
 currentStage = "verify-C-rollback"; const cRestored = await start("C");
 sessions = await request(cRestored.home, { type: "runtime-list-sessions" }); assert(sessions.sessions.some(item => item.id === cSession.id) && !sessions.sessions.some(item => item.id === aSession.id));
 await stop(); phase("C-native-previous-profile-rollback-verified-after-restart");

 currentStage = "rollback-B"; bA = await start("B"); await previous({ ...bA, profile: B }, "B"); await stop();
 currentStage = "verify-B-rollback"; const bRestored = await start("B");
 sessions = await request(bRestored.home, { type: "runtime-list-sessions" }); assert(sessions.sessions.some(item => item.id === bSession.id) && !sessions.sessions.some(item => item.id === aSession.id));
 await stop(); phase("B-native-previous-profile-rollback-verified-after-restart");
 await verifySourceUnchanged(A, aBefore); assert.notDeepEqual(bOwnSnapshot, await snapshotSource(B), "B's transfer history should be visible in its prepared profiles/selection.");
 receipt.result = "passed"; receipt.profileOwners = { A, B, C }; receipt.fixtureEvidence = fixtureEvidence;
} catch (error) {
 receipt.result = "failed"; receipt.failedStage = currentStage; receipt.error = String(error?.message || error).slice(0, 700);
 console.error(`Native production-vault profile transfer failed at ${currentStage}: ${receipt.error}`); process.exitCode ||= 1;
} finally {
 try { await stop(); } catch (error) { receipt.result = "failed"; receipt.shutdownError = String(error?.message || error); process.exitCode = 1; }
 try { receipt.candidateSha256After = await candidateDigest(candidate); if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; } } catch { receipt.result = "failed"; process.exitCode = 1; }
 try { assertNoCandidate(); receipt.exactCandidateAbsent = true; } catch { receipt.result = "failed"; receipt.exactCandidateAbsent = false; process.exitCode = 1; }
 receipt.fixtureEvidence = fixtureEvidence;
 receipt.finishedAt = new Date().toISOString();
 if (receipt.result === "passed" && !running) {
  for (const name of Object.keys(profiles)) await rm(profiles[name], { recursive: true });
  await rm(temp, { recursive: true, force: true }); receipt.generatedProfilesRemoved = true;
 } else { receipt.generatedProfilesRemoved = false; receipt.retainedProfiles = profiles; receipt.retainedTemporaryRoot = temp; }
 await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
