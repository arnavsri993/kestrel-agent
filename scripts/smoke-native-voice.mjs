import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

// The harness never attaches to the installed app, an existing process, or a
// real profile. Default mode intercepts both media APIs before the UI loads.
assert(process.env.KESTREL_NATIVE_TEST_APP, "Set KESTREL_NATIVE_TEST_APP to the exact disposable candidate.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(app.endsWith(".app"));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
const executable = join(app, "Contents/MacOS/Kestrel");
await readFile(executable);
const executableReal = await realpath(executable);
for (const row of execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).split("\n")) {
 const match = row.trim().match(/^(\d+)\s+(.+)$/);
 if (match && match[2].endsWith("/Contents/MacOS/Kestrel"))
  assert.notEqual(await realpath(match[2]).catch(() => ""), executableReal, "Candidate is already running.");
}
const evidence = resolve(process.env.KESTREL_NATIVE_VOICE_EVIDENCE || `.tmp/native-voice-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Evidence directory must be empty.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-voice-")));
const profile = join(temporary, "profile");
await mkdir(profile, { mode: 0o700 });
await markDisposableNativeTestProfile(profile);
const realCapture = process.env.KESTREL_TEST_NATIVE_MICROPHONE_CAPTURE === "1";
const interruptFixture = process.env.KESTREL_TEST_NATIVE_VOICE_INTERRUPT === "1";
assert(!(realCapture && interruptFixture), "The interruption fixture cannot enable real capture.");
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app,
 candidateSha256: await candidateDigest(app), mode: realCapture ? "mock-and-explicit-real-capture" : "mock-only", phases: [] };
let child, exited, browser, endpoint, home, output = "", operation = "launch";
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
 interrupted = true;
 // Do not wait for evaluate(), a media promise, or a human permission prompt.
 // Every page and the process belong to this fresh disposable candidate.
 for (const context of browser?.contexts() || [])
  for (const page of context.pages()) void page.close().catch(() => {});
 if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
});
function phase(name, details = {}) { operation = name; receipt.phases.push({ phase: name, passed: true, ...details }); console.log(`PASS ${name}`); }
async function eventually(fn, description, timeout = 30000) {
 const end = Date.now() + timeout; let last;
 while (Date.now() < end) {
  if (interrupted) throw Error("Canary interrupted.");
  try { last = await fn(); if (last) return last; } catch (error) { last = error; }
  await delay(100);
 }
 throw Error(`${description}: ${last instanceof Error ? last.message : String(last)}`);
}
async function connectPage(predicate) {
 return eventually(async () => {
  let found = browser.contexts().flatMap(context => context.pages()).find(page => predicate(page.url()));
  if (found) return found;
  const session = await browser.newBrowserCDPSession();
  const targets = await session.send("Target.getTargets"); await session.detach();
  if (targets.targetInfos.some(target => target.type === "page" && predicate(target.url))) {
   await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
   for (const context of browser.contexts()) context.setDefaultTimeout(30000);
   found = browser.contexts().flatMap(context => context.pages()).find(page => predicate(page.url()));
  }
  return found;
 }, "Owned first-party page unavailable");
}
async function stop() {
 if (!child) return;
 if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
 const result = await Promise.race([exited, delay(15000).then(() => null)]);
 if (!result) { child.kill("SIGKILL"); await exited; throw Error("Owned candidate shutdown timed out."); }
 assert.deepEqual(result, { code: 0, signal: null }, "Owned candidate did not exit cleanly.");
 await browser?.close().catch(() => {}); browser = undefined; child = undefined;
}
try {
 child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], { stdio: ["ignore", "pipe", "pipe"] });
 exited = new Promise(done => child.once("exit", (code, signal) => done({ code, signal })));
 child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
 endpoint = await eventually(() => {
  assert.equal(child.exitCode, null, "Candidate exited during launch.");
  return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
 }, "Owned DevTools endpoint missing");
 await eventually(() => output.includes("KESTREL_CHROMIUM_DESKTOP_DOCUMENT_LOADED") && output.includes("KESTREL_CHROMIUM_DESKTOP_BRIDGE_READY"), "Native document and bridge not ready");
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 for (const context of browser.contexts()) context.setDefaultTimeout(30000);
 home = await connectPage(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 const uiUrl = home.url();
 await home.waitForFunction(() => typeof window.kestrel?.request === "function");
 await home.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 // The fake port is installed on this owned page only. It intercepts microphone
 // permission and transcription messages before they can reach the worker;
 // all other calls are forwarded to the real native bridge.
 await home.addInitScript((expectedUrl) => {
  if (location.href !== expectedUrl || top !== window) return;
  const state = window.__voiceFixture = { permission: 0, streams: 0, recorderStarts: 0, transcriptions: 0, tracksStopped: 0, fakeState: false, lastState: null, permissionResolve: null, streamResolve: null, mode: "permission", callbacks: [] };
  const connect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = options => {
   const actual = connect(options);
   if (options?.name !== "kestrel-ui") return actual;
   state.portWrapped = true;
   const listeners = [];
   actual.onMessage.addListener(message => {
    if (message?.kind === "event" && message.channel === "browser-event" && message.event?.type === "state") {
     state.lastState = structuredClone(message.event.state);
     if (state.fakeState) return;
    }
    if (message?.kind === "response" && message.response?.browserState) state.lastState = structuredClone(message.response.browserState);
    for (const listener of listeners) listener(message);
   });
   state.callbacks = listeners;
   return { onMessage: { addListener: cb => listeners.push(cb) }, onDisconnect: actual.onDisconnect,
    postMessage(message) {
     if (message?.request?.type === "request-microphone-access") {
      state.permission++;
      if (state.mode === "permission") state.permissionResolve = () => listeners.forEach(cb => cb({ kind: "response", id: message.id, response: { ok: true, microphoneAccess: true } }));
      else queueMicrotask(() => listeners.forEach(cb => cb({ kind: "response", id: message.id, response: { ok: true, microphoneAccess: true } })));
      return;
     }
     if (message?.request?.type === "media-transcribe") { state.transcriptions++; throw Error("Fixture blocked transcription."); }
     actual.postMessage(message);
    } };
  };
  const media = navigator.mediaDevices || {};
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
  const fakeGetUserMedia = () => {
   state.streams++;
   return new Promise(resolveStream => { state.streamResolve = () => resolveStream({ getTracks: () => [{ stop() { state.tracksStopped++; } }] }); });
  };
  Object.defineProperty(media, "getUserMedia", { configurable: true, value: fakeGetUserMedia });
  state.mediaGuarded = media.getUserMedia === fakeGetUserMedia;
  window.MediaRecorder = class {
   static isTypeSupported() { return true; }
   constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
   start() { state.recorderStarts++; this.state = "recording"; }
   stop() { this.state = "inactive"; this.onstop?.(); }
  };
  state.navigateHomeFixture = away => {
   if (!state.lastState) throw Error("No first-party browser state received.");
   const copy = structuredClone(state.lastState);
   const tab = copy.tabs.find(t => t.id === copy.activeTabId);
   if (!tab) throw Error("No active Home tab in fixture state.");
   if (away) tab.url = "kestrel://settings";
   state.fakeState = away;
   for (const cb of state.callbacks) cb({ kind: "event", channel: "browser-event", event: { type: "state", state: copy } });
  };
 }, uiUrl);
 await home.reload();
 await home.locator(".kestrel-sidebar").waitFor();
 await home.waitForFunction(() => !!window.__voiceFixture?.portWrapped && !!window.__voiceFixture?.mediaGuarded && !!window.__voiceFixture.lastState);
 const expand = home.getByRole("button", { name: "Expand sidebar", exact: true });
 if (await expand.isVisible()) await expand.click();
 const sessions = await home.evaluate(async () => {
  const first = await window.kestrel.request({ type: "runtime-create-session", title: "Voice canary alpha", kind: "conversation" });
  const second = await window.kestrel.request({ type: "runtime-create-session", title: "Voice canary beta", kind: "conversation" });
  return [first, second];
 });
 assert(sessions.every(item => item.ok && item.session?.id));
 // Reload so the native renderer obtains the two fixture sessions normally.
 await home.reload(); await home.locator(".kestrel-sidebar").waitFor();
 await home.waitForFunction(() => !!window.__voiceFixture?.portWrapped && !!window.__voiceFixture?.mediaGuarded && !!window.__voiceFixture.lastState);
 const expandAgain = home.getByRole("button", { name: "Expand sidebar", exact: true });
 if (await expandAgain.isVisible()) await expandAgain.click();
 async function startTwice(button, mode) {
  await home.evaluate(mode => { window.__voiceFixture.mode = mode; }, mode);
  const before = await home.evaluate(() => ({ p: window.__voiceFixture.permission, s: window.__voiceFixture.streams, stopped: window.__voiceFixture.tracksStopped }));
  await button.waitFor({ state: "visible" });
  await button.evaluate(el => { el.click(); el.click(); });
  await home.waitForFunction(p => window.__voiceFixture.permission === p + 1, before.p);
  if (mode === "stream") await home.waitForFunction(s => window.__voiceFixture.streams === s + 1, before.s);
  return before;
 }
 async function verifyLate(before, mode) {
  await home.evaluate(mode => { const f = window.__voiceFixture; (mode === "permission" ? f.permissionResolve : f.streamResolve)(); }, mode);
  if (mode === "stream") await home.waitForFunction(n => window.__voiceFixture.tracksStopped === n + 1, before.stopped);
  await delay(250);
  const values = await home.evaluate(() => { const f = window.__voiceFixture; return { permission: f.permission, streams: f.streams, stopped: f.tracksStopped, starts: f.recorderStarts, transcriptions: f.transcriptions }; });
  assert.equal(values.permission, before.p + 1, "Double start sent multiple permission requests.");
  assert.equal(values.streams, before.s + (mode === "stream" ? 1 : 0), "Late permission started capture.");
  assert.equal(values.stopped, before.stopped + (mode === "stream" ? 1 : 0), "Late stream track was not stopped.");
  assert.equal(values.starts, 0); assert.equal(values.transcriptions, 0);
 }
 for (const mode of ["permission", "stream"]) {
  operation = `home-${mode}`;
  await home.locator("#new-tab-chat-input").click();
  const before = await startTwice(home.locator(".new-tab-composer-send-actions button[title='Record voice']"), mode);
  // Switch only the first-party browser state callback, keeping this document
  // alive so the delayed permission/stream can actually resolve after unmount.
  await home.evaluate(() => window.__voiceFixture.navigateHomeFixture(true));
  await home.locator(".new-tab-composer-send-actions").waitFor({ state: "detached" });
  await verifyLate(before, mode);
  await home.evaluate(() => window.__voiceFixture.navigateHomeFixture(false));
  await home.locator(".new-tab-composer-send-actions").waitFor({ state: "attached" });
  phase(`home-double-start-and-unmount-during-${mode}`);
 }
 const sidebar = home.locator(".kestrel-sidebar");
 const alpha = sidebar.getByRole("button", { name: "Voice canary alpha", exact: true });
 const beta = sidebar.getByRole("button", { name: "Voice canary beta", exact: true });
 await alpha.click();
 const voice = home.locator(".voice-button").filter({ visible: true }).first();
 for (const [mode, next] of [["permission", beta], ["stream", alpha]]) {
  operation = `agent-${mode}`;
  const before = await startTwice(voice, mode);
  await next.click();
  await eventually(async () => (await next.getAttribute("aria-current")) === "page", "Agent session did not switch");
  await verifyLate(before, mode);
  phase(`agent-double-start-and-session-switch-during-${mode}`);
 }
 await home.screenshot({ path: join(evidence, "native-voice-final.png") });
 phase("native-first-party-final-screenshot");
 if (interruptFixture) {
  operation = "mock-interrupt-during-evaluation";
  console.log("NATIVE_VOICE_DEFERRED_INTERRUPT_READY");
  const interrupt = setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
  try { await home.evaluate(() => new Promise(() => {})); }
  finally { clearTimeout(interrupt); }
  throw Error("The interrupted mock evaluation unexpectedly completed.");
 }
 if (realCapture) {
  operation = "explicit-real-microphone-capture";
  // A new first-party page has no mock init script. No samples leave this page.
  await home.evaluate(url => chrome.tabs.create({ url, active: true }), `${uiUrl}?voice-canary=real`);
  const real = await connectPage(url => url === `${uiUrl}?voice-canary=real`);
  await real.waitForFunction(() => typeof window.kestrel?.request === "function");
  await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage: "NATIVE_MICROPHONE_PERMISSION_READY", candidate: app, pid: child.pid }, null, 2), { mode: 0o600 });
  console.log("NATIVE_MICROPHONE_PERMISSION_READY");
  const result = await real.evaluate(async () => {
   const access = await window.kestrel.request({ type: "request-microphone-access" });
   if (!access.ok || !access.microphoneAccess) throw Error("Native microphone consent was not granted.");
   const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
   let bytes = 0;
   try {
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = event => { bytes += event.data.size; };
    const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = () => reject(Error("Recording failed.")); });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 1000)); recorder.stop();
    let timer;
    try { await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Recording stop timed out.")), 5000); })]); }
    finally { clearTimeout(timer); }
   } finally { stream.getTracks().forEach(track => track.stop()); }
   return { bytes, tracksEnded: stream.getTracks().every(track => track.readyState === "ended") };
  });
  assert(result.bytes > 0 && result.tracksEnded, "Real capture did not yield bytes or stop tracks.");
  phase("explicit-real-native-microphone-one-second-discarded", result);
 }
 await stop(); receipt.result = "passed";
} catch (error) {
 receipt.result = "failed"; receipt.error = interrupted ? "INTERRUPTED" : `${operation}: ${String(error?.message || error)}`; process.exitCode = 1;
 try { if (home && !home.isClosed()) await home.screenshot({ path: join(evidence, "failure.png") }); } catch {}
 console.error(`Native voice canary failed: ${receipt.error}`);
} finally {
 try { await stop(); } catch (error) { receipt.result = "failed"; receipt.shutdownError = String(error?.message || error); process.exitCode = 1; }
 await browser?.close().catch(() => {});
 try { receipt.candidateSha256After = await candidateDigest(app); if (receipt.candidateSha256After !== receipt.candidateSha256) throw Error("Candidate changed during canary."); }
 catch (error) { receipt.result = "failed"; receipt.digestError = String(error?.message || error); process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 if (interrupted) { receipt.result = "failed"; receipt.error = "INTERRUPTED"; process.exitCode = 1; }
 await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
 await rm(temporary, { recursive: true, force: true });
}
