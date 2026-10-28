import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { NativeBrowserManager } from "../apps/desktop/src/main/native-browser-manager.ts";
import { openNativeChromeWebStore } from "../apps/desktop/src/renderer/components/browser/chrome-web-store-install.ts";

// Explicit live test: Chromium presents the real Store permission prompt. The
// operator installs the named extension in this disposable, account-free profile.
// No debugger install API, unpacked fixture or patched preference is accepted.
if (process.env.KESTREL_TEST_REAL_CHROME_WEB_STORE !== "1")
  throw new Error("Set KESTREL_TEST_REAL_CHROME_WEB_STORE=1 for this live Store test.");
const root = resolve(import.meta.dirname, "..");
const app = process.env.KESTREL_NATIVE_TEST_APP ?? join(root, ".tmp/native-browser-sidecar/Kestrel.app");
const executable = join(app, "Contents/MacOS/Kestrel");
const owner = await mkdtemp(join(tmpdir(), "kestrel-native-web-store-"));
const profileRoot = join(owner, "native-browser", "profile-v1");
const options = { executable, profileRoot, profileOwnerRoot: owner, mode: "ephemeral", debug: true };
const id = "bcjindcccaagfpapjjmafapmmgkkhgoa";
const listing = `https://chromewebstore.google.com/detail/${id}`;
const evidence = join(root, ".tmp/native-web-store-evidence");
let manager = new NativeBrowserManager(options);
let browser;

async function connect() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port, suffix] = (await readFile(join(profileRoot, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return await chromium.connectOverCDP(`ws://127.0.0.1:${port}${suffix}`, { timeout: 2000 });
    } catch { await delay(100); }
  }
  throw new Error("The native browser's test endpoint was unavailable.");
}

async function extensionInfo() {
  await manager.openExtensions();
  await browser?.close();
  browser = await connect();
  const page = browser.contexts()[0].pages().find(page => page.url() === "chrome://extensions/");
  assert(page, "Chromium's own extension manager must open.");
  await page.locator("extensions-manager").waitFor();
  const extensions = await page.evaluate(() => new Promise(resolve => {
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve);
  }));
  const extension = extensions.find(extension => extension.id === id);
  assert(extension, "The Store extension must appear in Chromium's own registry.");
  assert.equal(extension.state, "ENABLED");
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  assert.equal(await page.evaluate(() => typeof window.__kestrelNativeQuery), "undefined");
  return { page, extension };
}

try {
  await mkdir(evidence, { recursive: true });
  // Exercise the same helper used by the toolbar, Settings and listing banner.
  await openNativeChromeWebStore(async request => {
    assert.equal(request.type, "browser-open-native");
    return { ok: true, nativeBrowser: await manager.open(request.input) };
  }, listing);
  browser = await connect();
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(60000);
  await page.getByRole("button", { name: "Add to Chrome", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  assert.equal(await page.evaluate(() => typeof window.__kestrelNativeQuery), "undefined");
  await page.screenshot({ path: join(evidence, "store-before-install.png") });
  console.log(`NATIVE_STORE_READY: Install JSON Formatter using Add to Chrome in the native window. Disposable profile: ${owner}`);
  let installed;
  for (let attempt = 0; attempt < 360; attempt++) {
    try {
      const preferences = JSON.parse(await readFile(join(profileRoot, "Default", "Secure Preferences"), "utf8"));
      installed = preferences.extensions?.settings?.[id];
      if (installed?.from_webstore === true) break;
    } catch { /* Chromium writes its own signed preferences after install. */ }
    await delay(500);
  }
  assert.equal(installed?.from_webstore, true, "A real signed Store install was not completed within three minutes.");
  const first = await extensionInfo();
  await first.page.screenshot({ path: join(evidence, "installed.png") });
  await browser.close(); browser = undefined;
  await manager.stop();
  // Restart with the exact same owned profile, without load-extension flags.
  manager = new NativeBrowserManager(options);
  const second = await extensionInfo();
  assert.equal(second.extension.id, first.extension.id);
  assert.equal(second.extension.version, first.extension.version);
  await second.page.screenshot({ path: join(evidence, "installed-after-restart.png") });
  await writeFile(join(evidence, "receipt.json"), `${JSON.stringify({
    verifiedAt: new Date().toISOString(),
    executableSha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    listing, extensionId: id, version: second.extension.version,
    nativeStoreInstall: true, enabledAfterFullRestart: true, privilegedBridgeAbsent: true,
    profile: "disposable mock credential storage; no accounts or personal profile",
    updateDelivery: "not verified by this install and restart test",
  }, null, 2)}\n`);
  console.log("Native Chrome Web Store passed: real Store installation, Chromium registry, enabled after full restart, and privileged bridge isolation.");
} finally {
  await browser?.close().catch(() => {});
  // Retain the owned profile if shutdown fails rather than deleting live data.
  await manager.stop();
  await rm(owner, { recursive: true, force: true });
}
