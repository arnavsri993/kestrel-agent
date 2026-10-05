import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";
const root = mkdtempSync(join(tmpdir(), "kestrel-home-glass-"));
const evidence = resolve(".tmp/new-tab-glass");
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const require = createRequire(resolve("apps/desktop/package.json"));
let application;
try {
 application = await electron.launch({ executablePath: executable || require("electron"), args: process.env.KESTREL_DESKTOP_USE_SOURCE === "1" ? [resolve("apps/desktop"), "--use-mock-keychain"] : executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")], env: { ...process.env, KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_TEST_USER_DATA: join(root, "profile"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1" } });
 const page = await application.firstWindow();
 const errors = [];
 page.on("pageerror", (error) => errors.push(error.message));
 await page.waitForLoadState("domcontentloaded");
 await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 await page.reload();
 await page.locator("#new-tab-title").waitFor();
 await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay")); win.setSize(1440, 1000); win.show(); win.focus(); });
 await page.evaluate(async () => {
  const state = await window.kestrel.request({ type: "browser-get-state" });
  const result = await window.kestrel.request({ type: "browser-update-settings", settings: { ...state.browserState.settings, newTabBackground: "mountains" } });
  if (!result.ok) throw new Error(result.error);
 });
 await page.locator(".new-tab-page-mountains").waitFor();
 const composer = page.locator(".kestrel-home-composer");
 const input = page.locator("#new-tab-chat-input");
 await page.locator("#new-tab-title").click();
 const compact = await composer.boundingBox();
 await input.focus();
 await page.waitForFunction(() => document.querySelector(".kestrel-home-composer").getBoundingClientRect().height > 90);
 const expanded = await composer.boundingBox();
 assert(expanded.height > compact.height + 20, "Focus should expand the composer vertically");
 assert(await page.getByRole("button", { name: "Add files", exact: true }).isVisible());
 await page.locator(".new-tab-access-trigger").click();
 assert(await page.getByRole("menu", { name: "Approval policy" }).isVisible());
 await page.getByRole("menuitemradio", { name: /^Ask for approval/ }).click();
 assert(await page.getByRole("button", { name: "Approval policy: Ask for approval" }).isVisible());
 await page.locator(".new-tab-access-trigger").click();
 await page.getByRole("menuitemradio", { name: /^Approve for me/ }).click();
 await input.focus();
 await input.evaluate((node) => { const data = new DataTransfer(); data.setData("text/plain", "Synthetic pasted context.\n".repeat(400)); node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
 await page.locator(".new-tab-composer-attachments button").waitFor();
 assert.equal(await input.inputValue(), "");
 await page.locator(".new-tab-composer-attachments button").click();
 assert.equal(await page.locator(".new-tab-composer-attachments button").count(), 0);
 await page.getByRole("button", { name: "Add shortcut", exact: true }).click();
 await page.getByRole("textbox", { name: "Name", exact: true }).fill("Example");
 await page.getByRole("textbox", { name: "Website", exact: true }).fill("example.com");
 await page.getByRole("button", { name: "Add", exact: true }).click();
 await page.locator(".home-site-shortcut button[title='Example · https://example.com/']").waitFor();
 await page.reload();
 await page.locator(".home-site-shortcut button[title='Example · https://example.com/']").waitFor();
 await page.locator(".home-personalize summary").click();
 await page.getByLabel("Wallpaper", { exact: true }).selectOption("dawn");
 await page.locator(".new-tab-page-dawn").waitFor();
 await page.getByRole("button", { name: "Arrange widgets" }).click();
 await page.locator(".kestrel-widget-canvas.is-editing").waitFor({ state: "visible" });
 await page.getByRole("button", { name: "Done", exact: true }).click();
 async function showWidget(id) {
  await page.waitForFunction(() => { const canvas = document.querySelector(".kestrel-widget-canvas"); return canvas && Number(canvas.dataset.viewportHeight) > 0 && Math.abs(Number(canvas.dataset.viewportHeight) - canvas.getBoundingClientRect().height) < 2; });
  const existing = page.locator(`[data-kestrel-widget-id="${id}"]`);
  if (await existing.isVisible()) return existing;
  const previous = page.getByRole("button", { name: "Previous widget page", exact: true });
  while (await previous.isVisible() && await previous.isEnabled({ timeout: 1000 }).catch(() => false)) await previous.click();
  for (let attempt = 0; attempt < 20; attempt++) {
   const widget = page.locator(`[data-kestrel-widget-id="${id}"]`);
   if (await widget.isVisible()) return widget;
   const next = page.getByRole("button", { name: "Next widget page", exact: true });
   if (!await next.isVisible() || !await next.isEnabled()) break;
   await next.click();
  }
  throw new Error(`Configured widget ${id} must remain reachable`);
 }
 await showWidget("route-usage");
 await page.locator('[data-kestrel-widget-id="route-usage"]').getByRole("heading", { name: "Codex usage", exact: true }).waitFor();
 await page.locator('[data-kestrel-widget-id="route-usage"]').getByText("No Codex accounts are configured yet.", { exact: true }).waitFor();
 const gap = await page.locator(".kestrel-widget-shelves").evaluate((node) => parseFloat(getComputedStyle(node).gap));
 assert(gap >= 12, "Widgets must be separated even in compact viewports");
 const download = await page.locator(".browser-download-trigger").evaluate((button) => {
  const b = button.getBoundingClientRect(); const i = button.querySelector(".browser-download-trigger-icon > svg").getBoundingClientRect();
  return { x: Math.abs(b.x + b.width / 2 - i.x - i.width / 2), y: Math.abs(b.y + b.height / 2 - i.y - i.height / 2), radius: getComputedStyle(button).borderRadius };
 });
 assert(download.x < 0.6 && download.y < 0.6, `Download icon must be centered: ${JSON.stringify(download)}`);
 assert.equal(download.radius, "50%");
 const composerMaterial = await composer.evaluate((node) => getComputedStyle(node).backdropFilter);
 assert(composerMaterial.includes("blur(16px)"), "The wallpaper entry uses a bounded glass blur");
 assert(!composerMaterial.includes("url("), "Task entry must not require SVG refraction");
 const widgetMaterial = await page.locator(".kestrel-widget-card").first().evaluate(node => getComputedStyle(node).backdropFilter);
 assert(widgetMaterial.includes("blur("), "Widgets must sample the wallpaper through glass");
 const rail = await page.locator(".kestrel-sidebar").evaluate(node => {
  const css = getComputedStyle(node); return { border: css.borderWidth, radius: css.borderRadius, background: css.backgroundColor };
 });
 assert.equal(rail.border, "0px", "Navigation rail must have no inset border frame");
 assert.equal(rail.radius, "0px", "Navigation rail fills its reserved area");
 const focus = await input.evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow, border: getComputedStyle(node).borderWidth }));
 assert.deepEqual(focus, { outline: "none", shadow: "none", border: "0px" }, "Text entry must not add a nested selection ring");
 await page.screenshot({ animations: "disabled", path: join(evidence, "desktop.png") });
 await input.focus();
 await page.screenshot({ animations: "disabled", path: join(evidence, "composer.png") });
 await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay")); win.setMinimumSize(400, 500); win.setSize(760, 760); });
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.screenshot({ animations: "disabled", path: join(evidence, "narrow.png") });
 assert.equal(await page.locator(".new-tab-page").evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, "Home must not overflow horizontally");
 await page.evaluate(async () => {
  const state = await window.kestrel.request({ type: "browser-get-state" });
  const result = await window.kestrel.request({ type: "browser-update-settings", settings: { ...state.browserState.settings, newTabShortcuts: Array.from({ length: 12 }, (_, i) => ({ title: `Fixture ${i + 1}`, url: `https://example.com/${i + 1}` })) } });
  if (!result.ok) throw new Error(result.error);
 });
 for (const [width, height, zoom] of [[1440, 1000, 1], [1440, 700, 1], [1000, 680, 1], [760, 760, 1], [1440, 1000, 2]]) {
  await application.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
   const win = BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes("petOverlay"));
   win.setSize(width, height); win.webContents.setZoomFactor(zoom);
  }, { width, height, zoom });
  await page.waitForFunction(({ width, zoom }) => Math.abs(innerWidth - width / zoom) < 12, { width, zoom });
  const agentToggle = page.locator("#browser-agent-toggle");
  if (width / zoom < 1100 && await agentToggle.getAttribute("aria-expanded") === "true") await page.locator(".agent-sidebar-collapse").click();
  await input.focus();
  await page.waitForFunction(() => {
   const home = document.querySelector(".new-tab-page");
   return home && home.scrollHeight <= home.clientHeight + 1 && home.scrollWidth <= home.clientWidth + 1;
  });
  assert(await page.locator(".kestrel-home").evaluate(node => {
   node.scrollTop = 100; return node.scrollTop === 0;
  }), "Home must not scroll when entry is expanded");
  assert(await page.locator(".kestrel-home .kestrel-widget-card").evaluateAll(cards => cards.every(node => {
   const box = node.getBoundingClientRect(); const home = node.closest(".kestrel-home").getBoundingClientRect();
   return box.top >= home.top - 1 && box.bottom <= home.bottom + 1;
  })), "Visible widgets must fit inside Home, including at 200% zoom");
  const boxes = await page.locator(".kestrel-home .kestrel-widget-card").evaluateAll(cards => cards.map(node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; }));
  assert(boxes.every((a, i) => boxes.every((b, j) => i === j || a.right <= b.x - 11 || b.right <= a.x - 11 || a.bottom <= b.y - 11 || b.bottom <= a.y - 11)), `Widgets must retain a visible gap: ${JSON.stringify(boxes)}`);
  const clipped = await page.locator(".kestrel-home .kestrel-widget-card").evaluateAll(cards => cards.flatMap(card => {
   const bounds = card.getBoundingClientRect();
   return [...card.querySelectorAll("button, h3, .kestrel-widget-empty")].filter(node => getComputedStyle(node).display !== "none").flatMap(node => {
    const box = node.getBoundingClientRect();
    return box.width === 0 || box.height === 0 || (box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1) ? [] : [{ widget: card.dataset.kestrelWidgetId, label: node.textContent, top: box.top, bottom: box.bottom, boundsTop: bounds.top, boundsBottom: bounds.bottom }];
   });
  }));
  assert.deepEqual(clipped, [], `Widget actions must remain usable at ${width}x${height}, zoom ${zoom}`);
  const overlaps = await page.locator(".home-personalize > summary").evaluate(node => {
   const a = node.getBoundingClientRect();
   return [...document.querySelectorAll(".kestrel-home-composer button, .kestrel-home-composer textarea")].some(control => { const b = control.getBoundingClientRect(); return b.width > 0 && b.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; });
  });
  assert.equal(overlaps, false, "Customize must not cover text entry or its controls");
  const reached = new Set();
  const previousShortcut = page.getByRole("button", { name: "Previous shortcut page", exact: true });
  while (await previousShortcut.isVisible() && await previousShortcut.isEnabled()) await previousShortcut.click();
  for (let i = 0; i < 12; i++) {
   for (const title of await page.locator(".home-site-shortcut > button:first-child").evaluateAll(nodes => nodes.map(node => node.title))) if (title) reached.add(title);
   const nextShortcut = page.getByRole("button", { name: "Next shortcut page", exact: true });
   if (!await nextShortcut.isVisible() || !await nextShortcut.isEnabled()) break;
   await nextShortcut.click();
  }
  assert.equal(reached.size, 12, "All configured shortcuts must remain reachable without scrolling Home");
  const pixels = await application.evaluate(async ({ BrowserWindow }) => {
   const win = BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes("petOverlay"));
   return (await win.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(join(evidence, `fit-${width}-${height}-${zoom}.png`), Buffer.from(pixels, "base64"));
 }
 await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay")); win.webContents.setZoomFactor(1); win.setSize(1440, 1000); });
 await page.emulateMedia({ contrast: "more" });
 assert.equal(await page.locator(".kestrel-widget-card").first().evaluate(node => getComputedStyle(node).backdropFilter), "none", "Increased contrast uses an opaque material");
 await page.emulateMedia({ contrast: "no-preference" });
 // Continuing a suggestion must reopen its source, never create a second task.
 const title = "New Tab continuation verification";
 await page.evaluate(async (title) => {
  const response = await window.kestrel.request({ type: "runtime-create-session", title, kind: "conversation" });
  if (!response.ok || !response.session) throw new Error("Could not create continuation fixture");
 }, title);
 await page.reload();
 await showWidget("recent-work");
 const continuation = page.locator('[data-kestrel-widget-id="recent-work"] button').filter({ hasText: title });
 await continuation.waitFor();
 const before = await page.evaluate(async () => (await window.kestrel.request({ type: "runtime-list-sessions" })).sessions.map(item => item.id));
 await continuation.click();
 await page.locator(".kestrel-sidebar-list-item[aria-current='page']").filter({ hasText: title }).waitFor();
 const after = await page.evaluate(async () => (await window.kestrel.request({ type: "runtime-list-sessions" })).sessions.map(item => item.id));
 assert.deepEqual(after.sort(), before.sort(), "Continue must preserve session identity without creating a new task");
 assert.deepEqual(errors, []);
 console.log("New Tab smoke passed: glass, single focus boundary, solid rails, non-scrolling responsive widgets through 200% zoom, shortcuts and exact-session continuation.");
} catch (error) { const page = application ? await application.firstWindow() : null; await page?.screenshot({ animations: "disabled", path: join(evidence, "failure.png") }).catch(() => {}); throw error; } finally { await application?.close(); rmSync(root, { recursive: true, force: true }); }
