import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-file-duplicate-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const path = join(root, "report.txt"); writeFileSync(path, "A report to compare");
const evidence = process.env.KESTREL_FILE_DUPLICATE_EVIDENCE_DIR ?? ".tmp/file-tab-duplicate/source";
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "file-duplicate-fixture", LOGNAME: "file-duplicate-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
let app; let page; let window;
const errors = [];
async function request(input) {
  const result = await page.evaluate(input => window.kestrel.request(input), input);
  assert(result.ok, result.error); return result;
}
async function state() { return (await request({ type: "browser-get-state" })).browserState; }
async function capture(name) {
  if (!page) return;
  if (name !== "failure.png") {
    await expect(page.getByText("Starting on this Mac…", { exact: true })).toHaveCount(0);
    await expect(page.locator(".file-tab-view")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const png = await window.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
  app = await electron.launch({
    executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env,
  });
  assert.equal(realpathSync(await app.evaluate(({ app }) => app.getPath("userData"))), join(root, "profile"));
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  window = await app.browserWindow(page);
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload(); await window.evaluate(window => window.setSize(1100, 800));
  const opened = (await request({ type: "browser-open-file-tabs", paths: [path], active: true })).browserState;
  const id = opened.activeTabId;
  const reopened = (await request({ type: "browser-open-file-tabs", paths: [path], active: true })).browserState;
  assert.equal(reopened.tabs.length, opened.tabs.length); assert.equal(reopened.activeTabId, id);
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("A report to compare");
  await page.locator(`.browser-tab[data-tab-id="${id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate tab", exact: true }).click();
  await expect.poll(async () => (await state()).tabs.length).toBe(opened.tabs.length + 1);
  const duplicated = await state(); const copyId = duplicated.activeTabId;
  assert.notEqual(copyId, id);
  const copy = duplicated.tabs.find(tab => tab.id === copyId);
  assert.equal(copy.url, `kestrel://file/${copyId}`); assert.equal(copy.file.path, path);
  // Reopening the same path may refresh metadata; snapshot after that operation.
  assert.deepEqual(duplicated.tabs.find(tab => tab.id === id), reopened.tabs.find(tab => tab.id === id));
  assert.equal(await window.evaluate(window => window.contentView.children.filter(view => view.webContents).length), 0);
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("A report to compare");
  await capture("duplicated.png");
  await page.locator(`.browser-tab[data-tab-id="${id}"]`).click();
  await expect.poll(async () => (await state()).activeTabId).toBe(id);
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("A report to compare");
  await capture("original.png");
  await request({ type: "browser-close-tab", tabId: copyId });
  assert(!(await state()).tabs.some(tab => tab.id === copyId));
  await expect(page.locator(`.browser-tab[data-tab-id="${copyId}"]`)).toHaveCount(0);
  assert.equal((await state()).activeTabId, id);
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("A report to compare");
  await capture("copy-closed.png");
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron",
    duplicateMenuCreatedCopy: true, distinctTabIds: [id, copyId], pickerDedupPreserved: true,
    originalRetained: true, copyClosedIndependently: true, nativeWebViews: 0,
    fixtureProcessId: app.process().pid, realProfileVerified: false }, null, 2));
  console.log("File tab duplicate smoke passed: actual Duplicate menu, distinct file tabs, picker dedup, independent close, no native web view.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {}); rmSync(root, { recursive: true, force: true });
}
