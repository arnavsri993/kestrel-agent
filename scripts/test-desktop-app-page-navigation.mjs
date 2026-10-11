import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-app-page-navigation-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_APP_PAGE_NAVIGATION_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
if (evidence) mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(env, {
  HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
  USER: "navigation-fixture", LOGNAME: "navigation-fixture", KESTREL_TEST_USER_DATA: join(root, "profile"),
  KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
const requests = new Map();
const server = createServer((req, res) => {
  requests.set(req.url, (requests.get(req.url) ?? 0) + 1);
  const title = req.url === "/history-target" ? "History target" : "Address target";
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
});
let app; let page;
const nativeDocuments = [];
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
async function captureDocument(url, name, title) {
  const attached = async () => app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1"));
    const child = window.contentView.children.find(view => view.webContents?.getURL() === url);
    const bounds = child?.getBounds();
    return Boolean(bounds && bounds.width > 100 && bounds.height > 100);
  }, url);
  await expect.poll(attached).toBe(true);
  const result = await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1"));
    const child = window.contentView.children.find(view => view.webContents?.getURL() === url);
    return { bounds: child.getBounds(), title: await child.webContents.executeJavaScript("document.querySelector('h1')?.textContent"),
      png: (await child.webContents.capturePage()).toPNG().toString("base64") };
  }, url);
  assert.equal(result.title, title);
  if (evidence) writeFileSync(join(evidence, name), Buffer.from(result.png, "base64"));
  nativeDocuments.push({ file: name, url, title: result.title, bounds: result.bounds, attached: true });
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
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes("petOverlay=1")).setSize(1100, 800);
  });
  const request = async input => {
    const response = await page.evaluate(input => window.kestrel.request(input), input);
    assert(response.ok, response.error); return response;
  };
  const state = async () => (await request({ type: "browser-get-state" })).browserState;
  const created = await request({ type: "browser-create-tab", active: true });
  const id = created.browserState.activeTabId;
  const historyUrl = `${origin}/history-target`;
  await request({ type: "browser-navigate", tabId: id, input: historyUrl });
  const loaded = async (url, title) => {
    await expect.poll(async () => {
      const current = await state();
      const tab = current.tabs.find(tab => tab.id === id);
      return current.activeTabId === id && tab?.url === url && tab?.title === title && !tab.loading;
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => app.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().find(w => w.getURL() === url)?.getTitle(), url)).toBe(title);
  };
  await loaded(historyUrl, "History target");
  const countsBefore = (await state()).tabs.length;
  for (const appPage of ["settings", "bookmarks", "downloads"]) {
    await request({ type: "browser-navigate", tabId: id, input: `kestrel://${appPage}` });
    const target = `${origin}/address-${appPage}`;
    await page.locator("#browser-address-input").fill(target);
    await page.locator("#browser-address-input").press("Enter");
    await loaded(target, "Address target");
    assert.equal(requests.get(`/address-${appPage}`), 1);
    assert.equal((await state()).tabs.length, countsBefore);
  }
  await capture("address-navigation.png");
  await captureDocument(`${origin}/address-downloads`, "address-document.png", "Address target");
  await request({ type: "browser-navigate", tabId: id, input: "kestrel://history" });
  await page.getByRole("heading", { name: "Browsing history", exact: true }).waitFor();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".browser-history-popover-search input").fill("History target");
  await expect(page.locator(".browser-history-popover-list li strong")).toHaveText(["History target"]);
  await capture("history-origin.png");
  const beforeReopen = requests.get("/history-target");
  await page.locator(".browser-history-popover-list li button").click();
  await loaded(historyUrl, "History target");
  await expect.poll(() => requests.get("/history-target")).toBeGreaterThan(beforeReopen);
  assert.equal((await state()).tabs.length, countsBefore);
  assert.deepEqual(errors, []);
  await capture("history-reopened.png");
  await captureDocument(historyUrl, "history-document.png", "History target");
  if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({
    executable: executable ?? "source Electron", addressAppPages: ["settings", "bookmarks", "downloads"],
    historyPopupFromAppPage: true, sameTabPreserved: true, actualHttpRequests: Object.fromEntries(requests),
    shellCaptures: ["address-navigation.png", "history-origin.png", "history-reopened.png"], nativeDocuments,
    realProfileVerified: false, liveThreatProviderVerified: false,
  }, null, 2));
  console.log("App-page navigation smoke passed: real HTTP loads via address field and History popup, same tab preserved.");
} catch (error) {
  await capture("failure.png").catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections(); await new Promise(done => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
