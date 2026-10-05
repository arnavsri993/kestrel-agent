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
  args: process.env.KESTREL_DESKTOP_USE_SOURCE === "1" ? [resolve("apps/desktop"), "--use-mock-keychain"] : executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
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
 await app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("/renderer/index.html"));
  window.setSize(1440, 900);
 });
 for (let index = 0; index < 3; index++) assert((await request({ type: "browser-create-tab", input: "", active: true })).ok);
 await expect(page.locator(".browser-tab")).toHaveCount(4);
 const lowCountState = (await request({ type: "browser-get-state" })).browserState;
 for (const sizing of ["scrolling", "shrinking"]) {
  assert((await request({ type: "browser-update-settings", settings: { ...lowCountState.settings, tabSizing: sizing } })).ok);
  await expect.poll(() => page.evaluate(() => {
   const rail = document.querySelector(".browser-tabs").getBoundingClientRect();
   const tabs = [...document.querySelectorAll(".browser-tabs .browser-tab")].map(node => node.getBoundingClientRect());
   const plus = document.querySelector(".browser-new-tab").getBoundingClientRect();
   return tabs.length === 4 && tabs.every(tab => tab.width >= 112 && tab.width <= 221) &&
    Math.abs(tabs[0].left - rail.left) <= 2 && Math.abs(tabs.at(-1).right - rail.right) <= 2 &&
    plus.left - tabs.at(-1).right >= 0 && plus.left - tabs.at(-1).right <= 10 && plus.right <= innerWidth + 1;
  })).toBe(true);
 }
 for (let index = 0; index < 11; index++) assert((await request({ type: "browser-create-tab", input: "", active: true })).ok);
 await expect(page.locator(".browser-tab")).toHaveCount(15);
 const state = (await request({ type: "browser-get-state" })).browserState;
	 const first = state.tabs[0].id;
	 const last = state.tabs.at(-1).id;
	 const applyAndCheckLongTitles = async () => {
	  const result = await page.locator(".browser-tab-title").evaluateAll(nodes => {
	   const prefix = "A long fixture tab title that must stay contained";
	   nodes.forEach((node, index) => { node.textContent = `${prefix} ${index + 1}`; });
	   const measurements = nodes.map((node, index) => {
	    const css = getComputedStyle(node);
	    const box = node.getBoundingClientRect();
	    const tabBox = node.closest(".browser-tab").getBoundingClientRect();
	    return {
	     exact: node.textContent === `${prefix} ${index + 1}`,
	     hidden: css.display === "none",
	     ellipsis: css.overflowX === "hidden" && css.textOverflow === "ellipsis" && css.whiteSpace === "nowrap",
	     truncated: node.scrollWidth > node.clientWidth + 1,
	     contained: box.left >= tabBox.left - 1 && box.right <= tabBox.right + 1,
	    };
	   });
	   return {
	    count: measurements.length,
	    exact: measurements.every(item => item.exact),
	    contained: measurements.every(item => item.hidden || item.contained),
	    titleTreatment: measurements.every(item => item.hidden || item.ellipsis),
	    stressed: measurements.some(item => item.hidden || item.truncated),
	   };
	  });
	  assert.equal(result.count, 15, "The long-title fixture must cover every tab");
	  assert(result.exact, "React must render the intended long-title fixture before measurement");
	  assert(result.contained, "Long tab titles must remain inside their tab bounds");
	  assert(result.titleTreatment, "Visible long titles must use single-line ellipsis containment");
	  assert(result.stressed, "The fixture must exercise truncation or the crowded favicon-only treatment");
	 };
	 for (const sizing of ["scrolling", "shrinking"]) {
  assert((await request({ type: "browser-update-settings", settings: { ...state.settings, tabSizing: sizing } })).ok);
  for (const [width, height, zoom] of [[1440, 900, 1], [760, 680, 1], [1440, 900, 2]]) {
   await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("/renderer/index.html"));
    window.setMinimumSize(400, 400); window.setSize(width, height); window.webContents.setZoomFactor(zoom);
   }, { width, height, zoom });
	   for (const tabId of [first, last]) {
	    assert((await request({ type: "browser-select-tab", tabId })).ok);
	    await expect(page.locator(`.browser-tab[data-tab-id="${tabId}"]`)).toHaveClass(/active/);
	    // Apply after selection settles so the React state update cannot replace
	    // the offline long-title fixture before geometry is measured.
	    await applyAndCheckLongTitles();
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
 for (const zoom of [1, 2]) {
  await app.evaluate(({ BrowserWindow }, zoom) => {
   const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("/renderer/index.html"));
   w.setSize(1024, 684); w.webContents.setZoomFactor(zoom);
  }, zoom);
  await page.getByRole("button", { name: "Tab tools", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Tab tools", exact: true });
  await expect(menu).toBeVisible();
  const openTabs = menu.getByRole("menuitem", { name: "Open Tabs", exact: true });
  if (await openTabs.getAttribute("aria-expanded") !== "true") await openTabs.click();
  await expect(menu.locator(".browser-tab-search-results button")).toHaveCount(15);
  await expect.poll(() => menu.evaluate(node => {
   const box = node.getBoundingClientRect();
   return {
    fits: box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight - 8,
    x: box.x, y: box.y, width: box.width, height: box.height, viewport: [innerWidth, innerHeight],
    maxHeight: getComputedStyle(node).maxHeight,
   };
  })).toMatchObject({ fits: true });
  // Keyboard users must still reach the last action when the menu is constrained.
  const lastAction = menu.getByRole("menuitem").last();
  await lastAction.focus();
  await expect.poll(() => lastAction.evaluate(node => {
   const box = node.getBoundingClientRect();
   const menuBox = node.closest('[role="menu"]').getBoundingClientRect();
   return box.top >= menuBox.top - 1 && box.bottom <= menuBox.bottom + 1;
  })).toBe(true);
  await page.screenshot({ animations: "disabled", path: join(evidence, `vertical-menu-${zoom}.png`) });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
 }
 assert.deepEqual(errors, []);
 console.log("Tab fit smoke passed: compact four-tab rail, 15 long tabs, both sizing modes, narrow width, 200% zoom, selected-tab visibility and contained vertical menus with reachable actions.");
} finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
