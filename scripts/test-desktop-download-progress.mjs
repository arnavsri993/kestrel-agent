import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Actual local HTTP downloads and desktop IPC; no provider or real user profile.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-download-progress-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_DOWNLOAD_PROGRESS_EVIDENCE_DIR;
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
  const name = req.url === "/known" ? "known" : req.url === "/unknown" ? "unknown" : null;
  if (!name) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": "text/plain", "content-disposition": `attachment; filename="${name}.txt"`, "cache-control": "no-store" };
  if (name === "known") headers["content-length"] = String(chunk.length * 2);
  res.writeHead(200, headers);
  res.write(chunk); // Hold the rest until progress is inspected, avoiding timing races.
  streams.set(name, res);
});
let app;
let page;
async function capture(name) {
  if (!evidence || !page) return;
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  await page.screenshot();
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
    return (await window.webContents.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
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
  for (const name of ["unknown", "known"]) {
    const response = await request({ type: "browser-create-tab", active: true });
    await request({ type: "browser-navigate", tabId: response.browserState.activeTabId, input: `${origin}/${name}` });
  }
  await expect.poll(async () => {
    const downloads = (await state()).downloads;
    return ["unknown.txt", "known.txt"].every(filename => downloads.some(d => d.filename === filename && d.status === "progressing" && (filename === "known.txt" ? d.receivedBytes === chunk.length : d.receivedBytes > 0)));
  }).toBe(true);
  const active = (await state()).downloads;
  const unknown = active.find(d => d.filename === "unknown.txt");
  const known = active.find(d => d.filename === "known.txt");
  assert.equal(unknown.totalBytes, 0);
  assert.equal(known.totalBytes, chunk.length * 2);
  await request({ type: "browser-create-tab", input: "kestrel://downloads", active: true });
  await page.getByRole("heading", { name: "Downloaded files", exact: true }).waitFor();
  const downloadsMenu = page.getByRole("menu", { name: "Downloads", exact: true });
  if (await downloadsMenu.isVisible()) { await page.keyboard.press("Escape"); await expect(downloadsMenu).not.toBeVisible(); }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1")).setSize(1100, 800);
  });
  const row = name => page.locator(".download-list li").filter({ has: page.getByText(`${name}.txt`, { exact: true }) });
  const unknownProgress = row("unknown").locator("progress");
  await unknownProgress.waitFor();
  const unknownPosition = await unknownProgress.evaluate(node => node.position);
  assert.equal(unknownPosition, -1, "Unknown-size downloads must be indeterminate, not complete.");
  assert.equal(await unknownProgress.getAttribute("value"), null);
  await expect(unknownProgress).toHaveAttribute("aria-label", "Download progress for unknown.txt");
  await expect(unknownProgress).toHaveAttribute("aria-valuetext", /total size unknown/);
  assert(!/\d+%/.test(await row("unknown").locator("small").innerText()));
  await expect(row("unknown").locator("small")).toContainText("downloaded");
  const knownProgress = row("known").locator("progress");
  await expect(knownProgress).toHaveAttribute("value", String(chunk.length));
  await expect(knownProgress).toHaveAttribute("max", String(chunk.length * 2));
  await expect(knownProgress).toHaveAttribute("aria-valuetext", `${chunk.length} of ${chunk.length * 2} bytes downloaded`);
  assert.equal(await knownProgress.evaluate(node => node.position), 0.5);
  await capture("active-downloads.png");
  await row("unknown").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(async () => (await state()).downloads.find(d => d.id === unknown.id)?.status).toBe("cancelled");
  await expect(row("unknown").locator("progress")).toHaveCount(0);
  streams.get("known").end(chunk);
  await expect.poll(async () => (await state()).downloads.find(d => d.id === known.id)?.status, { timeout: 20_000 }).toBe("completed");
  await expect(row("known").locator("progress")).toHaveCount(0);
  await expect(row("known").getByRole("button", { name: "Show in Finder", exact: true })).toBeVisible();
  const saved = join(root, "profile", "browser-downloads", "known.txt");
  assert.equal(readFileSync(saved).length, chunk.length * 2);
  await page.reload();
  await expect(row("known").locator("small")).toContainText("Completed");
  await expect(row("unknown").locator("small")).toContainText("Cancelled");
  assert.deepEqual(errors, []);
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", unknownTotalBytes: unknown.totalBytes, unknownPosition, knownPosition: 0.5, cancelledUnknown: true, completedKnown: true, savedBytes: chunk.length * 2, realProfileVerified: false }, null, 2));
  console.log("Download progress smoke passed: real chunked HTTP indeterminate, known length50%, cancel, completed file and reload.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections(); await new Promise(done => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
