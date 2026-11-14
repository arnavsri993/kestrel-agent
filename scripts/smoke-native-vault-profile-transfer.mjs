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
 nativeBrowserFixtureStorageEnv, captureNativeBrowserFixtureStorage, assertNativeBrowserFixtureStopped,
 adoptRetainedNativeBrowserFixtureProfile } from "./native-browser-fixture-storage.mjs";
import { captureOwnedTransferProcesses, interruptOwnedPublishedTransfer } from "./native-vault-published-interruption.mjs";
import { loadNativeVaultRecoveryContinuation } from "./native-vault-recovery-continuation.mjs";

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
const publishedRecoveryRequested = process.env.KESTREL_TEST_NATIVE_TRANSFER_PUBLISHED_RECOVERY === "1";
const continuationPath = process.env.KESTREL_NATIVE_VAULT_RECOVERY_CONTINUATION;
const projectsRequested = process.env.KESTREL_TEST_NATIVE_TRANSFER_PROJECTS === "1";
assert(!continuationPath || publishedRecoveryRequested, "A continuation requires explicit published-recovery mode.");
assert(!(modalQuitRequested && publishedRecoveryRequested), "Run modal-Quit and published recovery separately.");
assert(!projectsRequested || !publishedRecoveryRequested, "Run project round-trip and published recovery separately.");
const receipt = { kind: publishedRecoveryRequested ? "native-vault-published-recovery-canary" : "native-vault-profile-transfer-canary", version: 1, result: "failed", startedAt: new Date().toISOString(), candidate,
 candidateSha256: await candidateDigest(candidate), modalQuitRequested, publishedRecoveryRequested, projectsRequested, phases: [], stages: [],
 scope: publishedRecoveryRequested
  ? "Generated production-vault profiles; actual owned parent-process SIGKILL after publication but before activation, native recovery choices, restart and rollback. No worker injection/signalling, source key export, real profile, provider, Store, release gate, mid-stage or power-loss recovery claim. Browser background network traffic is not measured."
  : "Generated private temporary profiles, production local vaults, loopback CDP and operator-driven native menus/dialogs. No real profile, test key, provider credential, mock key, external fixture/provider request, Store, release gate or crash-recovery claim. Browser background network traffic is not measured." };
let running, browser, currentStage = "preflight", interrupted = false;
let continuationLoaded = false;
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
 const checked = await validateVaultCanaryCandidate(candidate, { root });
 (receipt.executableAliasReviews ??= []).push({ stage: currentStage, ...checked.signingClones });
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
 state.home = home;
 await home.waitForFunction(() => typeof window.kestrel?.request === "function");
 await home.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 await home.reload(); await home.locator(".kestrel-sidebar").waitFor();
 const subscriptions = await request(home, { type: "subscription-cli-status" });
 assert(Array.isArray(subscriptions.subscriptionClis) && subscriptions.subscriptionClis.length > 0);
 assert(subscriptions.subscriptionClis.every(item => !item.detected && !item.enabled && !item.path && !item.authenticated), "Provider discovery unexpectedly enabled.");
 return { state, home };
}
async function request(home, request) { const result = await home.evaluate(value => window.kestrel.request(value), request); assert.equal(result?.ok, true, `Native Core request failed: ${request.type}`); return result; }
async function chooseGeneratedProjectFolder(home, label, folder, projectId) {
 // Keep the actual first-party request outstanding while the operator uses the
 // native picker. No fixture grant or picker result is injected into the host.
 const pending = home.evaluate(value => window.kestrel.request(value), projectId
  ? { type: "reconnect-workspace-project", projectId } : { type: "select-workspace-folder" })
  .then(result => ({ result }), error => ({ error }));
 await operator(label, "In the owned native folder picker choose only the generated folder, confirm it, then acknowledge.", { folder, projectId });
 const outcome = await pending; if (outcome.error) throw outcome.error;
 assert.equal(outcome.result?.ok, true); assert(!outcome.result.cancelled);
 const project = outcome.result.projects?.find(item => item.path === folder);
 assert(project?.available, "The generated folder must be chosen through the native picker.");
 return project;
}
async function assertPendingProject(home, project) {
 const metadata = await request(home, { type: "get-workspace-grants" });
 assert.deepEqual(metadata.projects, [], "Transferred paths must not become workspace grants.");
 assert.deepEqual(metadata.pendingWorkspaceProjects, [{ id: project.id, name: project.name }]);
}
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
   "native-core/workspace-grants.json", "native-core/pending-project-handoff.json", "native-core/database/kestrel.sqlite", "native-core/database/kestrel.sqlite-wal",
   "native-core/database/kestrel.sqlite-shm", "native-core/database/kestrel.sqlite-journal"]) {
   if (relative === "native-core-profile.json" && base !== profile) continue;
   const key = `${prefix}/${relative}`, path = join(base, relative);
   if (!(await exists(path))) { if (relative !== "native-core/pending-project-handoff.json") result[key] = null; continue; }
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
async function preparedNativeTransfer(owner, oldSelection, oldSnapshot, sourceProfile) {
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
 return { relative, child, reviewedSelection: await selection(owner.state.profile) };
}
async function applyNativeTransfer(owner, label, oldSelection, oldSnapshot, sourceProfile, liveSessionId, incomingSessionId) {
 const { relative, child } = await preparedNativeTransfer(owner, oldSelection, oldSnapshot, sourceProfile);
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
async function publishedRecovery(source, sourceSession, sourceText, sourceSnapshot) {
 currentStage = "seed-D-recovery";
 const D = await setup("D"), first = await start("D");
 const own = (await request(first.home, { type: "runtime-create-session", title: `Recovery D original ${run}`, kind: "conversation" })).session;
 assert(own?.id); await stop();
 const before = await selection(D); let live = await start("D");
 await beginNativeTransfer(live, source, "D-published");
 const prepared = await preparedNativeTransfer(live, before, sourceSnapshot, source);
 const database = join(prepared.child, "native-core/database/kestrel.sqlite");
 const journal = `${database}.kestrel-transfer-journal`, vault = join(prepared.child, ".kestrel-local-vault-v1");
 const vaultHash = hash(await readFile(vault));
 const ownership = captureOwnedTransferProcesses(live.state.child, { executable,
  workerExecutable: join(candidate, "Contents/Resources/agent-core/node/bin/node"),
  workerEntry: join(candidate, "Contents/Resources/agent-core/service/host-profile-project-transfer.js") });
 currentStage = "interrupt-D-after-publication";
 let armed;
 const watcherArmed = new Promise(resolve => { armed = resolve; });
 const interruption = interruptOwnedPublishedTransfer({ child: live.state.child, ownership, database,
  sourceDatabase: join(source, "native-core/database/kestrel.sqlite"), readSelection: () => selection(D),
  reviewedSelection: prepared.reviewedSelection, cancelled: () => interrupted, onArmed: armed }).then(async result => {
   await writeFile(join(evidence, "published-interruption.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
   console.log("NATIVE_VAULT_PUBLISHED_PARENT_INTERRUPTED"); return result;
  }).then(result => ({ result }), error => ({ error }));
 await Promise.race([watcherArmed, interruption.then(outcome => { throw outcome.error ?? Error("Interruption ended before its watch was armed."); })]);
 await operator("D-publish-and-interrupt", "Confirm the source-closed checkbox and Apply Transfer. The harness will interrupt only its own disposable app after publication, before activation. After the test window closes, acknowledge this stage.", { ownerProfile: D, destination: prepared.child });
 const interruptedResult = await interruption; if (interruptedResult.error) throw interruptedResult.error;
 const exit = await Promise.race([live.state.exited, delay(15_000).then(() => null)]);
 assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
 running = undefined; await browser?.close().catch(() => {}); browser = undefined;
 await eventually(() => { try { assertNativeBrowserFixtureStopped(descriptors.D); assertNoCandidate(); return true; } catch (error) {
  if (/process is still running|bundle process remains/.test(error.message)) return false; throw error;
 } }, "Interrupted app or an owned helper remains; preserve all generated profiles.", 20_000);
 assert.deepEqual(await selection(D), prepared.reviewedSelection);
 await verifySourceUnchanged(source, sourceSnapshot);
 const journalHash = hash(await readFile(journal));
 assert.equal(hash(await readFile(vault)), vaultHash);
 receipt.stages.push({ stage: "published-crash-D", pid: live.state.child.pid, ...exit, ...interruptedResult.result,
  preparedRelative: prepared.relative, reviewedSelection: prepared.reviewedSelection, journalSha256: journalHash, vaultSha256: vaultHash });
 phase("production-published-parent-crash-left-source-and-selection-preserved");
 await continuePublishedRecovery({ D, source, sourceSession, sourceText, sourceSnapshot, prepared, before,
  vaultHash, journalHash, originalId: own.id });
}
async function continuePublishedRecovery({ D, source, sourceSession, sourceText, sourceSnapshot, prepared,
 before, vaultHash, journalHash, originalId, originalTitle }) {
 const journal = join(prepared.child, "native-core/database/kestrel.sqlite.kestrel-transfer-journal");
 const vault = join(prepared.child, ".kestrel-local-vault-v1");
 assert.deepEqual(await selection(D), prepared.reviewedSelection);
 assert.equal(hash(await readFile(journal)), journalHash); assert.equal(hash(await readFile(vault)), vaultHash);
 await verifySourceUnchanged(source, sourceSnapshot);
 currentStage = "restart-D-after-crash"; let live = await start("D");
 if (!originalId) {
  const candidates = (await request(live.home, { type: "runtime-list-sessions" })).sessions.filter(row => row.title === originalTitle);
  assert.equal(candidates.length, 1, "Continuation must find the exact generated original conversation."); originalId = candidates[0].id;
 }
 const isSource = row => sourceSession.id ? row.id === sourceSession.id : row.title === sourceSession.title;
 const assertOriginal = async () => {
  const rows = (await request(live.home, { type: "runtime-list-sessions" })).sessions;
  assert(rows.some(row => row.id === originalId) && !rows.some(isSource));
 };
 await assertOriginal(); phase("crash-restart-keeps-original-Core-until-explicit-selection");
 async function reviewAndVerify(label) {
  currentStage = `${label}-review`;
  await operator(`${label}-review`, "Open Kestrel > Review Interrupted Transfers, review the only journal-bearing prepared profile, and stop at Recover this interrupted transfer without accepting.", { ownerProfile: D, destination: prepared.child });
  assert(live.state.output.includes("KESTREL_NATIVE_INTERRUPTED_TRANSFER_REVIEW_READY"));
  assert.deepEqual(await selection(D), prepared.reviewedSelection);
  currentStage = `${label}-verify`;
  await operator(`${label}-verify`, "Confirm the source-closed checkbox and Recover Transfer, accept the separate project-link review, then stop at Recovered transfer verified without choosing a data profile.", { ownerProfile: D, destination: prepared.child });
  for (const marker of ["KESTREL_NATIVE_INTERRUPTED_TRANSFER_WORKER_STOPPED", "KESTREL_NATIVE_INTERRUPTED_TRANSFER_RECOVERED", "KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTION_READY"])
   assert(live.state.output.includes(marker), `Missing native recovery marker ${marker}.`);
  assert.deepEqual(await selection(D), prepared.reviewedSelection);
  assert.equal(hash(await readFile(journal)), journalHash); assert.equal(hash(await readFile(vault)), vaultHash);
  await verifySourceUnchanged(source, sourceSnapshot);
 }
 await reviewAndVerify("D-first-recovery");
 phase("native-production-recovery-authenticates-without-activation-or-key-export");
 await operator("D-keep-current", "Choose Keep Current Profile in the recovered-transfer choice.", { ownerProfile: D });
 assert.deepEqual(await selection(D), prepared.reviewedSelection); await assertOriginal();
 await stop(); live = await start("D"); await assertOriginal();
 assert.equal(hash(await readFile(journal)), journalHash); assert.equal(hash(await readFile(vault)), vaultHash);
 phase("keep-current-survives-restart-with-recovery-journal-preserved");
 await reviewAndVerify("D-second-recovery");
 phase("published-transfer-rediscovered-and-reverified-after-restart");
 await operator("D-use-recovered", "Choose Use Recovered Data Profile and dismiss its restart notice.", { ownerProfile: D });
 assert(live.state.output.includes("KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTED"));
 assert.deepEqual(await selection(D), { ...prepared.reviewedSelection, active: prepared.relative, previous: before.active });
 await assertOriginal(); await stop();
 currentStage = "restart-D-recovered"; live = await start("D");
 const rows = (await request(live.home, { type: "runtime-list-sessions" })).sessions;
 const imported = rows.filter(isSource); assert.equal(imported.length, 1);
 assert(!rows.some(row => row.id === originalId));
 assert((await request(live.home, { type: "runtime-list-messages", sessionId: imported[0].id })).messages.some(row => row.content === sourceText));
 phase("explicit-recovered-selection-and-message-readback-after-restart");
 await previous({ ...live, profile: D }, "D"); await stop();
 currentStage = "restart-D-rollback"; live = await start("D"); await assertOriginal(); await stop();
 await verifySourceUnchanged(source, sourceSnapshot);
 phase("recovered-production-profile-native-rollback-readback");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; process.exitCode = signal === "SIGINT" ? 130 : 143; });

try {
 if (continuationPath) {
  currentStage = "validate-published-recovery-continuation";
  const loaded = await loadNativeVaultRecoveryContinuation(continuationPath, { candidateSha256: receipt.candidateSha256 });
  continuationLoaded = true;
  receipt.kind = "native-vault-published-recovery-continuation-canary";
  receipt.continuation = { path: loaded.path, sha256: loaded.sha256, failedReceiptSha256: loaded.failedReceiptSha256,
   interruptionSha256: loaded.interruptionSha256, originalCandidate: loaded.failedReceipt.candidate, witnessOrigin: loaded.witnessOrigin };
  receipt.scope += " Continuation uses a fully validated byte-identical private candidate copy; the original failed receipt is unchanged. This does not prove same-path restart or resolve the original executable's extra hard link.";
  for (const [name, profile] of Object.entries({ A: loaded.sourceProfile, D: loaded.ownerProfile })) {
   const storage = await selectNativeBrowserFixtureStorage({ candidate, root });
   await adoptRetainedNativeBrowserFixtureProfile({ profile, storage, evidence: loaded.fixtureEvidence[name], originalCandidate: loaded.failedReceipt.candidate });
   profiles[name] = profile; descriptors[name] = storage;
  }
  receipt.sourceSnapshots = { A: loaded.sourceSnapshot };
  phase("validated-failed-run-continuation-and-identical-candidate-copy");
  await continuePublishedRecovery({ D: loaded.ownerProfile, source: loaded.sourceProfile,
   sourceSession: { title: loaded.sourceExpectation.title }, sourceText: loaded.sourceExpectation.message,
   sourceSnapshot: loaded.sourceSnapshot, prepared: loaded.prepared, before: loaded.prepared.reviewedSelection,
   vaultHash: loaded.spec.vaultSha256, journalHash: loaded.spec.journalSha256, originalTitle: loaded.originalTitle });
 } else {
 currentStage = "seed-A"; const A = await setup("A"), a = await start("A");
 let sourceProject;
 if (projectsRequested) {
  currentStage = "A-project-folder";
  const folder = join(temp, "generated-source-project"); await mkdir(folder, { mode: 0o700 });
  const chosen = await chooseGeneratedProjectFolder(a.home, "A-project-folder", folder);
  const name = `Transferred project ${run}`, instructions = `Generated project instructions ${run}.\nPreserve this second line.`;
  const updated = await request(a.home, { type: "project-update", projectId: chosen.id, name, instructions });
  sourceProject = updated.projects?.find(item => item.id === chosen.id);
  assert.equal(sourceProject?.name, name); assert.equal(sourceProject?.instructions, instructions);
  receipt.projectExpectation = sourceProject;
  phase("native-folder-choice-and-generated-project-metadata");
 }
 const aTitle = `Vault transfer A ${run}`, aText = `Generated A message ${run}`;
 const aSession = (await request(a.home, { type: "runtime-create-session", title: aTitle, kind: "conversation",
  ...(sourceProject ? { projectId: sourceProject.id, workspaceRoot: sourceProject.path } : {}) })).session;
 assert(aSession?.id); await request(a.home, { type: "runtime-append-message", sessionId: aSession.id, role: "user", content: aText });
 assert((await request(a.home, { type: "runtime-list-messages", sessionId: aSession.id })).messages.some(item => item.content === aText));
 await stop(); const aRestart = await start("A");
 assert((await request(aRestart.home, { type: "runtime-list-messages", sessionId: aSession.id })).messages.some(item => item.content === aText));
 await stop(); const aBefore = await snapshotSource(A);
 receipt.sourceSnapshots = { A: aBefore };
 phase("A-production-vault-generated-session-restart-readback-and-snapshot");
 if (publishedRecoveryRequested) {
  await publishedRecovery(A, aSession, aText, aBefore);
 } else {
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
 if (sourceProject) { await assertPendingProject(bA.home, sourceProject); phase("first-transfer-preserves-pending-project-without-folder-authority"); }
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
 if (sourceProject) {
  await assertPendingProject(cB.home, sourceProject);
  const folder = join(temp, "generated-reconnected-project"); await mkdir(folder, { mode: 0o700 });
  currentStage = "C-reconnect-transferred-project";
  const reconnected = await chooseGeneratedProjectFolder(cB.home, "C-reconnect-transferred-project", folder, sourceProject.id);
  for (const field of ["id", "name", "instructions", "createdAt", "updatedAt"]) assert.equal(reconnected[field], sourceProject[field], `Repeated transfer lost project ${field}.`);
  assert.notEqual(reconnected.path, sourceProject.path);
  phase("second-transfer-preserves-project-metadata-and-reconnects-only-native-choice");
 }
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
 }
 }
 receipt.result = "passed"; receipt.profileOwners = { ...profiles }; receipt.fixtureEvidence = fixtureEvidence;
} catch (error) {
 receipt.result = "failed"; receipt.failedStage = currentStage; receipt.error = String(error?.message || error).slice(0, 700);
 if (running) {
  await writeFile(join(evidence, "failure-native-output.log"), running.output, { mode: 0o600, flag: "wx" });
  const file = await lstat(executable).catch(() => null);
  receipt.failedProcess = { pid: running.child.pid, executableLinkCount: file?.nlink, exited: running.child.exitCode, signal: running.child.signalCode };
 }
 console.error(`Native production-vault profile transfer failed at ${currentStage}: ${receipt.error}`); process.exitCode ||= 1;
} finally {
 try { await stop(); } catch (error) { receipt.result = "failed"; receipt.shutdownError = String(error?.message || error); process.exitCode = 1; }
 try { receipt.candidateSha256After = await candidateDigest(candidate); if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; } } catch { receipt.result = "failed"; process.exitCode = 1; }
 try { assertNoCandidate(); receipt.exactCandidateAbsent = true; } catch { receipt.result = "failed"; receipt.exactCandidateAbsent = false; process.exitCode = 1; }
 receipt.fixtureEvidence = fixtureEvidence;
 receipt.finishedAt = new Date().toISOString();
 if (receipt.result === "passed" && !running && !continuationLoaded) {
  for (const name of Object.keys(profiles)) await rm(profiles[name], { recursive: true });
  await rm(temp, { recursive: true, force: true }); receipt.generatedProfilesRemoved = true;
 } else { receipt.generatedProfilesRemoved = false; receipt.retainedProfiles = profiles; receipt.retainedTemporaryRoot = temp; }
 await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
