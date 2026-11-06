import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

// A separate bounded lifetime canary. The operator observes real Cocoa panels
// and acknowledges the stages in live-state.json; no panel is mocked.
assert(process.env.KESTREL_NATIVE_TEST_APP, "Set the exact disposable native candidate.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
assert(app.endsWith(".app"), "Candidate must be an app bundle.");
const executable = await realpath(join(app, "Contents/MacOS/Kestrel"));
async function assertCandidateStopped() {
  for (const row of execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).split("\n")) {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !match[2].endsWith("/Contents/MacOS/Kestrel")) continue;
    const existing = await realpath(match[2]).catch(() => "");
    assert.notEqual(existing, executable, "The candidate is already running; this canary requires its own single instance.");
  }
}
await assertCandidateStopped();
const evidence = resolve(process.env.KESTREL_NATIVE_BACKUP_UI_EVIDENCE || `.tmp/native-backup-ui-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use an empty evidence directory.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-backup-ui-")));
const profile = join(temporary, "browser");
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), scope: "Generated disposable profile/key and actual Cocoa backup folder panels. No real profile, Keychain, microphone or desktop-control access.", phases: [] };
let running, browser, endpoint, home, readiness, interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  // Stop only this canary's owned app immediately, including while a panel or
  // Playwright assertion is pending. The finally block writes the receipt.
  if (running?.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGTERM");
});
async function eventually(fn, message, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (interrupted) throw Error("Interrupted generated-profile canary.");
    if (await fn()) return;
    await delay(100);
  }
  throw Error(message);
}
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function request(input) {
  const response = await home.evaluate(input => window.kestrel.request(input), input);
  assert.equal(response.ok, true, response.error); return response;
}
async function start() {
  await assertCandidateStopped();
  const state = { output: "" };
  state.child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], { stdio: ["ignore", "pipe", "pipe"] });
  state.exited = new Promise(resolveExit => state.child.once("exit", (code, signal) => resolveExit({ code, signal })));
  for (const stream of [state.child.stdout, state.child.stderr]) stream.on("data", bytes => { state.output += bytes; });
  running = state;
  endpoint = undefined;
  await eventually(() => { assert.equal(state.child.exitCode, null, "Owned native candidate exited."); endpoint = state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1]; return endpoint; }, "Owned native endpoint missing.");
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  await eventually(async () => {
    home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
    if (home) return true;
    const session = await browser.newBrowserCDPSession(); const targets = await session.send("Target.getTargets"); await session.detach();
    if (targets.targetInfos.some(target => /chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
    return false;
  }, "Native Home did not open.");
  await home.waitForFunction(() => typeof window.kestrel?.request === "function");
  await home.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
  await home.reload(); await home.locator(".kestrel-sidebar").waitFor();
}
async function stop() {
  if (!running) return;
  const current = running; running = undefined;
  if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGTERM");
  assert.deepEqual(await Promise.race([current.exited, delay(15000, undefined, { ref: false }).then(() => { current.child.kill("SIGKILL"); throw Error("Owned native shutdown timed out."); })]), { code: 0, signal: null });
  await browser?.close().catch(() => {}); browser = undefined;
}

async function openReadiness() {
  await request({ type: "browser-create-tab", input: "kestrel://readiness" });
  await eventually(async () => {
    readiness = browser.contexts().flatMap(context => context.pages()).find(page => /index\.html\?app=readiness(?:&|$)/.test(page.url()));
    if (readiness) return true;
    await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
    return false;
  }, "Owned Readiness did not attach.");
  await readiness.getByRole("heading", { name: "Readiness", exact: true }).waitFor();
  await readiness.locator(".loading-screen").waitFor({ state: "hidden" });
  await readiness.locator(".readiness-checks .check-pass").filter({ hasText: "Local agent core" }).waitFor();
  await readiness.getByRole("button", { name: "Choose backup folder", exact: true }).waitFor();
  await readiness.getByText("Requires this Mac’s original profile and Keychain.", { exact: false }).waitFor();
}
async function operatorStage(stage, action, selectedPath) {
  const acknowledgement = join(evidence, `continue-${stage}`);
  await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage, action, selectedPath, acknowledgement, candidate: app, pid: running.child.pid, browserProfile: profile }, null, 2), { mode: 0o600 });
  console.log(`NATIVE_BACKUP_${stage.toUpperCase()} ${action}; acknowledge ${acknowledgement}`);
  await eventually(async () => { try { await access(acknowledgement); return true; } catch { return false; } }, `Operator did not acknowledge ${stage}.`, 10 * 60_000);
}
const destination = join(temporary, "generated-backups");
await mkdir(destination, { mode: 0o700 });
try {
  await start();
  const created = await request({ type: "runtime-create-session", title: "GENERATED_NATIVE_BACKUP_SESSION", kind: "conversation" });
  assert(created.session?.id);
  await openReadiness();
  const choose = () => readiness.getByRole("button", { name: "Choose backup folder", exact: true });
  await choose().click();
  await operatorStage("cancel", "Cancel the real backup folder panel. If initial workspace activity is still busy, retry Choose backup folder after it settles.");
  await eventually(() => choose().isEnabled(), "Cancelled backup did not settle.");
  assert.equal(await readiness.locator(".backup-result").count(), 0);
  assert.equal(await readiness.getByRole("alert").count(), 0);
  assert.deepEqual(await readdir(destination), []);
  phase("actual-native-backup-folder-panel-cancel-no-error-or-files");

  await choose().click();
  await operatorStage("save", "Select the exact generated backup destination folder.", destination);
  await readiness.locator(".backup-result").waitFor();
  await eventually(() => choose().isEnabled(), "Backup did not finish and restart Core.");
  await eventually(async () => await readiness.getByRole("alert").count() === 0, "Temporary maintenance error remained after backup.");
  const names = await readdir(destination); assert.equal(names.length, 1); assert(names[0].startsWith("Kestrel-Native-Core-"));
  const backupPath = join(destination, names[0]); const manifestPath = join(backupPath, "kestrel-native-core-backup.json");
  const manifestBytes = await readFile(manifestPath); const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.format, "native-core-data"); assert.equal(manifest.version, 1);
  assert(manifest.files.some(file => file.path === "database/kestrel.sqlite"));
  const { createHash } = await import("node:crypto");
  for (const file of manifest.files) {
    assert(!file.path.startsWith("/") && !file.path.split("/").some(part => part === ".."));
    const path = join(backupPath, file.path); const bytes = await readFile(path); const info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1); assert.equal(info.mode & 0o777, 0o600);
    assert.equal(bytes.length, file.size); assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  assert.equal((await lstat(backupPath)).mode & 0o777, 0o700);
  await readiness.locator(".backup-result").scrollIntoViewIfNeeded();
  await readiness.screenshot({ path: join(evidence, "native-backup-created-visible.png") });
  const sessions = await request({ type: "runtime-list-sessions" }); assert(sessions.sessions.some(session => session.id === created.session.id));
  phase("actual-folder-selection-verified-files-visible-receipt-and-core-restart");

  await readiness.getByRole("button", { name: "Reveal in Finder", exact: true }).click();
  await operatorStage("reveal", "Verify Finder selected the generated Kestrel-Native-Core backup folder.", backupPath);
  assert.equal(await readiness.getByRole("alert").count(), 0);
  phase("actual-receipt-only-finder-reveal");

  const requestingTab = await readiness.evaluate(async () => (await chrome.tabs.getCurrent()).id); assert(Number.isInteger(requestingTab));
  await choose().click();
  await operatorStage("pending-close", "Observe the real backup folder panel; leave it open and acknowledge.");
  await home.evaluate(id => chrome.tabs.remove(id), requestingTab);
  await eventually(() => readiness.isClosed(), "Requesting Readiness page did not close.");
  await operatorStage("page-closed", "Verify the backup folder panel disappeared with its requesting page.");
  assert.deepEqual(await readdir(destination), names); await openReadiness(); assert(await choose().isEnabled());
  phase("actual-backup-panel-owner-close-cancels-and-new-readiness-page-works");

  await stop(); await start(); await openReadiness();
  assert.deepEqual(await readFile(manifestPath), manifestBytes);
  const afterRestart = await request({ type: "runtime-list-sessions" }); assert(afterRestart.sessions.some(session => session.id === created.session.id));
  await readiness.screenshot({ path: join(evidence, "native-backup-readiness-after-restart.png") });
  phase("generated-session-and-backup-preserved-after-full-native-restart");
  receipt.result = "passed";
} catch (error) { receipt.result = "failed"; receipt.error = interrupted ? "UI_CANARY_INTERRUPTED" : error.message; process.exitCode = 1; }
finally {
  await stop().catch(error => { receipt.result = "failed"; receipt.shutdownError = error.message; process.exitCode = 1; });
  await rm(temporary, { recursive: true, force: true });
  receipt.candidateSha256After = await candidateDigest(app);
  if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
