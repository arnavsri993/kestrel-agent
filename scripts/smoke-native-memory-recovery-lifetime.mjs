import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
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
const evidence = resolve(process.env.KESTREL_NATIVE_MEMORY_LIFETIME_EVIDENCE || `.tmp/native-memory-recovery-lifetime-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use an empty evidence directory.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-memory-recovery-lifetime-")));
const profile = join(temporary, "browser");
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), scope: "Generated disposable profile and test key only; actual Cocoa file panels. No real profile, Keychain or microphone.", phases: [] };
let running, browser, endpoint, home, memory, interrupted = false;
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
async function openMemory(sessionId) {
  await request({ type: "browser-create-tab", input: `kestrel://memory?scope=${sessionId}` });
  await eventually(async () => {
    memory = browser.contexts().flatMap(context => context.pages()).find(page => /index\.html\?app=memory(?:&|$)/.test(page.url()));
    if (memory) return true;
    // CEF can create a target after Playwright's auto-attachment pass. Reconnect
    // only to this owned child's endpoint; keep all product tabs open.
    const session = await browser.newBrowserCDPSession(); let targets;
    try { targets = await session.send("Target.getTargets"); } finally { await session.detach(); }
    if (targets.targetInfos.some(target => target.type === "page" && /index\.html\?app=memory(?:&|$)/.test(target.url))) {
      await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
      assert(home, "Owned Home must remain attached after reconnecting.");
    }
    return false;
  }, "Memory page did not open.");
  await memory.getByRole("navigation", { name: "Memory views", exact: true }).getByRole("button", { name: "Memory", exact: true }).click();
  await expand("Agent knowledge and recovery");
  await expand("Knowledge backup and recovery");
}
async function expand(label) {
  const summary = memory.locator("summary").filter({ hasText: new RegExp(`^${label}$`) });
  await summary.waitFor();
  if (!(await summary.evaluate(element => element.parentElement.open))) await summary.click();
}

async function inspect(sessionId) { return (await request({ type: "memory-agent-inspect", sessionId, limit: 200 })).memoryAgentMemories; }

async function operatorStage(stage, action) {
  const acknowledgement = join(evidence, `continue-${stage}`);
  await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage, action, acknowledgement, candidate: app, pid: running.child.pid, browserProfile: profile }, null, 2), { mode: 0o600 });
  console.log(`NATIVE_MEMORY_LIFETIME_${stage.toUpperCase()} ${action}; acknowledge ${acknowledgement}`);
  await eventually(async () => { try { await access(acknowledgement); return true; } catch { return false; } }, `Operator did not acknowledge ${stage}.`, 10 * 60_000);
}
async function generatedBackups(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await generatedBackups(path));
    else if (entry.name.endsWith(".kestrel-memory")) paths.push(path);
  }
  return paths;
}

try {
  await start();
  const session = (await request({ type: "runtime-create-session", title: "Generated recovery lifetime scope", kind: "agent" })).session;
  const identity = (await request({ type: "memory-agent-inspect", sessionId: session.id })).memoryAgentIdentity;
  assert.equal((await inspect(session.id)).length, 0);
  await openMemory(session.id);
  const requestingTab = await memory.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  assert(Number.isInteger(requestingTab), "Only the owned requesting tab may be closed.");
  await memory.getByRole("button", { name: "Save encrypted backup", exact: true }).click();
  await operatorStage("pending-close", "Observe the real Save encrypted knowledge backup panel. Leave it open, then acknowledge.");
  await home.evaluate(id => chrome.tabs.remove(id), requestingTab);
  await eventually(() => memory.isClosed(), "The owned requesting page did not close.");
  await operatorStage("page-closed", "Verify the native Save panel closed when its requesting page closed, then acknowledge.");
  await home.screenshot({ path: join(evidence, "requesting-page-closed.png") });
  assert.deepEqual(await generatedBackups(temporary), []);
  phase("real-save-panel-observed-then-owner-page-close-dismisses-with-no-file");

  await openMemory(session.id);
  await memory.getByRole("button", { name: "Save encrypted backup", exact: true }).click();
  await operatorStage("fresh-save-cancel", "Observe the fresh native Save panel, click Cancel, then acknowledge.");
  await eventually(() => memory.getByRole("button", { name: "Save encrypted backup", exact: true }).isEnabled(), "Fresh Save panel cancellation did not settle.");
  assert.equal(await memory.getByRole("status").filter({ hasText: "Encrypted knowledge backup saved." }).count(), 0);
  assert.equal(await memory.getByRole("alert").count(), 0);
  assert.deepEqual(await generatedBackups(temporary), []);
  assert.equal((await inspect(session.id)).length, 0);
  await memory.screenshot({ path: join(evidence, "fresh-save-cancelled.png") });
  phase("new-requesting-page-opens-real-save-panel-cancel-settles-no-file-or-mutation");

  // A small additional restart proof places the actual generated fact in view,
  // rather than relying on a screenshot of controls above the fold.
  await stop();
  const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
  const key = await readFile(join(profile, ".kestrel-native-test-core-key-v1"));
  const db = new KestrelDatabase(join(profile, "native-core/database/kestrel.sqlite"), key);
  const content = "Generated native recovery fact visible after restart.", at = new Date().toISOString();
  const id = `agent-memory-${randomUUID()}`;
  try {
    db.upsertAgentMemory({ id, agentId: identity.id, kind: "fact", horizon: "long_term", content,
      sourceIds: ["generated-user-control"], taskIds: [], projectIds: [], personIds: [], entityIds: [],
      confidence: 1, importance: 0.75, sensitivity: "personal", status: "active", createdAt: at, updatedAt: at });
  } finally { db.close(); key.fill(0); }
  await start(); await openMemory(session.id);
  const fact = memory.locator(".scoped-agent-memory summary").filter({ hasText: content });
  await fact.waitFor(); await fact.scrollIntoViewIfNeeded();
  assert((await inspect(session.id)).some(record => record.id === id && record.content === content));
  await memory.screenshot({ path: join(evidence, "generated-fact-visible-after-restart.png") });
  phase("generated-fact-in-viewport-after-real-owned-app-restart");
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
