import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-file-restore-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const path = join(root, "report.txt"); writeFileSync(path, "Original report");
const evidence = process.env.KESTREL_FILE_RESTORE_EVIDENCE_DIR ?? ".tmp/file-tab-restore/source";
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "file-restore-fixture", LOGNAME: "file-restore-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
let app; let page; let window;
const errors = []; const pids = [];
async function launch() {
  app = await electron.launch({
    executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env,
  });
  pids.push(app.process().pid);
  assert.equal(realpathSync(await app.evaluate(({ app }) => app.getPath("userData"))), join(root, "profile"));
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  window = await app.browserWindow(page);
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await window.evaluate(window => window.setSize(1100, 800));
}
async function request(input) {
  const response = await page.evaluate(input => window.kestrel.request(input), input);
  assert(response.ok, response.error); return response;
}
async function quitFixture() {
  const closed = app.waitForEvent("close", { timeout: 15_000 });
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  await closed; app = undefined; page = undefined; window = undefined;
}
async function capture(name) {
  if (!page) return;
  if (name !== "failure.png") {
    await expect(page.getByText("Starting on this Mac…", { exact: true })).toHaveCount(0);
    await expect(page.locator(".file-tab-view")).toBeVisible();
  }
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const png = await window.evaluate(async window => {
    return (await window.webContents.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
  await launch();
  const opened = (await request({ type: "browser-open-file-tabs", paths: [path], active: true })).browserState;
  const id = opened.activeTabId; const url = `kestrel://file/${id}`;
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Original report");
  await quitFixture();
  await launch();
  // No select/open request repairs the active tab before visible proof.
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Original report");
  const checkState = async status => {
    const state = (await request({ type: "browser-get-state" })).browserState;
    assert.equal(state.activeTabId, id); assert.equal(state.tabs.length, opened.tabs.length);
    const tab = state.tabs.find(tab => tab.id === id);
    assert.equal(tab.url, url); assert.equal(tab.file.path, path); assert.equal(tab.file.status, status);
    assert.equal(tab.discarded, false);
    assert.equal(await window.evaluate(window => {
      return window.contentView.children.filter(view => view.webContents).length;
    }), 0);
  };
  await checkState("available"); await capture("restarted.png");
  await quitFixture();
  // Reproduce only the historical blank-URL record in our created profile.
  const browserRoot = join(root, "profile", "browser");
  const matches = readdirSync(browserRoot).filter(name => name.endsWith(".json")).flatMap(name => {
    const candidate = join(browserRoot, name); const state = JSON.parse(readFileSync(candidate, "utf8"));
    return state.tabs?.some(tab => tab.id === id) ? [{ candidate, state }] : [];
  });
  assert.equal(matches.length, 1);
  const { candidate, state } = matches[0];
  state.tabs.find(tab => tab.id === id).url = "";
  writeFileSync(candidate, JSON.stringify(state));
  await launch();
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Original report");
  await checkState("available"); await capture("legacy-recovered.png");
  await quitFixture(); rmSync(path);
  await launch();
  await expect(page.getByText("This file is no longer at its original location.", { exact: false })).toBeVisible();
  await expect(page.locator(".file-tab-text-preview pre")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Kestrel", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open with Default App", exact: true })).toBeDisabled();
  await checkState("missing"); await capture("missing.png");
  await quitFixture(); writeFileSync(path, "Restored report");
  await launch();
  await expect(page.locator(".file-tab-text-preview pre")).toHaveText("Restored report");
  await expect(page.getByRole("button", { name: "Ask Kestrel", exact: true })).toBeEnabled();
  await checkState("available"); await capture("restored.png");
  assert.equal(new Set(pids).size, 5); assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron",
    normalQuitRestart: true, legacyBlankUrlRecovered: true, missingAndRestored: true,
    sameTabPreserved: true, nativeWebViews: 0, fixtureProcessIds: pids,
    legacyFixtureSeeded: true, realProfileVerified: false }, null, 2));
  console.log("File tab restore smoke passed: normal quit/restart, legacy recovery, missing/restored file, same tab, no native web view.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
