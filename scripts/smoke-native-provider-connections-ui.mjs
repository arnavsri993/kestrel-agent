import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";
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
const evidence = resolve(process.env.KESTREL_NATIVE_CONNECTIONS_UI_EVIDENCE || `.tmp/native-connections-ui-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use an empty evidence directory.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-connections-ui-")));
const profile = join(temporary, "browser");
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), scope: "Generated disposable profile/key and actual native Connections and protected external secret Settings. No real profile, Keychain, microphone or desktop-control access.", phases: [] };
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
  state.child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], { env: { ...process.env, KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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


async function createdPage(pattern) {
  let page;
  await eventually(async () => {
    page = browser.contexts().flatMap(context => context.pages()).find(item => pattern.test(item.url()));
    if (page) return true;
    await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url()));
    return false;
  }, "Owned native page did not attach.");
  await page.waitForFunction(() => typeof window.kestrel?.request === "function");
  await page.locator(".loading-screen").waitFor({ state: "hidden" }); return page;
}
async function openPrivacy() {
  await home.getByRole("button", { name: "Open settings", exact: true }).click();
  settings = await createdPage(/index\.html\?app=settings(?:&|$)/);
  await selectSettingsSection(settings, "agent-privacy", "Privacy and credentials");
  const external = settings.locator(".external-secret-setting"); await external.waitFor();
  const command = external.locator("details").filter({ has: settings.locator("summary b").filter({ hasText: /^Command helper$/ }) });
  if (!(await command.evaluate(element => element.open))) await command.locator("summary").click();
  await command.getByLabel("Executable path", { exact: true }).waitFor();
  return { external, command };
}
const helper = join(temporary, "generated-secret-helper");
const countFile = join(temporary, "helper-count");
const secret = "generated-native-connections-provider-key";
const nodeExecutable = join(app, "Contents/Resources/agent-core/node/bin/node");
await writeFile(helper, `#!${nodeExecutable}\nconst fs=require('node:fs'); let count=0;try{count=Number(fs.readFileSync(${JSON.stringify(countFile)},'utf8'))}catch{};fs.writeFileSync(${JSON.stringify(countFile)},String(count+1));process.stdout.write(${JSON.stringify(`OPENAI_API_KEY=${secret}\nUNRELATED_PRIVATE_VALUE=ignored-generated-value\n`)});\n`, { mode: 0o700 });
const count = async () => Number(await readFile(countFile, "utf8").catch(() => "0"));
try {
  await start();
  const created = await request({ type: "runtime-create-session", title: "GENERATED_NATIVE_CONNECTIONS_SESSION", kind: "conversation" }); assert(created.session?.id);
  const runtimeErrors = []; home.on("pageerror", error => runtimeErrors.push(error.message));
  let { external, command } = await openPrivacy();
  await command.getByLabel("Executable path", { exact: true }).fill(helper);
  await command.getByRole("checkbox", { name: "Run this exact executable at startup", exact: true }).check();
  await command.getByRole("button", { name: "Save configuration", exact: true }).click();
  await external.getByText("Command helper configuration saved. Sync to verify and apply it.", { exact: true }).waitFor();
  assert.equal(await count(), 0, "Saving configuration must not execute the helper.");
  phase("native-protected-settings-save-enabled-helper-without-execution");

  await command.getByRole("button", { name: "Sync and verify", exact: true }).click();
  await external.getByText(/Command helper verified/).waitFor();
  assert.equal(await count(), 1, "Explicit sync must execute the selected helper once.");
  await command.locator(".external-secret-state.verified").waitFor();
  const state = await settings.evaluate(() => window.kestrel.request({ type: "external-secret-list" })); assert.equal(state.ok, true);
  assert(!JSON.stringify(state).includes(secret)); assert(!JSON.stringify(state).includes("ignored-generated-value"));
  const configured = await settings.evaluate(() => window.kestrel.request({ type: "runtime-list-providers" })); assert.equal(configured.ok, true);
  assert(!JSON.stringify(configured).includes(secret));
  const htmlText = await settings.locator("body").innerText(); assert(!htmlText.includes(secret));
  await external.scrollIntoViewIfNeeded(); await settings.screenshot({ path: join(evidence, "native-external-source-verified.png") });
  phase("native-helper-sync-verified-once-core-restarted-and-no-secret-in-renderer");

  await stop(); await start(); ({ external, command } = await openPrivacy());
  assert.equal(await command.getByLabel("Executable path", { exact: true }).inputValue(), helper);
  assert(await command.getByRole("checkbox", { name: "Run this exact executable at startup", exact: true }).isChecked());
  assert.equal(await count(), 2, "One configured resolution is expected on full restart.");
  const restored = await request({ type: "runtime-list-sessions" }); assert(restored.sessions.some(session => session.id === created.session.id));
  await command.getByRole("button", { name: "Remove source", exact: true }).click();
  await external.getByText("Command helper configuration removed.", { exact: true }).waitFor();
  assert.equal(await count(), 2); assert.equal(await command.getByLabel("Executable path", { exact: true }).inputValue(), "");
  phase("native-configured-source-and-session-restart-persistence-then-removal-without-helper-replay");

  await request({ type: "browser-create-tab", input: "kestrel://connections" });
  const connections = await createdPage(/index\.html\?app=connections(?:&|$)/);
  const google = connections.locator(".oauth-connection").filter({ has: connections.locator("strong").filter({ hasText: /^Google Workspace$/ }) });
  await google.waitFor(); await google.getByLabel("Desktop OAuth client ID", { exact: true }).fill("invalid-generated-client");
  await google.getByRole("button", { name: /Connect|Sign in/ }).click();
  await google.getByRole("alert").filter({ hasText: "Enter a Google OAuth client ID created for a Desktop app." }).waitFor();
  const googleStatus = await request({ type: "oauth-google-status" }); assert.equal(googleStatus.googleWorkspaceOAuth.connected, false);
  const sources = await request({ type: "communication-sources" }); assert(sources.communicationSources.some(source => source.id === "mac-messages" && source.state === "unavailable"));
  assert(sources.communicationSources.some(source => source.id === "gmail" && source.state === "not_connected"));
  await google.scrollIntoViewIfNeeded(); await connections.screenshot({ path: join(evidence, "native-google-setup-validation.png") });
  phase("native-google-setup-and-static-client-validation-without-provider-network-or-account");
  assert.deepEqual(runtimeErrors, []);
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
