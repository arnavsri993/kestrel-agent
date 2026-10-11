import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

assert.notEqual(process.getuid?.(), 0, "File permission proof requires an ordinary user.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-file-preview-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const path = join(root, "report.txt"); writeFileSync(path, "Original report");
const evidence = process.env.KESTREL_FILE_PREVIEW_EVIDENCE_DIR ?? ".tmp/file-preview-errors/source";
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "file-preview-fixture", LOGNAME: "file-preview-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
let app; let page;
const errors = [];
async function launch() {
  app = await electron.launch({
    executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1")).setSize(1100, 800);
  });
}
async function request(input) {
  const response = await page.evaluate(input => window.kestrel.request(input), input);
  assert(response.ok, response.error); return response;
}
async function capture(name) {
  if (!page) return;
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1"));
    return (await window.webContents.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
  await launch();
  const opened = (await request({ type: "browser-open-file-tabs", paths: [path], active: true })).browserState;
  const id = opened.activeTabId;
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Original report");
  // Keep native app launching inside this fixture. This checks only notice UI;
  // actual file inspection/preview/permission boundaries remain unstubbed.
  await app.evaluate(({ shell }, ownedPath) => {
    shell.openPath = async requested => {
      if (requested !== ownedPath) throw new Error("Unexpected default-app path in fixture");
      return "";
    };
  }, path);
  await page.getByRole("button", { name: "Open with Default App", exact: true }).click();
  await expect(page.getByText("Opened in the default app.", { exact: true })).toBeVisible();
  const otherPath = join(root, "other.txt"); writeFileSync(otherPath, "Another file");
  const other = (await request({ type: "browser-open-file-tabs", paths: [otherPath], active: true })).browserState.activeTabId;
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Another file");
  await expect(page.getByText("Opened in the default app.", { exact: true })).toHaveCount(0);
  await request({ type: "browser-select-tab", tabId: id });
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Original report");
  await app.evaluate(({ shell }, ownedPath) => {
    shell.openPath = requested => {
      if (requested !== ownedPath) throw new Error("Unexpected delayed default-app path");
      return new Promise(resolve => { globalThis.__kestrelResolveDefaultApp = () => resolve(""); });
    };
  }, path);
  await page.getByRole("button", { name: "Open with Default App", exact: true }).click();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.__kestrelResolveDefaultApp))).toBe(true);
  await request({ type: "browser-select-tab", tabId: other });
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Another file");
  await app.evaluate(() => { globalThis.__kestrelResolveDefaultApp(); delete globalThis.__kestrelResolveDefaultApp; });
  await request({ type: "browser-get-state" });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.getByText("Opened in the default app.", { exact: true })).toHaveCount(0);
  rmSync(path);
  await request({ type: "browser-select-tab", tabId: id });
  const fallback = page.locator(".file-tab-metadata-preview");
  await expect(fallback).toContainText("original location");
  assert(!/ENOENT|ENOTDIR|realpath/.test(await fallback.innerText()));
  assert(!(await fallback.innerText()).includes(root));
  await capture("missing.png");
  writeFileSync(path, "Restored report");
  await request({ type: "browser-select-tab", tabId: other });
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Another file");
  await request({ type: "browser-select-tab", tabId: id });
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Restored report");
  const restored = (await request({ type: "browser-get-state" })).browserState;
  assert.equal(restored.activeTabId, id);
  assert.equal(restored.tabs.length, opened.tabs.length + 1);
  await expect(page.getByRole("button", { name: "Ask Kestrel", exact: true })).toBeEnabled();
  await capture("restored.png");

  const unreadable = join(root, "restricted.txt"); writeFileSync(unreadable, "Recovered contents");
  chmodSync(unreadable, 0);
  const restricted = (await request({ type: "browser-open-file-tabs", paths: [unreadable], active: true })).browserState.activeTabId;
  await expect(fallback).toContainText("permissions");
  assert(!/no longer|EACCES|EPERM|realpath/.test(await fallback.innerText()));
  assert(!(await fallback.innerText()).includes(root));
  await capture("unreadable.png");
  chmodSync(unreadable, 0o600);
  await request({ type: "browser-close-tab", tabId: restricted });
  await request({ type: "browser-open-file-tabs", paths: [unreadable], active: true });
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Recovered contents");
  await expect(page.locator(".file-tab-metadata-preview")).toHaveCount(0);
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron",
    missingFallbackSanitized: true, restoredSameTab: true, permissionFailureDistinct: true,
    permissionRepairRecovered: true, actualDiskChanges: true, staleActionNoticeCleared: true, lateActionNoticeSuppressed: true,
    nativeDefaultAppMocked: true, realProfileVerified: false }, null, 2));
  console.log("File preview errors smoke passed: missing fallback, restored tab, actual permissions and recovery.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
