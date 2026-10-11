import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-file-reload-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const path = join(root, "report.txt"); writeFileSync(path, "Before");
const evidence = process.env.KESTREL_FILE_RELOAD_EVIDENCE_DIR ?? ".tmp/file-reload/source";
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "file-reload-fixture", LOGNAME: "file-reload-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
let app; let page;
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
  app = await electron.launch({
    executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1")).setSize(1100, 800);
  });
  const request = async input => {
    const response = await page.evaluate(input => window.kestrel.request(input), input);
    assert(response.ok, response.error); return response;
  };
  const opened = await request({ type: "browser-open-file-tabs", paths: [path], active: true });
  const id = opened.browserState.activeTabId;
  const state = async () => (await request({ type: "browser-get-state" })).browserState;
  const tab = async () => (await state()).tabs.find(tab => tab.id === id);
  const preview = page.locator(".file-tab-text-preview pre");
  await expect(preview).toHaveText("Before");
  const metadata = statSync(path); const original = (await tab()).file;
  writeFileSync(path, "After!"); utimesSync(path, metadata.atime, metadata.mtime);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(preview).toHaveText("After!", { timeout: 10_000 });
  const refreshed = (await tab()).file;
  assert.equal(refreshed.size, original.size); assert.equal(refreshed.modifiedAt, original.modifiedAt);
  assert.equal(refreshed.previewRevision, 1);
  await capture("refreshed.png");

  rmSync(path);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByText("This file is no longer at its original location.", { exact: false })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Kestrel", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open with Default App", exact: true })).toBeDisabled();
  assert.equal((await tab()).file.status, "missing");
  await capture("missing.png");

  writeFileSync(path, "Restored report");
  await page.keyboard.press("F5");
  await expect(preview).toHaveText("Restored report");
  assert.equal((await tab()).file.status, "available");
  await expect(page.getByRole("button", { name: "Ask Kestrel", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Open with Default App", exact: true })).toBeEnabled();
  writeFileSync(path, "Updated with keyboard reload");
  await page.keyboard.press("Meta+r");
  await expect(preview).toHaveText("Updated with keyboard reload");
  await capture("restored.png");
  const final = await state();
  assert.equal(final.activeTabId, id); assert.equal(final.tabs.length, opened.browserState.tabs.length);
  assert.equal((await tab()).file.path, realpathSync(path));
  assert.equal((await tab()).file.previewRevision, 4);
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1"));
    return window.contentView.children.filter(view => view.webContents).length;
  }), 0);
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "proof.json"), JSON.stringify({
    executable: executable ?? "source Electron", unchangedMetadataEditRefreshed: true,
    missingAndRestored: true, toolbarAndKeyboardReload: true, sameTabPreserved: true,
    nativeWebViews: 0, realProfileVerified: false,
  }, null, 2));
  console.log("File reload smoke passed: actual disk edits, deletion/restoration, toolbar and keyboard reload, no native web view.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
