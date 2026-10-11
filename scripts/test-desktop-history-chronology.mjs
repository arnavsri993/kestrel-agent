import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// One real HTTP visit, followed by an import into disposable browser storage.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-history-chronology-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_HISTORY_CHRONOLOGY_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "history-fixture", LOGNAME: "history-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
let currentPageRequests = 0;
const server = createServer((req, res) => {
  if (req.url === "/current") currentPageRequests++;
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end("<!doctype html><title>Current visit</title><h1>Current visit</h1>");
});
let app;
let page;
async function capture(name) {
  if (!evidence || !page) return;
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  await page.screenshot();
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1"));
    return (await window.webContents.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const currentUrl = `${origin}/current`;
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
  const request = async input => {
    const response = await page.evaluate(input => window.kestrel.request(input), input);
    assert(response.ok, response.error); return response;
  };
  const state = async () => (await request({ type: "browser-get-state" })).browserState;
  const created = await request({ type: "browser-create-tab", active: true });
  await request({ type: "browser-navigate", tabId: created.browserState.activeTabId, input: currentUrl });
  await expect.poll(async () => (await state()).history.some(entry => entry.url === currentUrl && entry.title === "Current visit")).toBe(true);
  const before = await state();
  assert.equal(before.history.length, 1);
  const imported = Array.from({ length: 52 }, (_, index) => ({
    id: `visit-${randomUUID()}`, tabId: before.activeTabId, url: `${origin}/imported/${index}`,
    title: `Imported visit ${String(index).padStart(2, "0")}`,
    visitedAt: new Date(Date.parse(before.history[0].visitedAt) - (60 + index) * 60_000).toISOString(),
  }));
  const file = join(root, "browser-import.json");
  writeFileSync(file, JSON.stringify({ format: "kestrel-browser-data", version: 1, exportedAt: new Date().toISOString(),
    history: imported, bookmarks: [], bookmarkFolders: [], sitePermissions: [], settings: before.settings }));
  // Stub only the disposable app's file picker; the actual IPC/importer reads
  // and validates this fixture file. No native dialog or real profile is used.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options.title !== "Import Kestrel browser data") throw new Error("Unexpected fixture dialog");
      return { canceled: false, filePaths: [file] };
    };
  }, file);
  const result = await request({ type: "browser-import-data" });
  const storedIds = result.browserState.history.map(entry => entry.id);
  assert.equal(storedIds.length, 53);
  assert.deepEqual(storedIds, [...before.history, ...imported].map(entry => entry.id));
  await request({ type: "browser-create-tab", input: "kestrel://history", active: true });
  await page.getByRole("heading", { name: "Browsing history", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1")).setSize(1100, 800);
  });
  const fullTitles = page.locator(".history-list li strong");
  const expected = ["Current visit", ...imported.map(entry => entry.title)];
  await expect(fullTitles).toHaveText(expected);
  await capture("full-history.png");
  const fullSearch = page.getByRole("textbox", { name: "Search history", exact: true });
  await fullSearch.fill("Imported visit 0");
  await expect(fullTitles).toHaveText(imported.slice(0, 10).map(entry => entry.title));
  await fullSearch.fill("");
  await page.reload();
  await expect(fullTitles).toHaveText(expected);
  assert.deepEqual((await state()).history.map(entry => entry.id), storedIds);
  // Exercise toolbar reopening from the existing web tab. App-page-to-web
  // navigation has a separate pre-existing ensureView guard on current main.
  await request({ type: "browser-select-tab", tabId: before.activeTabId });
  await page.getByRole("button", { name: "History", exact: true }).click();
  const popupTitles = page.locator(".browser-history-popover-list li strong");
  await expect(popupTitles).toHaveText(expected.slice(0, 50));
  await capture("history-popover.png");
  const popupSearch = page.locator(".browser-history-popover-search input");
  await popupSearch.fill("Imported visit 0");
  await expect(popupTitles).toHaveText(imported.slice(0, 10).map(entry => entry.title));
  await popupSearch.fill("");
  const requestsBeforeReopen = currentPageRequests;
  await page.locator(".browser-history-popover-list li button").first().click();
  await expect.poll(async () => {
    const current = await state();
    return current.tabs.find(tab => tab.id === current.activeTabId)?.url;
  }).toBe(currentUrl);
  await expect.poll(() => currentPageRequests).toBeGreaterThan(requestsBeforeReopen);
  assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron",
    importedFixtureVisits: imported.length, actualHttpVisits: currentPageRequests, newestFirst: true, popoverCount: 50,
    searchOrdered: true, storedOrderPreserved: true, reopenedCurrentVisit: true, filePickerStubbed: true, realProfileVerified: false }, null, 2));
  console.log("History chronology smoke passed: actual HTTP visit/import IPC, newest first in both views, newest50, ordered search, storage/reload and reopen.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections(); await new Promise(done => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
