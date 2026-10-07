import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

async function assertComposerControlsContained(page, label) {
	const result = await page.locator(".kestrel-home-composer").evaluate((composer) => {
		const bounds = composer.getBoundingClientRect();
		const controls = [...composer.querySelectorAll(".new-tab-composer-footer button")]
			.filter((control) => {
				const rect = control.getBoundingClientRect();
				const style = getComputedStyle(control);
				return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
			})
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					name: control.getAttribute("aria-label") || control.textContent?.trim() || control.getAttribute("title") || "unnamed control",
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
				};
			});
		return {
			bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
			controls,
		};
	});
	assert(result.controls.length >= 5, `${label}: all composer actions must remain visible`);
	for (const control of result.controls) {
		assert(
			control.left >= result.bounds.left - 1 &&
				control.right <= result.bounds.right + 1 &&
				control.top >= result.bounds.top - 1 &&
				control.bottom <= result.bounds.bottom + 1,
			`${label}: ${control.name} must stay inside the composer: ${JSON.stringify({ control, composer: result.bounds })}`,
		);
	}
}

async function assertHomeDoesNotOverflow(page, label) {
	assert.equal(
		await page.locator(".new-tab-page").evaluate((node) => node.scrollWidth > node.clientWidth + 1),
		false,
		`${label}: Home must not overflow horizontally`,
	);
}

async function assertFocused(page, selector, message) {
	await page.waitForFunction((target) => document.activeElement?.matches(target), selector);
	assert(await page.locator(selector).evaluate((node) => node === document.activeElement), message);
}

try {
 application = await electron.launch({ executablePath: executable || require("electron"), args: executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")], env: { ...process.env, KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_TEST_USER_DATA: join(root, "profile"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1" } });
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
	 await page.getByRole("heading", { name: "Your workspace", level: 2, exact: true }).waitFor();
	 const editWidgets = page.getByRole("button", { name: "Edit widgets", exact: true });
	 await editWidgets.focus();
	 await editWidgets.press("Enter");
	 await page.locator(".kestrel-widget-canvas.is-editing").waitFor({ state: "visible" });
	 let done = page.getByRole("button", { name: "Done", exact: true });
	 await assertFocused(page, ".kestrel-widget-customize", "Direct Edit widgets activation must focus Done");
	 await done.press("Enter");
	 await assertFocused(page, ".home-edit-widgets", "Done must restore focus to Edit widgets");
	 await page.locator(".home-personalize summary").click();
	 await page.getByLabel("Wallpaper", { exact: true }).selectOption("dawn");
	 await page.locator(".new-tab-page-dawn").waitFor();
	 await page.getByRole("button", { name: "Arrange widgets" }).click();
	 await page.locator(".kestrel-widget-canvas.is-editing").waitFor({ state: "visible" });
	 done = page.getByRole("button", { name: "Done", exact: true });
	 await assertFocused(page, ".kestrel-widget-customize", "Arrange widgets must focus Done");
	 await done.press("Enter");
	 await assertFocused(page, ".home-personalize summary", "Done must restore focus to Customize New Tab");
 await page.locator('[data-kestrel-widget-id="route-usage"]').getByRole("heading", { name: "Codex usage", exact: true }).waitFor();
 await page.locator('[data-kestrel-widget-id="route-usage"]').getByText("No Codex accounts are configured yet.", { exact: true }).waitFor();
 const gap = await page.locator(".kestrel-widget-shelves").evaluate((node) => parseFloat(getComputedStyle(node).gap));
 assert(gap >= 16, "Widgets must be separated");
 const download = await page.locator(".browser-download-trigger").evaluate((button) => {
  const b = button.getBoundingClientRect(); const i = button.querySelector(".browser-download-trigger-icon > svg").getBoundingClientRect();
  return { x: Math.abs(b.x + b.width / 2 - i.x - i.width / 2), y: Math.abs(b.y + b.height / 2 - i.y - i.height / 2), radius: getComputedStyle(button).borderRadius };
 });
 assert(download.x < 0.6 && download.y < 0.6, `Download icon must be centered: ${JSON.stringify(download)}`);
 assert.equal(download.radius, "50%");
 assert((await composer.evaluate((node) => getComputedStyle(node).backdropFilter)).includes("kestrel-glass-refraction"));
 await page.screenshot({ animations: "disabled", path: join(evidence, "desktop.png") });
 await input.focus();
	 await page.screenshot({ animations: "disabled", path: join(evidence, "composer.png") });
	 await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay")); win.setMinimumSize(400, 500); win.setSize(760, 760); });
	 await page.emulateMedia({ reducedMotion: "reduce" });
	 await page.waitForFunction(() => window.innerWidth <= 760);
	 await input.focus();
	 await assertComposerControlsContained(page, "760px window");
	 await page.screenshot({ animations: "disabled", path: join(evidence, "narrow.png") });
	 await assertHomeDoesNotOverflow(page, "760px reduced-motion window");
	 await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay")); win.setSize(520, 760); });
	 await page.waitForFunction(() => window.innerWidth <= 520);
	 await assertComposerControlsContained(page, "520px window");
	 await assertHomeDoesNotOverflow(page, "520px window");
	 await page.screenshot({ animations: "disabled", path: join(evidence, "mobile.png") });
	 await application.evaluate(({ BrowserWindow }) => {
	  const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay"));
	  win.setSize(760, 760);
	  win.webContents.setZoomFactor(2);
	 });
	 await page.waitForFunction(() => document.querySelector(".kestrel-home-hero")?.getBoundingClientRect().width < 400);
	 await assertComposerControlsContained(page, "200% zoom");
	 await assertHomeDoesNotOverflow(page, "200% zoom");
	 await application.evaluate(({ BrowserWindow }) => {
	  const win = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("petOverlay"));
	  win.webContents.setZoomFactor(1);
	  win.setSize(1440, 1000);
	 });
	 await page.waitForFunction(() => window.innerWidth >= 1400);
 // Continuing a suggestion must reopen its source, never create a second task.
 const title = "New Tab continuation verification";
 await page.evaluate(async (title) => {
  const response = await window.kestrel.request({ type: "runtime-create-session", title, kind: "conversation" });
  if (!response.ok || !response.session) throw new Error("Could not create continuation fixture");
 }, title);
 await page.reload();
 const continuation = page.locator('[data-kestrel-widget-id="recent-work"] button').filter({ hasText: title });
 await continuation.waitFor();
 const before = await page.evaluate(async () => (await window.kestrel.request({ type: "runtime-list-sessions" })).sessions.map(item => item.id));
 await continuation.click();
 await page.locator(".kestrel-sidebar-list-item[aria-current='page']").filter({ hasText: title }).waitFor();
 const after = await page.evaluate(async () => (await window.kestrel.request({ type: "runtime-list-sessions" })).sessions.map(item => item.id));
 assert.deepEqual(after.sort(), before.sort(), "Continue must preserve session identity without creating a new task");
 assert.deepEqual(errors, []);
	 console.log("New Tab glass smoke passed: expansion, paste, shortcuts, wallpaper, widget focus, narrow and zoomed layout, exact-session continuation.");
} catch (error) { const page = application ? await application.firstWindow() : null; await page?.screenshot({ animations: "disabled", path: join(evidence, "failure.png") }).catch(() => {}); throw error; } finally { await application?.close(); rmSync(root, { recursive: true, force: true }); }
