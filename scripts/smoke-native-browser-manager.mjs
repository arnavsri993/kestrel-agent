import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { NativeBrowserManager } from "../apps/desktop/src/main/native-browser-manager.ts";

const root = resolve(import.meta.dirname, "..");
const app = process.env.KESTREL_NATIVE_TEST_APP ?? join(root, ".tmp/native-browser-sidecar/Kestrel.app");
const executable = join(app, "Contents/MacOS/Kestrel");
const owner = await mkdtemp(join(tmpdir(), "kestrel-native-manager-"));
const profileRoot = join(owner, "native-browser", "profile-v1");
const fixture = join(root, "tests/fixtures/native-browser-extension");
const options = { executable, profileRoot, profileOwnerRoot: owner, mode: "ephemeral", debug: true, fixtureExtensionPath: fixture };
let manager = new NativeBrowserManager(options);
let browser;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Native manager proof</title><h1>Native browser</h1>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/probe`;
async function connect() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port, path] = (await readFile(join(profileRoot, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`, { timeout: 2000 });
    } catch { await delay(100); }
  }
  throw new Error("Native manager DevTools endpoint unavailable.");
}
try {
  assert.equal((await manager.status()).available, true);
  assert.equal((await manager.open(url)).running, true);
  assert.equal((await stat(profileRoot)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(join(profileRoot, "kestrel-browser-profile.json"))).credentialMode, "development_mock");
  browser = await connect();
  let context = browser.contexts()[0];
  context.setDefaultTimeout(15000);
  let page = context.pages()[0];
  await page.waitForURL(url);
  await page.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
  const first = await page.evaluate(() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe));
  assert.equal(first.manifest, 3); assert.equal(first.badge, "CEF"); assert(first.tabs > 0);
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  await manager.openExtensions();
  await browser.close(); browser = await connect(); context = browser.contexts()[0];
  const managerPage = context.pages().find(candidate => candidate.url() === "chrome://extensions/");
  assert(managerPage); await managerPage.locator("extensions-manager").waitFor();
  const count = context.pages().length;
  await manager.openExtensions();
  assert.equal(context.pages().length, count, "Manager action must reuse its native window.");
  await browser.close(); browser = undefined;
  await manager.stop();
  assert.equal((await manager.status()).running, false);
  manager = new NativeBrowserManager(options);
  await manager.open(url); browser = await connect(); page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
  const second = await page.evaluate(() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe));
  assert.equal(second.id, first.id); assert(second.runs > first.runs);
  await browser.close(); browser = undefined; await manager.stop();
  // Changing a mock-created profile to system credentials must fail before CEF
  // starts. This does not access the login Keychain.
  const persistent = new NativeBrowserManager({ executable, profileRoot, profileOwnerRoot: owner });
  await assert.rejects(persistent.openExtensions());
  await persistent.stop();
  const foreign = join(owner, "foreign"); await mkdir(foreign);
  await symlink(foreign, join(owner, "redirected"));
  const unsafe = new NativeBrowserManager({ ...options, profileRoot: join(owner, "redirected", "profile") });
  await assert.rejects(unsafe.openExtensions()); await unsafe.stop();
  await assert.rejects(stat(join(foreign, "profile")), { code: "ENOENT" });
  console.log("Native Node manager passed: signed CEF launch, private commands, MV3, manager reuse, profile restart persistence, profile-mode isolation, ancestor symlink rejection, and owned shutdown.");
} finally {
  await browser?.close().catch(() => {});
  await manager.stop().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await rm(owner, { recursive: true, force: true });
}
