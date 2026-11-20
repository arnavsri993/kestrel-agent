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

// Interactive canary: the owning operator uses real Cocoa panels, then creates
// the acknowledgement file named in live-state.json. No panel is mocked.
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
const evidence = resolve(process.env.KESTREL_NATIVE_MEMORY_EVIDENCE || `.tmp/native-memory-recovery-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use an empty evidence directory.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-memory-recovery-")));
const profile = join(temporary, "browser"), backup = join(temporary, "generated.kestrel-memory"), corrupt = join(temporary, "damaged.kestrel-memory");
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
async function selectScope(agentId) {
  // The wrapping label's accessible name includes its option text.
  await memory.locator(".memory-scope-controls select").first().selectOption(agentId);
  await expand("Agent knowledge and recovery");
  await expand("Knowledge backup and recovery");
  await memory.getByRole("button", { name: "Preview recovery", exact: true }).waitFor();
}
async function panel(stage, button, action, selectedPath) {
  const acknowledgement = join(evidence, `continue-${stage}`);
  await memory.getByRole("button", { name: button, exact: true }).click();
  await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage, action, selectedPath, acknowledgement, pid: running.child.pid, candidate: app, browserProfile: profile }, null, 2), { mode: 0o600 });
  console.log(`NATIVE_MEMORY_${stage.toUpperCase()} ${action}; acknowledge ${acknowledgement}`);
  await eventually(async () => { try { await access(acknowledgement); return true; } catch { return false; } }, `Operator did not acknowledge ${stage}.`, 10 * 60_000);
  await eventually(() => memory.getByRole("button", { name: button, exact: true }).isEnabled(), `Native panel ${stage} did not settle.`);
}
async function inspect(sessionId) { return (await request({ type: "memory-agent-inspect", sessionId, limit: 200 })).memoryAgentMemories; }
async function screenshot(name) {
  if (["knowledge-before-save", "knowledge-restored", "knowledge-after-restart"].includes(name)) {
    await memory.getByText("Generated native recovery fact survives restart.", { exact: true }).first().scrollIntoViewIfNeeded();
  } else if (name === "knowledge-explicit-restore-preview") {
    await memory.getByRole("region", { name: "Recovery preview" }).getByRole("button", { name: "Restore missing records", exact: true }).scrollIntoViewIfNeeded();
  }
  await memory.screenshot({ path: join(evidence, `${name}.png`) });
}

try {
  await start();
  const first = (await request({ type: "runtime-create-session", title: "Generated recovery scope", kind: "agent" })).session;
  const wrong = (await request({ type: "runtime-create-session", title: "Generated wrong scope", kind: "agent" })).session;
  const firstIdentity = (await request({ type: "memory-agent-inspect", sessionId: first.id })).memoryAgentIdentity;
  const wrongIdentity = (await request({ type: "memory-agent-inspect", sessionId: wrong.id })).memoryAgentIdentity;
  for (const input of [{ type: "memory-recovery-export", sessionId: first.id }, { type: "memory-recovery-preview", sessionId: first.id, encoded: "generated-non-secret-probe" }]) {
    const denied = await home.evaluate(input => window.kestrel.request(input), input);
    assert.equal(denied.ok, false, "Renderer must not export or preview raw recovery envelopes.");
    assert.equal("memoryRecoveryData" in denied, false); assert.equal("memoryRecoveryPreview" in denied, false);
  }
  phase("actual-renderer-bridge-refuses-raw-export-and-preview");
  await stop();
  const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
  const key = await readFile(join(profile, ".kestrel-native-test-core-key-v1"));
  const db = new KestrelDatabase(join(profile, "native-core/database/kestrel.sqlite"), key);
  const at = new Date().toISOString(), missingId = `agent-memory-${randomUUID()}`, keptId = `agent-memory-${randomUUID()}`;
  const fixture = { agentId: firstIdentity.id, kind: "fact", horizon: "long_term", sourceIds: ["generated-user-control"], taskIds: [], projectIds: [], personIds: [], entityIds: [], confidence: 1, importance: 0.75, sensitivity: "personal", status: "active", createdAt: at, updatedAt: at };
  try {
    db.upsertAgentMemory({ ...fixture, id: missingId, content: "Generated native recovery fact survives restart." });
    db.upsertAgentMemory({ ...fixture, id: keptId, content: "Generated native existing fact remains untouched." });
  } finally { db.close(); key.fill(0); }
  await start(); await openMemory(first.id);
  await memory.getByText("Generated native recovery fact survives restart.", { exact: true }).first().waitFor();
  await screenshot("knowledge-before-save");
  await panel("save-cancel", "Save encrypted backup", "Cancel the native Save panel");
  assert.equal(await memory.getByRole("status").filter({ hasText: "Encrypted knowledge backup saved." }).count(), 0);
  phase("actual-save-panel-cancel-no-success-notice");
  await panel("save", "Save encrypted backup", "Save to the exact generated filename", backup);
  await memory.getByRole("status").filter({ hasText: "Encrypted knowledge backup saved." }).waitFor();
  const saved = await readFile(backup), stat = await lstat(backup);
  assert.equal(stat.mode & 0o777, 0o600); assert(stat.isFile() && !stat.isSymbolicLink());
  assert(!saved.includes(Buffer.from("Generated native recovery fact")));
  await writeFile(corrupt, "generated intentionally damaged encrypted backup", { mode: 0o600 });
  phase("actual-save-panel-encrypted-file-private-mode");
  await panel("open-cancel", "Preview recovery", "Cancel the native Open panel");
  assert.equal(await memory.getByRole("region", { name: "Recovery preview" }).count(), 0);
  phase("actual-open-panel-cancel-no-preview");
  await panel("preview-existing", "Preview recovery", "Open the generated valid backup", backup);
  const preview = memory.getByRole("region", { name: "Recovery preview" });
  await preview.getByText(/0 missing records to restore; 2 existing records/).waitFor();
  assert.equal(await preview.getByRole("button", { name: "Restore missing records" }).isEnabled(), false);
  await preview.getByRole("button", { name: "Cancel preview" }).click();
  assert.equal(await preview.count(), 0); assert.equal((await inspect(first.id)).length, 2);
  phase("native-open-preview-existing-records-and-explicit-cancel");
  await selectScope(wrongIdentity.id);
  await panel("wrong-scope", "Preview recovery", "Open the generated valid backup in the wrong scope", backup);
  await memory.getByRole("alert").filter({ hasText: "The encrypted backup could not be previewed." }).waitFor();
  assert.equal((await inspect(wrong.id)).length, 0);
  await screenshot("knowledge-wrong-scope-refusal"); phase("actual-open-wrong-scope-refused-no-records");
  await selectScope(firstIdentity.id);
  await panel("corrupt", "Preview recovery", "Open the generated damaged backup", corrupt);
  await memory.getByRole("alert").filter({ hasText: "The encrypted backup could not be previewed." }).waitFor();
  assert.equal((await inspect(first.id)).length, 2);
  phase("actual-open-damaged-file-refused-no-record-change");
  const keptBefore = (await inspect(first.id)).find(record => record.id === keptId);
  assert(keptBefore);
  await request({ type: "memory-agent-forget", sessionId: first.id, id: missingId });
  assert(!(await inspect(first.id)).some(record => record.id === missingId));
  await panel("restore-preview", "Preview recovery", "Open the generated valid backup after deleting one generated fact", backup);
  await preview.getByText(/1 missing records to restore; 1 existing records/).waitFor();
  await screenshot("knowledge-explicit-restore-preview");
  await preview.getByRole("button", { name: "Restore missing records", exact: true }).click();
  await memory.getByRole("status").filter({ hasText: "Restored 1 records. Existing records were kept." }).waitFor();
  const restored = await inspect(first.id);
  assert.equal(restored.length, 2); assert(restored.some(record => record.id === missingId));
  assert.deepEqual(restored.find(record => record.id === keptId), keptBefore);
  assert.deepEqual(await readFile(backup), saved);
  await screenshot("knowledge-restored"); phase("explicit-restore-only-missing-record-existing-record-kept");
  await stop(); await start(); await openMemory(first.id);
  await memory.getByText("Generated native recovery fact survives restart.", { exact: true }).first().waitFor();
  assert.equal((await inspect(first.id)).length, 2); assert.equal((await inspect(wrong.id)).length, 0);
  await screenshot("knowledge-after-restart"); phase("restored-generated-knowledge-visible-after-real-native-restart");
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
