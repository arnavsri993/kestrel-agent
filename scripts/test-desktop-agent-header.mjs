import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";

const profile = mkdtempSync(join(tmpdir(), "kestrel-agent-header-"));
const fixtureWorkspace = join(profile, "Friendly Header Fixture");
const userData = join(profile, "user-data");
mkdirSync(fixtureWorkspace, { recursive: true });
mkdirSync(userData, { recursive: true });
const fixtureNow = "2026-10-07T00:00:00.000Z";
writeFileSync(join(userData, "workspace-grants.json"), `${JSON.stringify([{ id: "project-friendly-header", path: realpathSync(fixtureWorkspace), name: "Friendly Header Fixture", createdAt: fixtureNow, updatedAt: fixtureNow, order: 0 }])}\n`);
const evidence = resolve(".tmp/agent-header", process.env.KESTREL_DESKTOP_EXECUTABLE ? "installed" : "source");
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const executablePath = executable ? resolve(executable) : requireFromDesktop("electron");
const launchArgs = executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")];
let application;

async function setSize(width, height = 900) {
	await application.evaluate(({ BrowserWindow }, size) => {
		const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes("petOverlay"));
		if (!window) throw new Error("Main window is missing.");
		window.setMinimumSize(400, 400);
		window.setSize(size.width, size.height);
		window?.show();
		window?.focus();
	}, { width, height });
}

async function settle(page) {
	await page.waitForFunction(() => !document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-settling"));
}

async function openRail(page) {
	const rail = page.locator(".agent-sidebar");
	await rail.waitFor({ state: "attached" });
	if (await rail.evaluate(node => getComputedStyle(node).display === "none")) return false;
	if (await rail.getAttribute("aria-hidden") === "true")
		await page.locator("#browser-agent-toggle").click();
	await rail.waitFor({ state: "visible" });
	await settle(page);
	return true;
}

async function createFixture(page, workspaceRoot) {
	return page.evaluate(async (workspaceRoot) => {
		const response = await window.kestrel.request({
			type: "runtime-create-session",
			title: "A very long Friendly task title that must remain discoverable when the rail is narrow",
			kind: "conversation",
			workspaceRoot,
		});
		if (!response.ok || !response.session) throw new Error(response.error ?? "Could not create header fixture session.");
		const selected = await window.kestrel.request({ type: "runtime-select-session", sessionId: response.session.id });
		if (!selected.ok) throw new Error(selected.error ?? "Could not select header fixture session.");
		return response.session.id;
	}, workspaceRoot);
}

async function inspectHeader(page, width, expectedRailWidth) {
	await setSize(width, width < 1000 ? 640 : 900);
	await page.waitForFunction((width) => innerWidth === width, width);
	await page.evaluate((railWidth) => localStorage.setItem("kestrel:agent-panel-width", String(railWidth)), expectedRailWidth);
	await page.reload();
	if (!await openRail(page)) {
		// The main-branch shell presents a dock instead of an overlay at narrow widths.
		const dock = page.locator(".agent-compact-dock");
		await dock.waitFor();
		assert.equal(await dock.locator(".agent-compact-copy small").textContent(), "Open");
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Compact dock must not overflow the window.");
		await page.screenshot({ animations: "disabled", path: join(evidence, "narrow.png") });
		return;
	}
	await page.locator(".agent-chat-heading strong").waitFor();
	await settle(page);
	const layout = await page.locator(".agent-sidebar").evaluate((sidebar) => {
		const heading = sidebar.querySelector(".agent-chat-heading");
		const title = sidebar.querySelector(".agent-chat-heading strong");
		const status = sidebar.querySelector(".agent-chat-status");
		const project = sidebar.querySelector(".agent-chat-project");
		const actions = sidebar.querySelector(".agent-chat-toolbar-actions");
		const rect = (node) => node?.getBoundingClientRect();
		return { sidebar: rect(sidebar), heading: rect(heading), title: rect(title), status: rect(status), project: rect(project), actions: rect(actions), titleText: title?.textContent, statusText: status?.textContent, projectText: project?.textContent };
	});
	assert(layout.sidebar && layout.heading && layout.actions, "Friendly header structure is missing.");
	assert.equal(await page.locator(".agent-chat-heading strong").getAttribute("title"), "A very long Friendly task title that must remain discoverable when the rail is narrow");
	assert.equal(layout.statusText, "Open", "Header status must match the active session state.");
	assert.equal(layout.projectText, "Friendly Header Fixture", "Header must expose the selected project fixture.");
	if (width >= 1000 || width === 520)
		assert.equal(await page.locator(".agent-chat-heading strong").evaluate(node => node.scrollWidth > node.clientWidth), true, "Long title must exercise ellipsis in a constrained heading.");
	assert(layout.status.right <= layout.heading.right + 1, "Session state must fit inside the heading.");
	assert(Math.abs((layout.heading.y + layout.heading.height / 2) - (layout.actions.y + layout.actions.height / 2)) < 4, "Header title and action group must share one row.");
	assert(layout.actions.right <= layout.sidebar.right + 1 && layout.actions.left >= layout.sidebar.left - 1, "Header actions must stay inside the sidebar.");
	await page.screenshot({ animations: "disabled", path: join(evidence, width < 1000 ? "narrow.png" : "wide.png") });
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: { ...process.env, KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_TEST_USER_DATA: userData, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1" },
	});
	const page = await application.firstWindow();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); localStorage.setItem("kestrel:agent-sidebar", "open"); });
	await page.reload();
	await openRail(page);
	await createFixture(page, fixtureWorkspace);
	await page.reload();
	await openRail(page);
	await page.locator(".agent-chat-heading strong").waitFor();

	for (const [width, rail] of [[1440, 560], [1440, 336], [1440, 288]]) await inspectHeader(page, width, rail);
	for (const width of [900, 760, 520]) await inspectHeader(page, width, 560);
	await setSize(1440);
	await page.reload();
	await openRail(page);
	const compact = await page.locator(".ai-browser-app").evaluate((shell) => shell.classList.contains("agent-sidebar-compact"));
	if (compact) {
		await page.locator(".agent-sidebar-collapse").waitFor();
	}

	const hide = page.locator(".agent-sidebar-collapse");
	await hide.focus();
	assert(await hide.evaluate(node => Number.parseFloat(getComputedStyle(node).outlineWidth) >= 2), "Keyboard focus must remain visible.");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-collapsed"));
	await page.locator("#browser-agent-toggle").waitFor();
	await page.locator("#browser-agent-toggle").focus();
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => !document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-collapsed"));
	await page.locator(".agent-chat-heading strong").waitFor();
	const newTask = page.locator(".agent-sidebar-new");
	await newTask.focus();
	await page.keyboard.press("Enter");
	await page.locator("#runtime-prompt").waitFor();
	await page.waitForFunction(() => document.activeElement?.id === "runtime-prompt");

	await page.reload();
	await openRail(page);
	await page.locator(".agent-chat-heading strong").waitFor();
	await setSize(1440);
	await page.reload();
	await openRail(page);
	await page.locator(".agent-chat-heading strong").waitFor();
	await page.locator(".agent-sidebar-expand").focus();
	await page.keyboard.press("Enter");
	await page.waitForFunction(async () => {
		const state = await window.kestrel.request({ type: "browser-get-state" });
		return state.ok && state.browserState?.tabs.some(tab => tab.id === state.browserState.activeTabId && tab.url === "kestrel://agent");
	});
	await page.locator(".agent-workspace").waitFor();
	if (await page.locator(".ai-browser-app.agent-full-page").count())
		assert.equal(await page.locator(".agent-chat-toolbar-actions").isVisible(), false, "Full-page Agent must hide the rail action group.");
	assert.deepEqual(errors, []);
	console.log("Agent header smoke passed: long title, status/project context, requested rail widths 560/336/288px, 900/760/520px viewports, keyboard hide/reopen/new, and the Agent destination.");
} catch (error) {
	const page = application?.windows().find(window => !window.isClosed());
	await page?.screenshot({ animations: "disabled", path: join(evidence, "failure.png") }).catch(() => {});
	throw error;
} finally {
	await application?.close();
	rmSync(profile, { recursive: true, force: true });
}
