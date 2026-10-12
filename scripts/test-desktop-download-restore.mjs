import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Real downloads and normal quit/restart in one disposable profile. Host file handoffs are stubbed.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-download-restore-")));
for (const name of ["profile", "home", "codex", "tmp", "custom", "changed"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_DOWNLOAD_RESTORE_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, { HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "download-fixture", LOGNAME: "download-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" });
const bytes = Buffer.alloc(128 * 1024, "download-restart-proof");
const names = ["default", "custom", "missing", "directory", "symlink", "legacy"];
const paths = new Map(names.map(name => [name, join(root, name === "default" ? "profile/browser-downloads" : "custom", `${name}.txt`)]));
const server = createServer((req, res) => {
  const name = req.url?.slice(1);
  if (!names.includes(name)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/plain", "content-length": String(bytes.length),
    "content-disposition": `attachment; filename="${name}.txt"`, "cache-control": "no-store" });
  res.end(bytes);
});
let app, page, window;
const errors = [];
const request = async input => { const response = await page.evaluate(input => window.kestrel.request(input), input); assert(response.ok, response.error); return response; };
const state = async () => (await request({ type: "browser-get-state" })).browserState;
const row = name => page.locator(".download-list li").filter({ has: page.getByText(`${name}.txt`, { exact: true }) });
async function launch(first = false) {
  app = await electron.launch({ executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env });
  page = await app.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  if (first) {
    await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
    await page.reload();
  }
  window = await app.browserWindow(page);
  await window.evaluate(window => window.setSize(1100, 850));
}
async function showDownloads() {
  await request({ type: "browser-create-tab", input: "kestrel://downloads", active: true });
  await page.getByRole("heading", { name: "Downloaded files", exact: true }).waitFor();
  const menu = page.getByRole("menu", { name: "Downloads", exact: true });
  if (await menu.isVisible()) { await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible(); }
  const toggle = page.locator("#browser-agent-toggle");
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
}
async function capture(name) {
  if (!evidence || !window) return;
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  await page.screenshot();
  const png = await window.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
async function quit() { await app.close(); app = undefined; window = undefined; }
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await launch(true);
  for (const name of names) {
    if (name === "custom") await request({ type: "browser-update-settings", settings: { ...(await state()).settings, downloadDirectory: join(root, "custom") } });
    const response = await request({ type: "browser-create-tab", active: true });
    await request({ type: "browser-navigate", tabId: response.browserState.activeTabId, input: `${origin}/${name}` });
    await expect.poll(async () => (await state()).downloads.find(d => d.filename === `${name}.txt`)?.status, { timeout: 20_000 }).toBe("completed");
    assert.deepEqual(readFileSync(paths.get(name)), bytes);
  }
  await showDownloads(); await capture("before-restart.png");
  await request({ type: "browser-update-settings", settings: { ...(await state()).settings, downloadDirectory: join(root, "changed") } });
  for (const name of ["default", "custom"]) writeFileSync(join(root, "changed", `${name}.txt`), "same-name decoy");
  await quit();
  // Only fixture-owned files and metadata are changed; simulate unavailable and legacy records.
  rmSync(paths.get("missing"));
  rmSync(paths.get("directory")); mkdirSync(paths.get("directory"));
  rmSync(paths.get("symlink")); symlinkSync(paths.get("custom"), paths.get("symlink"));
  const statePath = join(root, "profile", "browser", "state.json");
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  const legacy = stored.downloads.find(d => d.filename === "legacy.txt");
  if (stored.downloadPaths) delete stored.downloadPaths[legacy.id];
  writeFileSync(statePath, JSON.stringify(stored), { mode: 0o600 });
  await launch(); await showDownloads();
  await expect.poll(async () => (await state()).downloads.filter(d => d.canReveal).map(d => d.filename).sort()).toEqual(["custom.txt", "default.txt"]);
  await capture("after-restart.png");
  const restored = (await state()).downloads;
  assert.equal(restored.length, 6); assert(restored.every(d => d.status === "completed"));
  for (const name of names) {
    await expect(row(name)).toBeVisible();
    await expect(row(name).getByRole("button", { name: "Open", exact: true })).toHaveCount(["default", "custom"].includes(name) ? 1 : 0);
    await expect(row(name).getByRole("button", { name: "Show in Finder", exact: true })).toHaveCount(["default", "custom"].includes(name) ? 1 : 0);
    assert(!JSON.stringify(await state()).includes(paths.get(name)), "Public browser state excludes private file destinations");
  }
  // Real UI/IPC, explicit stubs for host Finder/default-app/drag handoffs.
  await app.evaluate(({ shell }) => { globalThis.downloadRestoreCalls = [];
    shell.openPath = async path => { globalThis.downloadRestoreCalls.push(["open", path]); return ""; };
    shell.showItemInFolder = path => { globalThis.downloadRestoreCalls.push(["reveal", path]); }; });
  await window.evaluate(window => { window.webContents.startDrag = item => globalThis.downloadRestoreCalls.push(["drag", item.file]); });
  for (const name of ["default", "custom"]) {
    await row(name).getByRole("button", { name: "Open", exact: true }).focus(); await page.keyboard.press("Enter");
    await row(name).getByRole("button", { name: "Show in Finder", exact: true }).focus(); await page.keyboard.press("Enter");
    await request({ type: "browser-start-download-drag", downloadId: restored.find(d => d.filename === `${name}.txt`).id });
    assert.deepEqual(readFileSync(paths.get(name)), bytes);
    assert.equal(readFileSync(join(root, "changed", `${name}.txt`), "utf8"), "same-name decoy");
  }
  await expect.poll(() => app.evaluate(() => globalThis.downloadRestoreCalls)).toEqual(["default", "custom"].flatMap(name => ["open", "reveal", "drag"].map(action => [action, paths.get(name)])));
  const calls = await app.evaluate(() => globalThis.downloadRestoreCalls);
  for (const name of ["missing", "directory", "symlink", "legacy"]) for (const type of ["browser-open-download", "browser-reveal-download", "browser-start-download-drag"]) {
    await assert.rejects(request({ type, downloadId: restored.find(d => d.filename === `${name}.txt`).id }), /no longer available/);
  }
  assert.deepEqual(await app.evaluate(() => globalThis.downloadRestoreCalls), calls);
  await capture("restored-actions.png");
  await quit(); await launch(); await showDownloads();
  await expect(row("custom").getByRole("button", { name: "Show in Finder", exact: true })).toBeVisible();
  await expect(row("default").getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await expect(row("legacy").getByRole("button")).toHaveCount(0);
  assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", bytesPerDownload: bytes.length,
    actualHttpDownloads: 6, normalQuitRestarts: 2, exactDefaultAndCustomDestination: true, changedFolderDecoyUntouched: true,
    missingDirectorySymlinkLegacyUnavailable: true, privateDestinationsAbsentFromPublicState: true,
    keyboardOpenRevealAndDragRouting: true, nativeHandoffMocked: true, realProfileVerified: false }, null, 2));
  console.log("Download restart smoke passed: six actual HTTP downloads, two normal restarts, exact default/custom destinations, untouched same-name decoys, unavailable/legacy guards and private state.");
} catch (error) { await capture("failure.png").catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); }
