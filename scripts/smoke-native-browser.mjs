import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { UserBrowserStateSchema } from "../packages/shared-types/src/contracts.ts";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.KESTREL_NATIVE_TEST_APP ?? await buildNativeChromiumHost();
const executable = join(app, "Contents/MacOS/Kestrel");
for (const flags of [
  ["--kestrel-browser-child"],
  ["--kestrel-extension-workbench", "--kestrel-browser-child", "--kestrel-renderer"],
  ["--kestrel-native-browser", "--kestrel-extension-workbench"],
]) {
  const invalid = spawnSync(executable, flags, { encoding: "utf8", timeout: 10_000 });
  assert.equal(invalid.status, 1, invalid.stderr);
}
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-browser-test-"));
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><title>Native browser ${request.url}</title><h1>Native browsing</h1>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let child, shellBrowser, webBrowser;
let output = "";

async function endpoint(path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      const [port, suffix] = (await readFile(join(path, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return `ws://127.0.0.1:${port}${suffix}`;
    } catch { await delay(100); }
  }
  throw new Error(`Native DevTools endpoint unavailable: ${output}`);
}

try {
  child = spawn(executable, [
    "--kestrel-cache-path", profile, "--kestrel-native-browser", "--kestrel-ephemeral-core", "--kestrel-renderer",
    "--remote-debugging-port=0", `--load-extension=${join(root, "tests/fixtures/native-browser-extension")}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => output += bytes);
  child.stderr.on("data", bytes => output += bytes);
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  shellBrowser = await chromium.connectOverCDP(await endpoint(profile));
  const shell = shellBrowser.contexts()[0].pages()[0];
  shell.setDefaultTimeout(15000);
  await shell.waitForURL("kestrel://app/index.html");
  await shell.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await shell.reload();
  await shell.waitForFunction(() => typeof window.kestrel?.request === "function");
  const request = value => shell.evaluate(value => window.kestrel.request(value), value);
  let state = await request({ type: "browser-get-state" });
  assert.equal(state.ok, true, JSON.stringify(state));
  UserBrowserStateSchema.parse(state.browserState);
  assert.equal(state.browserState.presentation, "native_window");
  const tab = state.browserState.tabs[0];
  assert(tab);
  assert.equal((await request({ type: "browser-navigate", tabId: tab.id, input: `${origin}/first` })).ok, true);
  webBrowser = await chromium.connectOverCDP(await endpoint(join(profile, "extension-browser")));
  let context = webBrowser.contexts()[0];
  context.setDefaultTimeout(15000);
  let page = context.pages()[0];
  await page.waitForURL(`${origin}/first`, { waitUntil: "commit", timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
  console.log("MV3 loaded through shell navigation.");
  const probe = await page.evaluate(() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe));
  assert.equal(probe.manifest, 3);
  assert.equal(probe.runs, 1);
  assert(probe.tabs > 0);
  assert.equal(probe.badge, "CEF");
  assert.equal(probe.scripting, true);
  assert.equal(await page.evaluate(async () => {
    try { await fetch("/native-block-probe"); return false; } catch { return true; }
  }), true, "Native declarativeNetRequest must block the fixture request.");
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  assert.equal(await page.evaluate(() => typeof window.__kestrelNativeQuery), "undefined");
  // The privileged Alloy shell has no extension content script even when the
  // browser child was explicitly given the same test fixture at launch.
  assert.equal(await shell.evaluate(() => document.documentElement.dataset.kestrelExtensionProbe), undefined);
  assert.equal((await request({ type: "browser-navigate", tabId: tab.id, input: `${origin}/second` })).ok, true);
  await page.waitForURL(`${origin}/second`, { waitUntil: "commit", timeout: 15000 });
  assert.equal((await request({ type: "browser-back", tabId: tab.id })).ok, true);
  await page.waitForURL(`${origin}/first`, { waitUntil: "commit", timeout: 15000 });
  assert.equal((await request({ type: "browser-forward", tabId: tab.id })).ok, true);
  await page.waitForURL(`${origin}/second`, { waitUntil: "commit", timeout: 15000 });
  assert.equal((await request({ type: "browser-select-tab", tabId: tab.id })).ok, true);
  console.log("Back, forward and focus passed.");
  const rejected = await request({ type: "browser-navigate", tabId: tab.id, input: "file:///etc/passwd" });
  assert.equal(rejected.ok, false);
  assert.equal((await request({ type: "browser-list-extensions" })).ok, false);
  assert.equal((await request({ type: "browser-create-tab", input: `${origin}/third`, active: true })).ok, true);
  // CEF-created Chrome windows do not emit Playwright's page event reliably.
  // Reconnect to discover the actual CDP targets instead of assuming the event.
  await webBrowser.close();
  webBrowser = await chromium.connectOverCDP(await endpoint(join(profile, "extension-browser")));
  context = webBrowser.contexts()[0];
  context.setDefaultTimeout(15000);
  page = context.pages().find(candidate => candidate.url() === `${origin}/second`);
  const created = context.pages().find(candidate => candidate !== page);
  assert(page && created);
  await created.waitForURL(`${origin}/third`);
  assert.equal(await created.evaluate(() => typeof window.kestrel), "undefined");
  console.log("Creating additional native window passed.");
  state = await request({ type: "browser-get-state" });
  UserBrowserStateSchema.parse(state.browserState);
  assert(state.browserState.tabs.some(item => item.url === `${origin}/third`));
  const popupPromise = context.waitForEvent("page");
  await page.evaluate(() => window.open("about:blank"));
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(await popup.evaluate(() => typeof window.kestrel), "undefined");
  await page.goto(`chrome-extension://${probe.id}/popup.html`);
  await page.getByText("Manifest V3 running in native Chromium.").waitFor();
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  const evidence = join(root, ".tmp/native-browser-evidence");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "native-extension.png") });
  await shell.getByRole("heading", { name: "Native browser", exact: true }).waitFor();
  const focus = shell.getByRole("button", { name: "Show browser window", exact: true });
  await focus.focus();
  assert(await focus.evaluate(element => element === document.activeElement));
  await focus.press("Enter");
  await shell.screenshot({ path: join(evidence, "kestrel-handoff.png") });
  await shell.getByRole("button", { name: "Manage Chrome extensions", exact: true }).click();
  await shell.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await webBrowser.close();
  webBrowser = await chromium.connectOverCDP(await endpoint(join(profile, "extension-browser")));
  context = webBrowser.contexts()[0];
  context.setDefaultTimeout(15000);
  await shell.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  for (let attempt = 0; attempt < 100 && !context.pages().some(candidate => candidate.url() === "chrome://extensions/"); attempt++) await delay(100);
  const manager = context.pages().find(candidate => candidate.url() === "chrome://extensions/");
  assert(manager);
  await manager.locator("extensions-manager").waitFor();
  await manager.getByText("Kestrel native browser probe", { exact: true }).waitFor();
  await manager.screenshot({ path: join(evidence, "native-manager.png") });
  // Close only the Chrome child. The Kestrel shell must remain live and
  // restart the child on the next browsing request, preserving this launch's
  // extension profile without importing any Electron data.
  const closingSession = await webBrowser.newBrowserCDPSession();
  const disconnected = new Promise(resolve => webBrowser.once("disconnected", resolve));
  await closingSession.send("Browser.close");
  await disconnected;
  await delay(500);
  state = await request({ type: "browser-get-state" });
  assert.equal(state.ok, true, JSON.stringify(state));
  UserBrowserStateSchema.parse(state.browserState);
  const restartedTab = state.browserState.tabs[0];
  assert(restartedTab);
  assert.equal((await request({ type: "browser-navigate", tabId: restartedTab.id, input: `${origin}/restarted` })).ok, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      webBrowser = await chromium.connectOverCDP(await endpoint(join(profile, "extension-browser")), { timeout: 2000 });
      break;
    } catch { if (attempt === 99) throw new Error("Restarted native browser could not connect."); await delay(100); }
  }
  context = webBrowser.contexts()[0];
  context.setDefaultTimeout(15000);
  const restarted = context.pages()[0];
  await restarted.waitForURL(`${origin}/restarted`);
  await restarted.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
  const persisted = await restarted.evaluate(() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe));
  assert.equal(persisted.id, probe.id);
  assert(persisted.runs > probe.runs, "Extension storage must survive a browser child restart.");
  console.log("Native browser restart and extension persistence passed.");
  const processes = execFileSync("/bin/ps", ["-axo", "pid,ppid,command"], { encoding: "utf8" });
  const native = processes.split("\n").filter(line => line.includes(join(app, "Contents/")));
  assert(native.some(line => line.includes("--kestrel-browser-child")));
  assert(!native.some(line => /Electron Framework/.test(line)));
  const workers = native.filter(line => /--type=(renderer|gpu-process|utility)/.test(line));
  assert(workers.length > 0);
  assert(workers.every(line => /--seatbelt-client=\d+/.test(line) && !/--no-sandbox\b/.test(line)));
  // A suspended child cannot consume EOF: the parent must still reap it before
  // exiting, so the launcher can safely remove the disposable profile.
  const childRow = native.find(line => line.includes("--kestrel-browser-child"));
  const browserPid = Number(childRow.trim().split(/\s+/)[0]);
  process.kill(browserPid, "SIGSTOP");
  const hostSession = await shellBrowser.newBrowserCDPSession();
  await hostSession.send("Browser.close");
  const result = await Promise.race([exited, delay(15_000).then(() => { throw new Error(output); })]);
  assert.deepEqual(result, { code: 0, signal: null }, output);
  for (let attempt = 0; attempt < 70; attempt++) {
    const live = execFileSync("/bin/ps", ["-axo", "command"], { encoding: "utf8" });
    if (!live.includes(`--kestrel-cache-path ${join(profile, "extension-browser")}`)) break;
    if (attempt === 69) throw new Error("Extension browser child survived shell shutdown.");
    await delay(100);
  }
  console.log("Native browser passed: shell-controlled Chrome browsing, MV3, messaging/storage, navigation, popups, schema, private bridge isolation, sandbox, and parent/child shutdown.");
} finally {
  await webBrowser?.close().catch(() => {});
  await shellBrowser?.close().catch(() => {});
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
