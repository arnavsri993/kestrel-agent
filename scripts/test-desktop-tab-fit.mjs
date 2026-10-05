import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-tab-fit-"));
const evidence = resolve(".tmp/tab-fit");
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
let app;
try {
 app = await electron.launch({
  executablePath: executable || createRequire(resolve("apps/desktop/package.json"))("electron"),
  args: executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
  env: { ...process.env, KESTREL_TEST_USER_DATA: root, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" },
 });
 const page = await app.firstWindow();
 const errors = [];
 page.on("pageerror", e => errors.push(e.message));
 await page.waitForLoadState("domcontentloaded");
 await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 await page.reload();
 await page.locator("#new-tab-title").waitFor();
 const request = input => page.evaluate(input => window.kestrel.request(input), input);
 for (let index = 0; index < 14; index++) assert((await request({ type: "browser-create-tab", input: "", active: true })).ok);
 await expect(page.locator(".browser-tab")).toHaveCount(15);
 const state = (await request({ type: "browser-get-state" })).browserState;
 const first = state.tabs[0].id;
 const last = state.tabs.at(-1).id;
 for (const sizing of ["scrolling", "shrinking"]) {
  assert((await request({ type: "browser-update-settings", settings: { ...state.settings, tabSizing: sizing } })).ok);
  for (const [width, height, zoom] of [[1440, 900, 1], [760, 680, 1], [1440, 900, 2]]) {
   await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("/renderer/index.html"));
    window.setMinimumSize(400, 400); window.setSize(width, height); window.webContents.setZoomFactor(zoom);
   }, { width, height, zoom });
   // Long stored page titles exercise the same DOM structure without network access.
   await page.locator(".browser-tab-title").evaluateAll(nodes => nodes.forEach((node, index) => { node.textContent = `A long fixture tab title that must stay contained ${index + 1}`; }));
   for (const tabId of [first, last]) {
    assert((await request({ type: "browser-select-tab", tabId })).ok);
    await expect.poll(() => page.evaluate(() => {
     const row = document.querySelector(".browser-tab-row-horizontal").getBoundingClientRect();
     const list = document.querySelector(".browser-tabs").getBoundingClientRect();
     const selected = document.querySelector(".browser-tab.active").getBoundingClientRect();
     const plus = document.querySelector(".browser-new-tab").getBoundingClientRect();
     return row.left >= -1 && row.right <= innerWidth + 1 && list.left >= row.left && list.right <= row.right + 1 &&
      selected.left >= list.left - 1 && selected.right <= list.right + 1 && plus.right <= row.right + 1 && plus.left >= list.right - 1;
    })).toBe(true);
   }
   const shape = await page.locator(".browser-tab.active").evaluate(node => {
    const css = getComputedStyle(node); const box = node.getBoundingClientRect();
    return { top: parseFloat(css.borderTopLeftRadius), bottom: parseFloat(css.borderBottomLeftRadius), height: box.height };
   });
   assert(shape.top > 0 && shape.top < shape.height / 2 && shape.bottom === 0, "Tabs must have normal rounded top corners, not capsules");
   await page.screenshot({ animations: "disabled", path: join(evidence, `${sizing}-${width}-${zoom}.png`) });
  }
 }
 await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("/renderer/index.html"));
  w.webContents.setZoomFactor(1); w.setSize(1440, 900);
 });
 assert((await request({ type: "browser-update-settings", settings: { ...state.settings, tabLayout: "vertical" } })).ok);
 await expect(page.locator(".browser-tab-row-vertical .browser-tab.active")).toBeVisible();
 assert.deepEqual(errors, []);
 console.log("Tab fit smoke passed: 15 long tabs, both sizing modes, narrow width, 200% zoom, selected-tab visibility and vertical mode.");
} finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
