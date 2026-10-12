import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-download-actions-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_DOWNLOAD_ACTIONS_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, { HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "download-fixture", LOGNAME: "download-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" });
const filename = "quarterly-report-with-a-long-file-name-for-the-download-actions-layout-check.txt";
const chunk = Buffer.alloc(128 * 1024, "x");
const streams = new Map();
const server = createServer((req, res) => {
  const name = req.url === "/pending" ? "pending" : req.url === "/report" ? "report" : null;
  if (!name) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/plain", "content-length": String(chunk.length * 2),
    "content-disposition": `attachment; filename="${name === "report" ? filename : "pending.txt"}"`, "cache-control": "no-store" });
  res.write(chunk); streams.set(name, res);
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
  page = await app.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(15_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
  await page.reload();
  const request = async input => { const r = await page.evaluate(input => window.kestrel.request(input), input); assert(r.ok, r.error); return r; };
  const state = async () => (await request({ type: "browser-get-state" })).browserState;
  for (const name of ["pending", "report"]) {
    const r = await request({ type: "browser-create-tab", active: true });
    await request({ type: "browser-navigate", tabId: r.browserState.activeTabId, input: `${origin}/${name}` });
  }
  await expect.poll(async () => (await state()).downloads.filter(d => d.status === "progressing" && d.receivedBytes >= chunk.length).length).toBe(2);
  streams.get("report").end(chunk);
  await expect.poll(async () => (await state()).downloads.find(d => d.filename === filename)?.status).toBe("completed");
  const saved = join(root, "profile", "browser-downloads", filename);
  assert.deepEqual(readFileSync(saved), Buffer.concat([chunk, chunk]));
  await request({ type: "browser-create-tab", input: "kestrel://downloads", active: true });
  await page.getByRole("heading", { name: "Downloaded files", exact: true }).waitFor();
  const menu = page.getByRole("menu", { name: "Downloads", exact: true });
  if (await menu.isVisible()) { await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible(); }
  const toggle = page.locator("#browser-agent-toggle");
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
  window = await app.browserWindow(page);
  // Exercise renderer reflow below the app's normal native minimum in this owned window.
  await window.evaluate(window => window.setMinimumSize(400, 400));
  const row = name => page.locator(".download-list li").filter({ has: page.getByText(name, { exact: true }) });
  const geometries = [];
  for (const [width, zoom] of [[1100, 1], [760, 1], [520, 1], [1100, 2]]) {
    await window.evaluate((window, { width, zoom }) => { window.setSize(width, 800); window.webContents.setZoomFactor(zoom); }, { width, zoom });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / zoom);
    await expect(row(filename)).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    const geometry = await row(filename).evaluate(row => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const buttons = [...row.querySelectorAll("button")].map(button => { const range = document.createRange(); range.selectNodeContents(button);
        return { text: button.textContent.trim(), ...rect(button), lines: range.getClientRects().length }; });
      return { row: rect(row), metadata: rect(row.querySelector("strong").parentElement), buttons,
        overflow: document.documentElement.scrollWidth > innerWidth + 1, viewportWidth: innerWidth };
    });
    await capture(`downloads-${width}-${zoom}x.png`);
    assert.equal(geometry.overflow, false, `No page overflow at ${width}/${zoom}x`);
    assert.deepEqual(geometry.buttons.map(b => b.text), ["Open", "Show in Finder"]);
    for (const b of geometry.buttons) { assert.equal(b.lines, 1, `${b.text} label must stay on one line at ${width}/${zoom}x`);
      assert(b.x >= geometry.metadata.x - 1 && b.right <= geometry.row.right + 1, `${b.text} stays beside/below metadata, within its row`); }
    geometries.push({ width, zoom, ...geometry });
  }
  await window.evaluate(window => { window.setSize(1100, 800); window.webContents.setZoomFactor(1); });
  // Verify actual UI/IPC routing; prevent launching Finder or a default app on the host.
  await app.evaluate(({ shell }) => { globalThis.downloadActionCalls = [];
    shell.openPath = async path => { globalThis.downloadActionCalls.push(["open", path]); return ""; };
    shell.showItemInFolder = path => { globalThis.downloadActionCalls.push(["reveal", path]); }; });
  const open = row(filename).getByRole("button", { name: "Open", exact: true });
  await open.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const reveal = row(filename).getByRole("button", { name: "Show in Finder", exact: true });
  await expect(reveal).toBeFocused();
  assert(await reveal.evaluate(button => button.matches(":focus-visible")), "Keyboard focus remains visible");
  await page.keyboard.press("Enter");
  await expect.poll(() => app.evaluate(() => globalThis.downloadActionCalls)).toEqual([["open", saved], ["reveal", saved]]);
  await row("pending.txt").getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(row("pending.txt").locator("small")).toContainText("Cancelled");
  await expect(row("pending.txt").getByRole("button")).toHaveCount(0);
  await page.reload(); await expect(row(filename).getByRole("button", { name: "Show in Finder", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", geometries,
    completedBytes: chunk.length * 2, keyboardOpenRevealCancel: true, fixtureWindowMinimumOverridden: true, nativeHandoffMocked: true, realProfileVerified: false }, null, 2));
  console.log("Download actions smoke passed: actual HTTP files, 1100/760/520px and 200% zoom, single-line labels, containment, keyboard routing/cancel and reload.");
} catch (error) { await capture("failure.png").catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); }
