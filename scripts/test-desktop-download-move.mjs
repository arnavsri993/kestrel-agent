import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Real HTTP downloads are held at the server, in a disposable profile only.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-download-move-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_DOWNLOAD_MOVE_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, { HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "download-fixture", LOGNAME: "download-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" });
const bytes = Buffer.alloc(256 * 1024, "download-move-proof");
const held = new Map();
const server = createServer((req, res) => {
  const name = req.url?.slice(1);
  if (!['main', 'detached'].includes(name)) {
    res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Download move fixture</title><p>Download move fixture</p>"); return;
  }
  res.writeHead(200, { "content-type": "text/plain", "content-length": String(bytes.length),
    "content-disposition": `attachment; filename="${name}.txt"`, "cache-control": "no-store" });
  res.write(bytes.subarray(0, 16 * 1024)); held.set(name, res);
});
let app, main;
const errors = [];
const raw = (page, input) => page.evaluate(input => window.kestrel.request(input), input);
const request = async (page, input) => { const response = await raw(page, input); assert(response.ok, response.error); return response; };
const state = async page => (await request(page, { type: "browser-get-state" })).browserState;
async function capture(page, name) {
  if (!evidence) return;
  const error = page.locator(".browser-inline-error");
  if (await error.count()) await expect(error).toHaveCSS("opacity", "1");
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  await page.screenshot();
  const window = await app.browserWindow(page);
  const png = await window.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
async function move(page, tabId, label) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Downloads", exact: true })).not.toBeVisible();
  await page.locator(`.browser-tab[data-tab-id="${tabId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}
async function advanceDownload(page, name, downloadId) {
  held.get(name).write(bytes.subarray(16 * 1024, 32 * 1024));
  await expect.poll(async () => (await state(page)).downloads.find(d => d.id === downloadId)?.receivedBytes).toBe(32 * 1024);
  await expect(page.locator(".browser-inline-error")).toContainText(/Finish or cancel.*download/);
}
async function activeDownload(page, origin, tabId, name) {
  await request(page, { type: "browser-navigate", tabId, input: `${origin}/${name}` });
  await expect.poll(async () => (await state(page)).downloads.find(d => d.filename === `${name}.txt`)?.status).toBe("progressing");
  return (await state(page)).downloads.find(d => d.filename === `${name}.txt`);
}
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = await electron.launch({ executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env });
  main = await app.firstWindow({ timeout: 60_000 }); main.setDefaultTimeout(15_000);
  await main.emulateMedia({ reducedMotion: "reduce" });
  main.on("pageerror", error => errors.push(error.message));
  await main.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
  await main.reload();
  const window = await app.browserWindow(main); await window.evaluate(window => window.setSize(1100, 850));
  const created = await request(main, { type: "browser-create-tab", input: `${origin}/page`, active: true });
  const tabId = created.browserState.activeTabId;
  const first = await activeDownload(main, origin, tabId, "main");
  await move(main, tabId, "Move tab to new window");
  await expect(main.locator(".browser-inline-error")).toContainText(/Finish or cancel.*download/);
  assert((await state(main)).tabs.some(t => t.id === tabId));
  assert.equal((await state(main)).downloads.find(d => d.id === first.id).status, "progressing");
  await advanceDownload(main, "main", first.id);
  await capture(main, "detach-blocked.png");
  held.get("main").end(bytes.subarray(32 * 1024));
  await expect.poll(async () => (await state(main)).downloads.find(d => d.id === first.id)?.status).toBe("completed");
  assert.deepEqual(readFileSync(join(root, "profile", "browser-downloads", "main.txt")), bytes);
  await expect(main.locator(".browser-inline-error")).toHaveCount(0);
  // Move the page, not a download URL, so recreating its view cannot start another file.
  await request(main, { type: "browser-navigate", tabId, input: `${origin}/page` });
  const detachedReady = app.waitForEvent("window", { timeout: 20_000 });
  await move(main, tabId, "Move tab to new window");
  const detached = await detachedReady; detached.setDefaultTimeout(15_000);
  await detached.emulateMedia({ reducedMotion: "reduce" });
  detached.on("pageerror", error => errors.push(error.message));
  await expect.poll(async () => (await state(detached)).tabs.some(t => t.id === tabId)).toBe(true);
  assert(!(await state(main)).tabs.some(t => t.id === tabId));
  const second = await activeDownload(detached, origin, tabId, "detached");
  await move(detached, tabId, "Move tab back to main window");
  await expect(detached.locator(".browser-inline-error")).toContainText(/Finish or cancel.*download/);
  const prepared = await raw(detached, { type: "browser-prepare-tab-transfer", tabId }).catch(error => ({ ok: false, error: error.message }));
  assert.equal(prepared.ok, false); assert.match(prepared.error, /Finish or cancel.*download/);
  assert((await state(detached)).tabs.some(t => t.id === tabId));
  assert(!(await state(main)).tabs.some(t => t.id === tabId));
  assert.equal((await state(detached)).downloads.find(d => d.id === second.id).status, "progressing");
  await advanceDownload(detached, "detached", second.id);
  await capture(detached, "reattach-blocked.png");
  await request(detached, { type: "browser-cancel-download", downloadId: second.id });
  await expect.poll(async () => (await state(detached)).downloads.find(d => d.id === second.id)?.status).toBe("cancelled");
  await expect(detached.locator(".browser-inline-error")).toHaveCount(0);
  await request(detached, { type: "browser-navigate", tabId, input: `${origin}/page` });
  await move(detached, tabId, "Move tab back to main window");
  await expect.poll(async () => (await state(main)).tabs.some(t => t.id === tabId)).toBe(true);
  await main.locator(`.browser-tab[data-tab-id="${tabId}"]`).waitFor();
  await capture(main, "returned-after-cancel.png"); assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", actualHttpDownloads: 2,
    bytesPerCompletedDownload: bytes.length, pointerContextMenu: true, reducedMotion: true, progressUpdatesRetainMoveExplanation: true, detachBlockedWithoutInterruptingDownload: true,
    completionPermitsDetach: true, reattachAndTransferPreparationBlocked: true, cancellationPermitsReturn: true,
    noUnhandledRendererErrors: true, realProfileVerified: false, completedHistoryTransferVerified: false }, null, 2));
  console.log("Download move smoke passed: held HTTP download survives rejected detach/reattach; finish and cancel allow movement.");
} catch (error) { if (main && !main.isClosed()) await capture(main, "failure.png").catch(() => {}); throw error; }
finally { for (const res of held.values()) res.end(); await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); }
