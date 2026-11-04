import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { loadRetainedStoreUpdateFixture } from "./native-store-update-profile.mjs";
import { loadStoreUpdateContinuation } from "./native-store-update-continuation.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select the exact native candidate.");
assert(process.env.KESTREL_NATIVE_STORE_UPDATE_CHECKPOINT, "Select an existing generated Store checkpoint.");
const compatibilityOnly = process.env.KESTREL_NATIVE_STORE_COMPATIBILITY_ONLY === "1";
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
const evidence = resolve(process.env.KESTREL_NATIVE_STORE_RESUME_EVIDENCE || `.tmp/native-store-resume-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a new evidence directory; preserve the original checkpoint.");
const fixture = await loadRetainedStoreUpdateFixture(process.env.KESTREL_NATIVE_STORE_UPDATE_CHECKPOINT);
const profile = fixture.profileRoot;
const processRows = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
assert(!processRows.some(row => row.includes(`--kestrel-cache-path ${profile}`)), "The retained profile is already in use.");
const formatter = "bcjindcccaagfpapjjmafapmmgkkhgoa", action = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const ids = [formatter, action];
const extensionId = [...createHash("sha256").update(join(profile, "kestrel-ui-bundle")).digest("hex").slice(0, 32)].map(digit => "abcdefghijklmnop"[parseInt(digit, 16)]).join("");
const homeUrl = `chrome-extension://${extensionId}/index.html`;
const receipt = { kind: "native-store-update-resume", version: 1, startedAt: new Date().toISOString(), candidate: app,
  mode: compatibilityOnly ? "compatibility-only" : "update-acceptance", updateQueryRequested: false,
  candidateSha256: await candidateDigest(app), fixture: { checkpoint: resolve(process.env.KESTREL_NATIVE_STORE_UPDATE_CHECKPOINT), receiptSha256: fixture.receiptSha256, originalCandidateSha256: fixture.candidateSha256 },
  scope: "Retained generated normal Store installations and test keys only. No new installation, forced version edits, real profile, Keychain, credentials or desktop capture/input.", phases: [] };
const continuation = process.env.KESTREL_NATIVE_STORE_PRIOR_ATTEMPT
  ? await loadStoreUpdateContinuation(process.env.KESTREL_NATIVE_STORE_PRIOR_ATTEMPT, {
    candidate: app, candidateSha256: receipt.candidateSha256,
    checkpoint: receipt.fixture.checkpoint, fixtureReceiptSha256: fixture.receiptSha256,
    actionExtensionId: action,
  }) : undefined;
assert(!continuation || !compatibilityOnly, "A prior update query cannot turn a compatibility run into update acceptance.");
if (continuation) receipt.continuation = { path: continuation.path, sha256: continuation.sha256,
  originalSessionCount: continuation.initialSessionCount };
let running, browser, home, actionDocumentId, actionDocumentUrl, interrupted = false, stage = "read-prelaunch-versions";
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; });
function phase(name, details = {}) { receipt.phases.push({ phase: name, passed: true, ...details }); console.log(`PASS ${name}`); }
function newer(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < 4; index++) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0); }
  return false;
}
async function eventually(fn, label, milliseconds = 30000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (interrupted) throw Error("Interrupted generated Store check."); try { const value = await fn(); if (value) return value; } catch { } await delay(150); }
  throw Error(label);
}
async function prelaunchVersions() {
  const records = [];
  for (const name of ["Preferences", "Secure Preferences"]) {
    const path = join(profile, "Default", name), info = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!info) continue;
    assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && info.size <= 8 * 1024 * 1024);
    const bytes = await readFile(path); assert(bytes.length <= 8 * 1024 * 1024);
    records.push(JSON.parse(bytes.toString("utf8")));
  }
  return Object.fromEntries(ids.map(id => {
    const versions = [...new Set(records.map(record => record.extensions?.settings?.[id]?.manifest?.version).filter(value => value !== undefined))];
    assert(versions.length === 1 && typeof versions[0] === "string" && /^\d+(?:\.\d+){0,3}$/.test(versions[0]), "Cannot establish the active on-disk Store version before launch.");
    return [id, versions[0]];
  }));
}
async function connectOwnedTargetTransport(endpoint) {
  const socket = new WebSocket(endpoint), pending = new Map(), attached = new Map(); let nextId = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data), waiter = pending.get(message.id);
    if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Error("Owned native target command failed.")); else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("Owned native target disconnected.")); } pending.clear(); });
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(Error("Owned native transport did not connect.")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); rejectOpen(Error("Owned native transport failed.")); }, { once: true });
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolveCommand, rejectCommand) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); rejectCommand(Error("Owned native target command timed out.")); }, 15000);
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); pending.delete(id); rejectCommand(Error("Owned native transport is unavailable.")); }
    });
  }
  async function attach(target) {
    if (attached.has(target.targetId)) return attached.get(target.targetId);
    const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const client = {
      async evaluate(fn, arg) {
        const result = await send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})`, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw Error("Owned target evaluation failed.");
        return result.result?.value;
      },
      async waitForFunction(fn, arg) { await eventually(async () => Boolean(await client.evaluate(fn, arg)), "Owned target condition did not become true."); },
      async screenshot({ path }) { const result = await send("Page.captureScreenshot", { format: "png" }, sessionId); await writeFile(path, Buffer.from(result.data, "base64"), { mode: 0o600 }); },
    };
    attached.set(target.targetId, client); return client;
  }
  return { send, attach, close() { socket.close(); } };
}
async function targets() { return (await browser.send("Target.getTargets")).targetInfos; }
async function pageFor(url) {
  // CEF may expose an already loaded document before Playwright auto-attachment.
  // Bind its actual browser-reported target rather than creating another tab.
  const target = await eventually(async () => (await targets()).find(item => item.type === "page" && item.url === url), "Owned native target missing.");
  return browser.attach(target);
}
async function start() {
  stage = "start-retained-profile:endpoint";
  const state = { output: "" };
  state.child = spawn(join(app, "Contents/MacOS/Kestrel"), ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], { stdio: ["ignore", "pipe", "pipe"] });
  running = state;
  state.exited = new Promise(resolveExit => state.child.once("exit", (code, signal) => resolveExit({ code, signal })));
  for (const stream of [state.child.stdout, state.child.stderr]) stream.on("data", chunk => { if (state.output.length < 512 * 1024) state.output += chunk; });
  state.endpoint = await eventually(() => state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1], "Retained native profile did not start.");
  stage = "start-retained-profile:connect";
  browser = await connectOwnedTargetTransport(state.endpoint);
  stage = "start-retained-profile:home-target";
  home = await pageFor(homeUrl);
  stage = "start-retained-profile:bridge";
  await home.waitForFunction(() => typeof window.kestrel?.request === "function");
  stage = "start-retained-profile:Core-sessions";
  const response = await home.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
  assert.equal(response.ok, true);
  return response.sessions.map(session => session.id).sort();
}
async function stop() {
  if (!running) return;
  await closeActionDocument();
  const state = running; running = undefined;
  if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGTERM");
  assert.deepEqual(await Promise.race([state.exited, delay(15000, undefined, { ref: false }).then(() => { state.child.kill("SIGKILL"); throw Error("Owned native shutdown timed out."); })]), { code: 0, signal: null });
  browser?.close(); browser = undefined; home = undefined;
}
async function closeActionDocument() {
  if (actionDocumentId !== undefined && home) await home.evaluate(async id => chrome.tabs.remove(id), actionDocumentId).catch(() => {});
  actionDocumentId = undefined; actionDocumentUrl = undefined;
}
async function provenance() {
  const entries = await home.evaluate(ids => Promise.all(ids.map(id => new Promise((resolveItem, rejectItem) => chrome.management.get(id, item => {
    if (chrome.runtime.lastError) rejectItem(Error("Store provenance unavailable."));
    else resolveItem({ id: item.id, version: item.version, enabled: item.enabled, installType: item.installType });
  })))), ids);
  for (const entry of entries) assert(entry.enabled && entry.installType === "normal" && /^\d+(?:\.\d+){0,3}$/.test(entry.version));
  return Object.fromEntries(entries.map(entry => [entry.id, entry]));
}
async function actionContext() {
  // Use the already installed extension's real options document. This exercises
  // its own tabs/runtime APIs without changing enablement or requiring its MV3
  // background worker to remain active indefinitely.
  if (!actionDocumentUrl) {
    const url = await home.evaluate(id => new Promise(resolveUrl => chrome.management.get(id, item => resolveUrl(chrome.runtime.lastError ? null : item.optionsUrl))), action);
    assert(typeof url === "string" && url.startsWith(`chrome-extension://${action}/`), "The installed action extension has no options document.");
    const created = await home.evaluate(async url => { const tab = await chrome.tabs.create({ url, active: false }); return { id: tab.id }; }, url);
    actionDocumentId = created.id; actionDocumentUrl = url;
  }
  const page = await pageFor(actionDocumentUrl);
  await page.waitForFunction(id => chrome.runtime?.id === id, action);
  assert.deepEqual(await page.evaluate(() => ({ bridge: typeof window.kestrel, nativeQuery: typeof window.__kestrelNativeQuery })), { bridge: "undefined", nativeQuery: "undefined" });
  receipt.actionDocumentUsed = true;
  return page;
}
const fixtureJson = { source: "kestrel-retained-store-resume", preservedInstall: true };
const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fixtureJson)); });
async function functionalProbe(name, userExtensionCreates = true) {
  stage = name + ":tab-creator";
  // A suspended background worker is normal after restart. The persistence
  // probe opens its JSON through Kestrel's own tab API; it does not require an
  // unrelated action extension to be running for the content extension to work.
  const creator = userExtensionCreates ? await actionContext() : home;
  const url = `http://127.0.0.1:${server.address().port}/fixture.json?phase=${name}`;
  const owningWindow = await home.evaluate(() => new Promise(resolveWindow => chrome.tabs.getCurrent(tab => resolveWindow(tab?.windowId))));
  const created = await creator.evaluate(async url => { const tab = await chrome.tabs.create({ url, active: true }); return { id: tab.id, windowId: tab.windowId }; }, url);
  assert(Number.isSafeInteger(created.id) && created.windowId === owningWindow);
  try {
    stage = name + ":attach-tab";
    const page = await pageFor(url);
    stage = name + ":formatted-content";
    await page.waitForFunction(() => window.json?.source === "kestrel-retained-store-resume");
    assert.deepEqual(await page.evaluate(() => ({ bridge: typeof window.kestrel, nativeQuery: typeof window.__kestrelNativeQuery })), { bridge: "undefined", nativeQuery: "undefined" });
    const adopted = await home.evaluate(() => window.kestrel.request({ type: "browser-get-state" }));
    assert(adopted.ok && adopted.browserState.tabs.some(tab => tab.url === url));
    await page.screenshot({ path: join(evidence, `${name}.png`) });
  } finally { await home.evaluate(async id => chrome.tabs.remove(id), created.id); }
  stage = name + ":close-tab";
  await eventually(async () => { const state = await home.evaluate(() => window.kestrel.request({ type: "browser-get-state" })); return state.ok && !state.browserState.tabs.some(tab => tab.url === url); }, "Extension-created tab did not close in Kestrel.");
  phase(name, { createdBy: userExtensionCreates ? "official-uBO-Lite-extension" : "Kestrel-first-party-tab-API" });
}
try {
  receipt.diskVersionsBefore = await prelaunchVersions();
  receipt.upgradeBaselineVersions = continuation?.baselineVersions ?? receipt.diskVersionsBefore;
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const sessions = await start(); receipt.initialSessionCount = sessions.length; receipt.initial = await provenance();
  receipt.initialSessionDigest = createHash("sha256").update(JSON.stringify(sessions)).digest("hex");
  if (continuation) assert(sessions.length >= continuation.initialSessionCount, "Retained Core session count fell below the prior attempt.");
  phase("current-candidate-opens-retained-normal-Store-profile-and-Core");
  await functionalProbe("retained-formatter-function-and-extension-owned-tab-isolation");
  receipt.updateCheck = continuation?.updateCheck ?? { status: "not_requested", reportedVersion: null, checkSucceeded: false };
  receipt.updateCheckSource = continuation ? "validated-prior-attempt" : "current-invocation";
  if (!compatibilityOnly && !continuation) {
    stage = "official-update-check";
    const extension = await actionContext();
    receipt.updateQueryRequested = true;
    receipt.updateCheck = await extension.evaluate(() => new Promise(resolveCheck => {
      const timer = setTimeout(() => resolveCheck({ status: "timeout" }), 30000);
      chrome.runtime.requestUpdateCheck((status, details) => { clearTimeout(timer); resolveCheck({ status, reportedVersion: details?.version ?? null }); });
    }));
    receipt.updateCheck.checkSucceeded = ["no_update", "update_available"].includes(receipt.updateCheck.status);
  }
  if (!compatibilityOnly && receipt.updateCheck.status === "update_available") {
    stage = "activate-published-update-after-clean-restart";
    assert(typeof receipt.updateCheck.reportedVersion === "string" && /^\d+(?:\.\d+){0,3}$/.test(receipt.updateCheck.reportedVersion));
    assert(newer(receipt.updateCheck.reportedVersion, receipt.upgradeBaselineVersions[action]), "The reported version must be newer than the immutable upgrade baseline.");
    // An open extension view can defer an ordinary Chrome update. Release the
    // view we opened and restart normally; do not reload, edit or reinstall it.
    await closeActionDocument();
    await stop();
    const activatedSessions = await start();
    assert(sessions.every(id => activatedSessions.includes(id)), "An original Core session was lost during update activation.");
    receipt.updateActivation = { method: "clean-browser-restart", missingOriginalSessions: 0 };
    await eventually(async () => (await provenance())[action].version === receipt.updateCheck.reportedVersion, "Reported Store update did not become active after clean restart.");
  }
  receipt.afterCheck = await provenance();
  for (const id of ids) for (const baseline of [receipt.upgradeBaselineVersions[id], receipt.diskVersionsBefore[id], receipt.initial[id].version])
    assert(!newer(baseline, receipt.afterCheck[id].version), "A normal Store installation was downgraded.");
  receipt.observedVersionUpgrade = ids.some(id => newer(receipt.afterCheck[id].version, receipt.upgradeBaselineVersions[id]));
  phase(compatibilityOnly ? "existing-normal-Store-installations-preserved-without-update-query" : "existing-normal-Store-installations-preserved-after-update-request");
  if (!compatibilityOnly && receipt.observedVersionUpgrade) await functionalProbe("updated-formatter-function-and-extension-owned-tab-isolation");
  await stop();
  const restartedSessions = await start();
  receipt.restartedSessionCount = restartedSessions.length;
  receipt.missingOriginalSessions = sessions.filter(id => !restartedSessions.includes(id)).length;
  assert.equal(receipt.missingOriginalSessions, 0, "An original retained Core session was lost.");
  receipt.afterRestart = await provenance();
  assert.deepEqual(receipt.afterRestart, receipt.afterCheck);
  await functionalProbe("retained-formatter-function-after-clean-restart", false);
  await stop(); phase("retained-Core-and-normal-Store-versions-survive-clean-restart");
  stage = "official-update-check-result";
  if (!compatibilityOnly) assert(receipt.updateCheck.checkSucceeded, "The official extension update query did not succeed.");
  // A compatibility-only run cannot certify upgrade acceptance, even if an
  // automatic version change happens while the retained profile is open.
  receipt.result = !compatibilityOnly && receipt.observedVersionUpgrade ? "passed" : "incomplete";
  if (receipt.result === "incomplete") {
    receipt.missing = [...(compatibilityOnly ? ["official-Store-update-query-not-requested"] : []),
      ...(receipt.observedVersionUpgrade ? [] : ["actual-published-Store-version-upgrade"])];
    process.exitCode = 2;
  }
} catch (error) {
  receipt.result = "failed"; receipt.failedStage = stage; receipt.error = interrupted ? "UI_CANARY_INTERRUPTED" : "Retained Store check failed at its recorded phase."; process.exitCode = 1;
  if (running) receipt.nativeState = { exitCode: running.child.exitCode, signal: running.child.signalCode,
    documentLoaded: running.output.includes("KESTREL_CHROMIUM_DESKTOP_DOCUMENT_LOADED"), bridgeReady: running.output.includes("KESTREL_CHROMIUM_DESKTOP_BRIDGE_READY") };
  if (browser) receipt.targetState = await targets().then(items => items.map(item => ({ type: item.type, home: item.url === homeUrl,
    protocol: new URL(item.url || "about:blank").protocol }))).catch(() => []);
}
finally {
  await stop().catch(() => { receipt.result = "failed"; process.exitCode = 1; });
  server.close();
  receipt.candidateSha256After = await candidateDigest(app);
  if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
  receipt.profileRetained = true; receipt.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
