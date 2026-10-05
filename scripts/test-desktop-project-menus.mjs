import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// This fixture owns its folders, profile, HOME and mock Keychain. It never
// connects a model provider or attaches to the person's running app/profile.
const root = mkdtempSync(join(tmpdir(), "kestrel-project-menus-"));
const profile = join(root, "profile");
const evidence = resolve(".tmp", "project-menus", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(profile);
mkdirSync(join(root, "home"));
mkdirSync(evidence, { recursive: true });
const names = ["Alpha", "Beta", "Unavailable", ...Array.from({ length: 13 }, (_, i) => `Project ${i + 4} with a long readable name`)];
const projects = names.map((name, i) => {
  const path = join(root, `project-${i}`);
  if (name !== "Unavailable") mkdirSync(path);
  return { id: `project-${i}`, name, path, order: i, createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" };
});
writeFileSync(join(profile, "workspace-grants.json"), JSON.stringify(projects));
const environment = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const results = [], errors = [], measurements = [];
let currentCheck;
let application, page;
async function request(input) { return page.evaluate(input => window.kestrel.request(input), input); }
async function menuBounds() {
  const bounds = await page.locator(".kestrel-sidebar-context-menu").evaluate(menu => {
    const box = menu.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight };
  });
  measurements.push({ id: currentCheck, ...bounds });
  assert(bounds.x >= 8 - 1 && bounds.y >= 8 - 1 && bounds.right <= bounds.width - 7 && bounds.bottom <= bounds.height - 7, `Menu escapes window: ${JSON.stringify(bounds)}`);
  return bounds;
}
async function check(id, fn) {
  currentCheck = id;
  try { await fn(); await page.screenshot({ path: join(evidence, `${id}.png`) }); results.push({ id, status: "passed" }); }
  catch (error) { const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.slice(0, 100) })); results.push({ id, status: "failed", error: error.message, focus }); await page.screenshot({ path: join(evidence, `${id}-failure.png`) }).catch(() => {}); }
  finally { console.log(JSON.stringify(results.at(-1))); await page.keyboard.press("Escape"); await expect(page.locator(".kestrel-sidebar-context-menu")).toHaveCount(0); }
}
try {
  application = await electron.launch({
    executablePath: packaged ? resolve(packaged) : createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: [...(packaged ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
    env: { ...environment, HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), KESTREL_TEST_USER_DATA: profile, KESTREL_DATA_DIR: join(root, "core"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" },
  });
  page = await application.firstWindow(); page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); localStorage.setItem("kestrel:navigation-sidebar", "open"); localStorage.setItem("kestrel:agent-sidebar", "collapsed"); });
  await page.reload(); await page.emulateMedia({ reducedMotion: "reduce" });
  await application.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers?.get("kestrel:request");
    if (typeof original !== "function") throw new Error("Missing owned request handler");
    const held = { enabled: false, waiting: [] };
    globalThis.__ownedMenuRouteHold = held;
    ipcMain.removeHandler("kestrel:request");
    ipcMain.handle("kestrel:request", (event, request) => {
      if (request.type === "get-workspace-grants" && held.enabled)
        return new Promise(resolve => held.waiting.push(() => resolve(original(event, request))));
      return original(event, request);
    });
  });
  const created = await request({ type: "runtime-create-session", title: "Owned project menu chat", projectId: "project-0" });
  assert(created.ok && created.session);
  await page.reload();
  const sidebar = page.locator(".kestrel-sidebar");
  const alpha = sidebar.getByRole("button", { name: "Open Alpha project", exact: true });
  const unavailable = sidebar.getByRole("button", { name: "Open Unavailable project", exact: true });
  const menu = page.locator(".kestrel-sidebar-context-menu");
  // At <=800px the established layout uses its icon rail and Projects page;
  // project/chat rows are available in the expanded rail above that breakpoint.
  for (const viewport of [{ name: "desktop", width: 1280, height: 760 }, { name: "compact", width: 900, height: 600 }]) {
    await page.setViewportSize(viewport);
    await check(`${viewport.name}-project-keyboard`, async () => {
      await alpha.focus(); await alpha.press("Shift+F10");
      await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown"); await expect(menu.getByRole("menuitem", { name: "New chat", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowUp"); await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowUp"); await expect(menu.getByRole("menuitem", { name: "Project settings", exact: true })).toBeFocused();
      await page.keyboard.press("Home"); await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeFocused();
      await page.keyboard.press("End"); await expect(menu.getByRole("menuitem", { name: "Project settings", exact: true })).toBeFocused();
      await menuBounds(); await page.keyboard.press("Escape"); await expect(alpha).toBeFocused();
    });
    await check(`${viewport.name}-unavailable-project`, async () => {
      await unavailable.click({ button: "right" });
      await expect(menu.getByRole("menuitem", { name: "New chat", exact: true })).toBeDisabled();
      await page.keyboard.press("ArrowDown"); await expect(menu.getByRole("menuitem", { name: "Project settings", exact: true })).toBeFocused();
      await menuBounds();
    });
    // Expand only the owned chat's project; no chat/model run is started.
    if (await alpha.count()) await alpha.click();
    const chat = sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Owned project menu chat" });
    await expect(chat).toBeVisible();
    await check(`${viewport.name}-chat-long-menu`, async () => {
      await chat.click({ button: "right" });
      await expect(menu.getByRole("menuitem", { name: "Alpha", exact: true })).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: "Unavailable", exact: true })).toBeDisabled();
      await menuBounds();
      await page.keyboard.press("ArrowDown"); await expect(menu.getByRole("menuitem", { name: "Beta", exact: true })).toBeFocused();
      await page.keyboard.press("End"); await expect(menu.getByRole("menuitem", { name: "Remove from project", exact: true })).toBeFocused();
      const remove = await menu.getByRole("menuitem", { name: "Remove from project", exact: true }).boundingBox();
      const bounds = await menuBounds(); assert(remove && remove.y >= bounds.y && remove.y + remove.height <= bounds.bottom + 1, "Last action remains visible when focused");
    });
    await check(`${viewport.name}-window-edge`, async () => {
      await chat.focus();
      // Owned event coordinates exercise both edges without moving user data.
      await chat.evaluate((element, viewport) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: viewport.width - 2, clientY: viewport.height - 2 })), viewport);
      await expect(menu).toBeVisible(); const bounds = await menuBounds();
      assert(bounds.right >= viewport.width - 9 && bounds.bottom >= viewport.height - 9, "Edge anchor is measured against the actual viewport");
    });
    // Reset expansion before the next viewport's opening label is queried.
    await sidebar.getByRole("button", { name: "Collapse Alpha project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await check("resize-open-menu", async () => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await alpha.click(); const chat = sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Owned project menu chat" });
    await chat.evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1278, clientY: 758 }))); await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 800, height: 600 });
    await expect.poll(() => menu.evaluate(element => { const box = element.getBoundingClientRect(); return box.right >= 791 && box.right <= 793 && box.bottom >= 591 && box.bottom <= 593; })).toBe(true);
    await menuBounds();
  });
  await check("keyboard-move-and-remove", async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    const chat = sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Owned project menu chat" });
    await chat.focus(); await chat.press("Shift+F10"); await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Beta", exact: true })).toBeFocused(); await page.keyboard.press("Enter");
    await expect.poll(async () => (await request({ type: "runtime-list-sessions" })).sessions.find(s => s.id === created.session.id)?.projectId).toBe("project-1");
    const moved = sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Owned project menu chat" });
    await moved.focus(); await moved.press("Shift+F10"); await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Remove from project", exact: true })).toBeFocused(); await page.keyboard.press("Space");
    await expect.poll(async () => (await request({ type: "runtime-list-sessions" })).sessions.find(s => s.id === created.session.id)?.projectId).toBeUndefined();
    await expect(sidebar.locator(".kestrel-sidebar-list-item").filter({ hasText: "Owned project menu chat" })).toBeVisible();
  });
  const alphaRow = sidebar.locator(".kestrel-sidebar-project-open").filter({ hasText: "Alpha" }).first();
  await check("delayed-route-preserves-menu-focus", async () => {
    await sidebar.getByRole("button", { name: "Browser", exact: true }).click();
    await application.evaluate(() => { globalThis.__ownedMenuRouteHold.enabled = true; });
    try {
      await alphaRow.click();
      await expect.poll(() => application.evaluate(() => globalThis.__ownedMenuRouteHold.waiting.length)).toBeGreaterThan(0);
      await alphaRow.click({ button: "right" });
      await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeFocused();
    } finally {
      await application.evaluate(() => { const held = globalThis.__ownedMenuRouteHold; held.enabled = false; for (const release of held.waiting.splice(0)) release(); });
    }
    await expect(page.locator('.browser-app-page[data-app-page="projects"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeFocused();
  });
  await check("content-reflow-repositions-open-menu", async () => {
    await alphaRow.evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 898, clientY: 598 })));
    const before = await menuBounds();
    // Owned DOM content growth specifically exercises ResizeObserver. It does
    // not represent an IPC project mutation or change the stored project.
    await menu.getByRole("menuitem", { name: "Project settings", exact: true }).locator("span").evaluate(label => { label.textContent = "Synthetic long label ".repeat(12) + "x".repeat(80); });
    await expect.poll(() => menu.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(before.bottom - before.y + 40);
    await expect.poll(() => menu.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight - 7)).toBe(true);
    await menuBounds();
  });
  await check("animated-menu-entry-and-exit", async () => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await alphaRow.focus(); await alphaRow.press("Shift+F10");
    await page.waitForFunction(() => { const menu = document.querySelector(".kestrel-sidebar-context-menu"); return menu && getComputedStyle(menu).opacity === "1" && getComputedStyle(menu).transform === "none"; });
    await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeFocused(); await menuBounds();
    await page.keyboard.press("Escape"); await expect(alphaRow).toBeFocused(); await expect(menu).toHaveCount(0);
  });
  assert.deepEqual(errors, []);
} finally {
  const sourceCommit = packaged ? JSON.parse(readFileSync(resolve(packaged, "../../Resources/build-provenance.json"), "utf8")).sourceCommit : null;
  writeFileSync(join(evidence, "manifest.json"), JSON.stringify({ sourceCommit, fixture: "Disposable profile, HOME, core data and mock Keychain; no provider generation", results, measurements, errors }, null, 2) + "\n");
  await application?.close().catch(() => {}); rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ evidence, passed: results.filter(r => r.status === "passed").length, failed: results.filter(r => r.status === "failed").length }));
}
assert(results.length === 13 && results.every(result => result.status === "passed"), "Project menu checks failed; inspect owned manifest.");
