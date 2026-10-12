import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Real local HTTP downloads and cancellation IPC in a disposable profile.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-download-cancel-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_DOWNLOAD_CANCEL_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "download-fixture", LOGNAME: "download-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
const chunk = Buffer.alloc(128 * 1024, "x");
const streams = new Map();
const server = createServer((req, res) => {
  const name = req.url === "/cancel" ? "cancel" : req.url === "/complete" ? "complete" : null;
  if (!name) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/plain", "content-length": String(chunk.length * 2),
    "content-disposition": `attachment; filename="${name}.txt"`, "cache-control": "no-store" });
  res.write(chunk); streams.set(name, res); // Keep both downloads active until explicitly finished.
});
let app, page, window;
async function capture(name) {
  if (!evidence || !window) return;
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  await page.screenshot();
  const png = await window.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = await electron.launch({ executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env });
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  const raw = input => page.evaluate(input => window.kestrel.request(input), input);
  const request = async input => { const response = await raw(input); assert(response.ok, response.error); return response; };
  const state = async () => (await request({ type: "browser-get-state" })).browserState;
  for (const name of ["cancel", "complete"]) {
    const response = await request({ type: "browser-create-tab", active: true });
    await request({ type: "browser-navigate", tabId: response.browserState.activeTabId, input: `${origin}/${name}` });
  }
  await expect.poll(async () => {
    const downloads = (await state()).downloads;
    return ["cancel.txt", "complete.txt"].every(filename => downloads.some(d => d.filename === filename && d.status === "progressing" && d.receivedBytes >= chunk.length));
  }).toBe(true);
  const downloads = (await state()).downloads;
  const cancelled = downloads.find(d => d.filename === "cancel.txt");
  const completed = downloads.find(d => d.filename === "complete.txt");
  await request({ type: "browser-create-tab", input: "kestrel://downloads", active: true });
  await page.getByRole("heading", { name: "Downloaded files", exact: true }).waitFor();
  const menu = page.getByRole("menu", { name: "Downloads", exact: true });
  if (await menu.isVisible()) { await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible(); }
  window = await app.browserWindow(page); await window.evaluate(window => window.setSize(1100, 800));
  const row = name => page.locator(".download-list li").filter({ has: page.getByText(`${name}.txt`, { exact: true }) });
  await row("cancel").getByRole("button", { name: "Cancel", exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(async () => (await state()).downloads.find(d => d.id === cancelled.id)?.status).toBe("cancelled");
  await expect(row("cancel").getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(row("cancel").locator("progress")).toHaveCount(0);
  await expect(page.locator(".browser-inline-error")).toHaveCount(0);
  await request({ type: "browser-cancel-download", downloadId: cancelled.id });
  await capture("cancelled.png");
  streams.get("complete").end(chunk);
  await expect.poll(async () => (await state()).downloads.find(d => d.id === completed.id)?.status, { timeout: 20_000 }).toBe("completed");
  const terminal = (await state()).downloads.find(d => d.id === completed.id);
  const saved = join(root, "profile", "browser-downloads", "complete.txt");
  const bytes = readFileSync(saved); assert.deepEqual(bytes, Buffer.concat([chunk, chunk]));
  await request({ type: "browser-cancel-download", downloadId: completed.id });
  assert.deepEqual((await state()).downloads.find(d => d.id === completed.id), terminal);
  assert.deepEqual(readFileSync(saved), bytes);
  await expect(row("complete").getByRole("button", { name: "Show in Finder", exact: true })).toBeVisible();
  await expect(row("complete").getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await assert.rejects(raw({ type: "browser-cancel-download", downloadId: "download-00000000-0000-0000-0000-000000000000" }), /This download is not in progress/);
  await capture("completed.png");
  await page.reload();
  await expect(row("cancel").locator("small")).toContainText("Cancelled");
  await expect(row("complete").locator("small")).toContainText("Completed");
  assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", rapidUiCancel: true,
    repeatedCancelledRequest: true, lateCompletedRequest: true, completedBytes: bytes.length, unknownIdRejected: true,
    nativeHandoffVerified: false, realProfileVerified: false }, null, 2));
  console.log("Download cancellation smoke passed: rapid UI Cancel, repeated request, completed-file preservation, unknown ID and reload.");
} catch (error) { await capture("failure.png").catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); }
