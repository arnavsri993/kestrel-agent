import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

if (process.env.KESTREL_TEST_REAL_CHROME_WEB_STORE !== "1")
  throw new Error("Set KESTREL_TEST_REAL_CHROME_WEB_STORE=1 for this live Store test.");
const root = resolve(import.meta.dirname, "..");
const owner = await mkdtemp(join(tmpdir(), "kestrel-store-same-window-"));
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE
  ? resolve(process.env.KESTREL_DESKTOP_EXECUTABLE) : desktopRequire("electron");
const id = "bcjindcccaagfpapjjmafapmmgkkhgoa";
const evidence = join(root, ".tmp/kestrel-store-window-evidence");
let application;

async function launch() {
  application = await electron.launch({
    executablePath: executable,
    args: [...(process.env.KESTREL_DESKTOP_EXECUTABLE ? [] : [join(root, "apps/desktop")]), "--use-mock-keychain"],
    env: { ...process.env, KESTREL_DISABLE_UPDATES: "1",
      KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
      KESTREL_TEST_USER_DATA: join(owner, "user-data"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1" },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForURL(url => url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
    localStorage.setItem("kestrel:navigation-sidebar", "open");
  });
  await page.reload();
  await page.locator(".browser-toolbar").waitFor();
  return page;
}

async function installed(page) {
  const response = await page.evaluate(() => window.kestrel.request({ type: "browser-list-extensions" }));
  assert(response.ok && "extensions" in response);
  return response.extensions.find(extension => extension.id === id);
}

async function windowIds() {
  // Playwright also exposes embedded WebContentsViews as pages. Count native
  // BrowserWindows so loading the Store's view is not mistaken for a new window.
  return application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(window => window.id).sort((a, b) => a - b));
}

try {
  await mkdir(evidence, { recursive: true });
  let page = await launch();
  const sourceWindow = await application.browserWindow(page);
  const sourceWindowId = await sourceWindow.evaluate(window => window.id);
  const windowsBefore = await windowIds();
  assert.deepEqual(windowsBefore, [sourceWindowId]);
  await page.locator(".kestrel-sidebar").getByRole("button", { name: "New chat", exact: true }).waitFor();
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Extensions", exact: true });
  assert.equal(await menu.getByText("Native browser", { exact: true }).count(), 0);
  await menu.getByRole("menuitem", { name: "Open Chrome Web Store", exact: true }).click();
  await page.waitForFunction(async () => {
    const response = await window.kestrel.request({ type: "browser-get-state" });
    return response.ok && "browserState" in response && response.browserState.tabs.some(tab =>
      tab.id === response.browserState.activeTabId && tab.url.startsWith("https://chromewebstore.google.com"));
  });
  assert.deepEqual(await windowIds(), windowsBefore);
  assert.equal(await sourceWindow.evaluate(window => window.id), sourceWindowId);
  await page.getByRole("tablist", { name: "Browser tabs", exact: true }).waitFor();
  // External pages use Kestrel's browser layout: navigation stays in the tab
  // rail and the agent remains available through its normal sidebar control.
  const agentToggle = page.locator(".browser-toolbar").getByRole("button", { name: /^Show / });
  if (await agentToggle.count()) await agentToggle.click();
  await page.locator(".agent-sidebar").waitFor();
  await page.evaluate(async input => {
    const state = await window.kestrel.request({ type: "browser-get-state" });
    if (!state.ok || !("browserState" in state) || !state.browserState.activeTabId) throw new Error("No Store tab.");
    const response = await window.kestrel.request({ type: "browser-navigate", tabId: state.browserState.activeTabId, input });
    if (!response.ok) throw new Error("Store listing could not open.");
  }, `https://chromewebstore.google.com/detail/json-formatter/${id}`);
  const bar = page.getByRole("region", { name: "Chrome Web Store installation" });
  await bar.waitFor();
  assert.equal(await bar.getByRole("button", { name: "Open in native browser", exact: true }).count(), 0);
  await bar.getByRole("button", { name: "Review & add", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review extension", exact: true });
  await review.waitFor({ timeout: 60000 });
  await review.getByText("Verified Chrome Web Store package", { exact: true }).waitFor();
  await review.getByRole("button", { name: "Install reviewed extension", exact: true }).click();
  await review.waitFor({ state: "detached", timeout: 60000 });
  await bar.getByText("Added to Kestrel", { exact: true }).waitFor({ timeout: 60000 });
  const first = await installed(page);
  assert(first && first.enabled && first.source === "chrome_web_store");
  assert.notEqual(first.compatibility?.state, "unsupported");
  assert.deepEqual(await windowIds(), windowsBefore);
  await page.screenshot({ path: join(evidence, "kestrel-store-installed.png") });
  await application.close(); application = undefined;
  page = await launch();
  const second = await installed(page);
  assert(second && second.enabled && second.source === "chrome_web_store");
  assert.equal(second.id, first.id);
  assert.equal(second.version, first.version);
  const asar = join(dirname(dirname(executable)), "Resources/app.asar");
  await writeFile(join(evidence, "receipt.json"), `${JSON.stringify({
    verifiedAt: new Date().toISOString(), executable,
    ...(process.env.KESTREL_DESKTOP_EXECUTABLE
      ? { asarSha256: createHash("sha256").update(await readFile(asar)).digest("hex") } : {}),
    storeOpenedInExistingKestrelWindow: true, kestrelTabRailPreserved: true,
    agentSidebarAccessible: true,
    signedStorePackageInstalled: true, extensionId: id, version: second.version,
    enabledAfterRestart: true, runtime: "Kestrel's existing Electron extension runtime",
    fullNativeChromiumIntegration: false, profile: "disposable test profile; no personal accounts",
  }, null, 2)}\n`);
  console.log("Kestrel Store flow passed: existing window/tab rail, agent sidebar, signed package review and install, and enabled after app restart. Full native Chromium integration is not claimed.");
} catch (error) {
  await application?.firstWindow().then(page => page.screenshot({ path: join(evidence, "failure.png") })).catch(() => {});
  throw error;
} finally {
  await application?.close();
  await rm(owner, { recursive: true, force: true });
}
