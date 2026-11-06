import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";
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
const evidence = resolve(process.env.KESTREL_NATIVE_DIAGNOSTIC_UI_EVIDENCE || `.tmp/native-diagnostic-ui-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use an empty evidence directory.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-diagnostic-ui-")));
const profile = join(temporary, "browser");
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), scope: "Generated disposable profile/key and actual Cocoa diagnostic Save panels. No real profile, Keychain, microphone or desktop-control access.", phases: [] };
let running, browser, endpoint, home, settings, interrupted = false;
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
async function openDiagnostics() {
  await home.getByRole("button", { name: "Open settings", exact: true }).click();
  await eventually(async () => {
    settings = browser.contexts().flatMap(context => context.pages()).find(page => /index\.html\?app=settings(?:&|$)/.test(page.url()));
    if (settings) return true;
    const session = await browser.newBrowserCDPSession(); let targets;
    try { targets = await session.send("Target.getTargets"); } finally { await session.detach(); }
    if (targets.targetInfos.some(target => target.type === "page" && /index\.html\?app=settings(?:&|$)/.test(target.url))) {
      await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
      assert(home, "Owned Home must remain attached.");
    }
    return false;
  }, "Owned Settings did not attach.");
  await settings.locator('[data-app-page="settings"]').waitFor();
  await selectSettingsSection(settings, "agent-diagnostics", "Diagnostics");
  await settings.getByRole("button", { name: "Export report", exact: true }).waitFor();
}
async function operatorStage(stage, action, selectedPath) {
  const acknowledgement = join(evidence, `continue-${stage}`);
  await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage, action, selectedPath, acknowledgement, candidate: app, pid: running.child.pid, browserProfile: profile }, null, 2), { mode: 0o600 });
  console.log(`NATIVE_DIAGNOSTIC_${stage.toUpperCase()} ${action}; acknowledge ${acknowledgement}`);
  await eventually(async () => { try { await access(acknowledgement); return true; } catch { return false; } }, `Operator did not acknowledge ${stage}.`, 10 * 60_000);
}
const reportPath = join(temporary, "generated-diagnostic.json");
const savedNotice = () => settings.getByRole("status").filter({ hasText: "Diagnostic report saved to the file you chose." });
try {
  await start();
  const created = await request({ type: "runtime-create-session", title: "GENERATED_DIAGNOSTIC_PRIVATE_TITLE", kind: "conversation" });
  assert(created.session?.id);
  await openDiagnostics();
  const exportButton = () => settings.getByRole("button", { name: "Export report", exact: true });
  await exportButton().click();
  await operatorStage("cancel", "Cancel the real diagnostic Save panel.");
  await eventually(() => exportButton().isEnabled(), "Cancelled diagnostic export did not settle.");
  assert.equal(await savedNotice().count(), 0);
  assert.equal(await settings.getByRole("alert").count(), 0);
  await assert.rejects(access(reportPath), error => error.code === "ENOENT");
  phase("actual-diagnostic-save-panel-cancel-no-success-or-file");

  await exportButton().click();
  await operatorStage("save", "Save the content-free diagnostic report to the exact generated filename.", reportPath);
  await savedNotice().waitFor(); await savedNotice().scrollIntoViewIfNeeded();
  const bytes = await readFile(reportPath); const report = JSON.parse(bytes.toString("utf8"));
  const info = await lstat(reportPath); assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1); assert.equal(info.mode & 0o777, 0o600);
  const allowed = new Set(["version", "generatedAt", "appVersion", "platform", "arch", "runtime", "node", "packaged", "distribution", "readinessSummary", "lastFailureClass", "lastFailureAt"]);
  assert(Object.keys(report).every(key => allowed.has(key)));
  assert.equal(report.runtime, "native-chromium"); assert.equal(report.platform, "darwin"); assert.equal(report.arch, "arm64");
  assert.equal(report.version, 1); assert.equal(report.packaged, true);
  assert.match(report.appVersion, /^\d+\.\d+\.\d+$/);
  assert(report.readinessSummary && ["pass", "warning", "fail"].every(key => Number.isInteger(report.readinessSummary[key])));
  assert(!bytes.includes(Buffer.from("GENERATED_DIAGNOSTIC_PRIVATE_TITLE")));
  assert(!bytes.includes(Buffer.from(temporary))); assert(!bytes.includes(Buffer.from("/Users/")));
  await settings.screenshot({ path: join(evidence, "diagnostic-saved-visible.png") });
  await writeFile(join(evidence, "generated-content-free-report.json"), bytes, { mode: 0o600 });
  phase("actual-native-save-private-content-free-report-and-visible-success-notice");

  const requestingTab = await settings.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  assert(Number.isInteger(requestingTab));
  await exportButton().click();
  await operatorStage("pending-close", "Observe the real diagnostic Save panel; leave it open and acknowledge.");
  await home.evaluate(id => chrome.tabs.remove(id), requestingTab);
  await eventually(() => settings.isClosed(), "Requesting Settings page did not close.");
  await operatorStage("page-closed", "Verify the diagnostic Save panel disappeared when its requesting Settings page closed.");
  assert.deepEqual(await readFile(reportPath), bytes);
  await openDiagnostics(); assert(await exportButton().isEnabled()); assert.equal(await savedNotice().count(), 0);
  phase("actual-diagnostic-panel-owner-close-and-fresh-settings-page");

  await stop(); await start(); await openDiagnostics();
  assert.deepEqual(await readFile(reportPath), bytes);
  const sessions = await request({ type: "runtime-list-sessions" }); assert(sessions.sessions.some(session => session.id === created.session.id));
  await settings.getByText("Health and diagnostic reports", { exact: true }).scrollIntoViewIfNeeded();
  await settings.screenshot({ path: join(evidence, "diagnostics-after-restart.png") });
  phase("native-settings-and-generated-core-session-after-full-restart");
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
