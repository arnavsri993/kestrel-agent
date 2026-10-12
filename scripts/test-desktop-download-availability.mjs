import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Actual HTTP files in a disposable profile; native host handoffs are explicit stubs.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-download-availability-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_DOWNLOAD_AVAILABILITY_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, { HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "download-fixture", LOGNAME: "download-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" });
const names = ["open", "reveal", "drag", "retained"];
const bytes = Buffer.alloc(16 * 1024, "download-availability-proof");
const paths = new Map(names.map(name => [name, join(root, "profile", "browser-downloads", `${name}.txt`)]));
const server = createServer((req, res) => {
  const name = req.url?.slice(1);
  if (!names.includes(name)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/plain", "content-length": String(bytes.length),
    "content-disposition": `attachment; filename="${name}.txt"`, "cache-control": "no-store" }); res.end(bytes);
});
let app, page, window;
const errors = [];
const request = async input => { const response = await page.evaluate(input => window.kestrel.request(input), input); assert(response.ok, response.error); return response; };
const state = async () => (await request({ type: "browser-get-state" })).browserState;
const row = name => page.locator(".download-list li").filter({ has: page.getByText(`${name}.txt`, { exact: true }) });
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
  page = await app.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
  await page.reload(); window = await app.browserWindow(page); await window.evaluate(window => window.setSize(1100, 850));
  for (const name of names) {
    const response = await request({ type: "browser-create-tab", active: true });
    await request({ type: "browser-navigate", tabId: response.browserState.activeTabId, input: `${origin}/${name}` });
    await expect.poll(async () => (await state()).downloads.find(d => d.filename === `${name}.txt`)?.status, { timeout: 20_000 }).toBe("completed");
    assert.deepEqual(readFileSync(paths.get(name)), bytes);
  }
  await request({ type: "browser-create-tab", input: "kestrel://downloads", active: true });
  await page.getByRole("heading", { name: "Downloaded files", exact: true }).waitFor();
  const menu = page.getByRole("menu", { name: "Downloads", exact: true });
  if (await menu.isVisible()) { await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible(); }
  const toggle = page.locator("#browser-agent-toggle");
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
  const before = (await state()).downloads;
  assert(before.every(d => d.status === "completed" && d.canReveal));
  await app.evaluate(({ shell }) => {
    globalThis.downloadAvailabilityCalls = []; globalThis.downloadAvailabilityOpenError = "";
    shell.openPath = async path => { globalThis.downloadAvailabilityCalls.push(["open", path]); return globalThis.downloadAvailabilityOpenError; };
    shell.showItemInFolder = path => globalThis.downloadAvailabilityCalls.push(["reveal", path]);
  });
  await window.evaluate(window => { window.webContents.startDrag = item => globalThis.downloadAvailabilityCalls.push(["drag", item.file]); });
  await capture("available.png");
  const handled = [];
  for (const name of ["open", "reveal", "drag"]) {
    rmSync(paths.get(name)); // Only a file this fixture created; user data is never used.
    if (name === "drag") {
      await page.getByRole("button", { name: "Downloads", exact: true }).click(); await menu.waitFor();
      const item = menu.getByRole("listitem").filter({ has: page.getByText("drag.txt", { exact: true }) });
      await expect(item).toHaveAttribute("draggable", "true"); await item.dispatchEvent("dragstart");
      await expect(menu).not.toBeVisible();
    } else {
      await row(name).getByRole("button", { name: name === "open" ? "Open" : "Show in Finder", exact: true }).focus();
      await page.keyboard.press("Enter");
    }
    await expect.poll(async () => (await state()).downloads.find(d => d.filename === `${name}.txt`)?.canReveal).toBe(false);
    await expect(row(name).getByRole("button")).toHaveCount(0);
    if (name === "drag") {
      await page.getByRole("button", { name: "Downloads", exact: true }).click(); await menu.waitFor();
      await expect(menu.getByRole("listitem").filter({ has: page.getByText("drag.txt", { exact: true }) })).toHaveAttribute("draggable", "false");
      await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible();
    }
    await expect(page.locator(".browser-inline-error")).toContainText("no longer available");
    handled.push(name);
    assert.deepEqual((await state()).downloads, before.map(d => handled.includes(d.filename.replace(".txt", "")) ? { ...d, canReveal: false } : d));
    assert.deepEqual(await app.evaluate(() => globalThis.downloadAvailabilityCalls), []);
    await capture(`unavailable-${name}.png`);
  }
  const stored = JSON.parse(readFileSync(join(root, "profile", "browser", "state.json"), "utf8"));
  for (const name of handled) assert.equal(stored.downloads.find(d => d.filename === `${name}.txt`).canReveal, false);
  if (stored.downloadPaths) for (const name of handled) {
    const download = stored.downloads.find(d => d.filename === `${name}.txt`);
    assert.equal(stored.downloadPaths[download.id], paths.get(name), "Unavailable state retains the original private destination");
  }
  await app.evaluate(() => { globalThis.downloadAvailabilityOpenError = "Default application unavailable for this fixture."; });
  await row("retained").getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".browser-inline-error")).toContainText(/Default application unavailable|The download action failed/);
  assert.equal((await state()).downloads.find(d => d.filename === "retained.txt").canReveal, true);
  await expect(row("retained").getByRole("button")).toHaveCount(2);
  await app.evaluate(() => { globalThis.downloadAvailabilityOpenError = ""; });
  await row("retained").getByRole("button", { name: "Open", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".browser-inline-error")).toHaveCount(0);
  await row("retained").getByRole("button", { name: "Show in Finder", exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.downloadAvailabilityCalls)).toEqual([["open", paths.get("retained")], ["open", paths.get("retained")], ["reveal", paths.get("retained")]]);
  assert.deepEqual(readFileSync(paths.get("retained")), bytes);
  await page.reload();
  await page.getByRole("heading", { name: "Downloaded files", exact: true }).waitFor();
  await expect(page.getByText("Starting on this Mac…", { exact: true })).toHaveCount(0);
  for (const name of handled) { await expect(row(name)).toBeVisible(); await expect(row(name).getByRole("button")).toHaveCount(0); }
  await expect(row("retained").getByRole("button")).toHaveCount(2);
  await capture("after-reload.png"); assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", actualHttpDownloads: 4,
    bytesPerDownload: bytes.length, keyboardOpenReveal: true, syntheticDomDrag: true, unavailableStatePersisted: true,
    recordsBytesAndOtherFilePreserved: true, privatePathRetentionVerified: Boolean(stored.downloadPaths), nativeFailureDoesNotInvalidateExistingFile: true, visibleErrorsAndRecovery: true,
    noUnhandledRendererErrors: true, nativeHandoffMocked: true, realProfileVerified: false }, null, 2));
  console.log("Download availability smoke passed: actual HTTP files, removed-file Open/Finder/Drag feedback, persisted availability, visible errors/recovery, preserved history/other file and no unhandled renderer errors.");
} catch (error) { await capture("failure.png").catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); }
