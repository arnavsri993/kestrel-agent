import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-widget-quality-"));
const userData = join(root, "profile");
const evidence = resolve(".tmp/widget-quality");
mkdirSync(evidence, { recursive: true });

const server = createServer((_request, response) => {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(
		"<!doctype html><title>Widget fixture page</title><h1>Widget fixture page</h1>",
	);
});
await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");
const fixtureUrl = `http://127.0.0.1:${address.port}/frequent#open-tab`;

const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];

let application;
let page;
const pageErrors = [];

async function request(input) {
	return page.evaluate(
		(requestInput) => window.kestrel.request(requestInput),
		input,
	);
}

async function browserState() {
	const response = await request({ type: "browser-get-state" });
	assert(response.ok && "browserState" in response, "Could not read browser state.");
	return response.browserState;
}

async function runtimeSessions() {
	const response = await request({ type: "runtime-list-sessions" });
	assert(response.ok && "sessions" in response, "Could not list conversations.");
	return response.sessions ?? [];
}

async function createConversation(title, privacyMode) {
	const response = await request({
		type: "runtime-create-session",
		title,
		kind: "conversation",
		privacyMode,
	});
	assert(response.ok && response.session, `Could not create ${title}.`);
	assert.equal(response.session.privacyMode, privacyMode);
	return response.session;
}

async function setWindowSize(width, height) {
	await application.evaluate(
		({ BrowserWindow }, size) => {
			const win = BrowserWindow.getAllWindows().find(
				(candidate) => !candidate.webContents.getURL().includes("petOverlay"),
			);
			if (!win) throw new Error("Main desktop window was not found.");
			win.setMinimumSize(400, 500);
			win.setSize(size.width, size.height);
			win.show();
			win.focus();
		},
		{ width, height },
	);
}

async function openHome() {
	const response = await request({ type: "browser-create-tab", active: true });
	assert(response.ok, "Could not open a New Tab page.");
	await page.locator("#new-tab-title").waitFor();
}

async function revealWidget(id) {
	const card = page.locator(`[data-kestrel-widget-id="${id}"]`);
	for (let attempt = 0; attempt < 12; attempt += 1) {
		if (await card.isVisible().catch(() => false)) {
			await card.scrollIntoViewIfNeeded();
			return card;
		}
		// New Tab may expose a canonical widget pager at compact widths. Only use
		// that pager; never confuse it with the browser's own navigation controls.
		const pager = page.locator(".kestrel-widget-pager:visible");
		if ((await pager.count()) === 0) break;
		const next = pager.getByRole("button", { name: /next/i }).first();
		if (!(await next.isVisible().catch(() => false)) || (await next.isDisabled()))
			break;
		await next.click();
	}
	throw new Error(`Widget ${id} is not one of the visible pager items.`);
}

async function assertHomeGeometry(width) {
	await setWindowSize(width, 820);
	await page.waitForFunction(
		(expectedWidth) => Math.abs(window.innerWidth - expectedWidth) < 40,
		width,
	);
	// Compact chat is a full-window overlay in the canonical app. Dismiss it
	// through its real control before measuring the Home widgets underneath.
	const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
	if (await closeChat.isVisible()) await closeChat.click();
	await page.locator(".kestrel-widget-card:visible").first().waitFor();
	const result = await page.locator(".new-tab-page").evaluate((home) => {
		const tolerance = 1.5;
		const visible = (element) => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
		};
		const failures = [];
		for (const card of home.querySelectorAll(".kestrel-widget-card")) {
			if (!visible(card)) continue;
			const cardRect = card.getBoundingClientRect();
			for (const control of card.querySelectorAll("button, a, input, select, textarea")) {
				if (!visible(control)) continue;
				const rect = control.getBoundingClientRect();
				if (rect.left < cardRect.left - tolerance || rect.right > cardRect.right + tolerance)
					failures.push(`${card.dataset.kestrelWidgetId}: horizontal control overflow`);
			}
			for (const control of card.querySelectorAll(".kestrel-widget-footer button")) {
				if (!visible(control)) continue;
				const rect = control.getBoundingClientRect();
				if (rect.top < cardRect.top - tolerance || rect.bottom > cardRect.bottom + tolerance)
					failures.push(`${card.dataset.kestrelWidgetId}: footer overflow`);
			}
		}
		return {
			horizontalOverflow: home.scrollWidth > home.clientWidth + tolerance,
			failures,
		};
	});
	assert.equal(result.horizontalOverflow, false, `Home overflowed horizontally at ${width}px.`);
	assert.deepEqual(result.failures, [], `Widget containment failed at ${width}px.`);
}


async function usageContentClipping(card) {
	const failures = await card.evaluate((element) => {
		const tolerance = 1.5;
		const failures = [];
		const nodes = element.querySelectorAll(
			".kestrel-widget-usage-window-label, .kestrel-widget-usage-window-value strong, .kestrel-widget-usage-window > small, button",
		);
		for (const node of nodes) {
			if (node.closest("dialog:not([open])")) continue;
			const rect = node.getBoundingClientRect();
			if (!rect.width || !rect.height) continue;
			const name = node.getAttribute("aria-label") || node.textContent.trim();
			// Absolute header controls use the card as their containing block and
			// are not clipped by intervening body ancestors outside that block.
			const firstClipAncestor = getComputedStyle(node).position === "absolute"
				? node.offsetParent : node.parentElement;
			for (let parent = firstClipAncestor; parent; parent = parent.parentElement) {
				const box = parent.getBoundingClientRect();
				const style = getComputedStyle(parent);
				const clipX = parent === element || /hidden|clip|auto|scroll/.test(style.overflowX);
				const clipY = parent === element || /hidden|clip|auto|scroll/.test(style.overflowY);
				if ((clipX && (rect.left < box.left - tolerance || rect.right > box.right + tolerance)) ||
					(clipY && (rect.top < box.top - tolerance || rect.bottom > box.bottom + tolerance))) {
					failures.push(`${name}: clipped by ${parent.className}`);
					break;
				}
				if (parent === element) break;
			}
		}
		return failures;
	});
	return failures;
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForURL(
		(url) => url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"),
	);
	await page.waitForFunction(() => typeof window.kestrel?.request === "function");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:agent-sidebar", "open");
	});
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await setWindowSize(1280, 900);

	const standardTitle = "Widget quality standard conversation";
	const privateTitle = "Widget quality private conversation";
	const standardSession = await createConversation(standardTitle, "standard");
	const privateSession = await createConversation(privateTitle, "private");
	assert.notEqual(standardSession.id, privateSession.id);

	const fixture = await request({
		type: "browser-create-tab",
		input: fixtureUrl,
		active: true,
	});
	assert(fixture.ok && "browserState" in fixture);
	const fixtureTabId = fixture.browserState.activeTabId;
	assert(fixtureTabId, "Fixture tab did not receive an ID.");
	await page.waitForFunction(
		async ({ tabId, url }) => {
			const response = await window.kestrel.request({ type: "browser-get-state" });
			return response.ok && "browserState" in response &&
				response.browserState.tabs.some((tab) => tab.id === tabId && tab.url === url) &&
				response.browserState.history.some((entry) => entry.url === url);
		},
		{ tabId: fixtureTabId, url: fixtureUrl },
	);

	await openHome();
	const recentWork = await revealWidget("recent-work");
	await recentWork.getByRole("button", { name: `Open ${standardTitle}`, exact: true }).waitFor();
	assert.equal(
		await recentWork.getByText(privateTitle, { exact: true }).count(),
		0,
		"Private conversations must never appear in Recent work.",
	);
	const beforeContinuation = (await runtimeSessions()).map((session) => session.id).sort();
	const continuation = recentWork.getByRole("button", {
		name: `Open ${standardTitle}`,
		exact: true,
	});
	await continuation.focus();
	await page.keyboard.press("Enter");
	await page
		.locator('.kestrel-sidebar-list-item[aria-current="page"]')
		.filter({ hasText: standardTitle })
		.waitFor();
	const afterContinuation = (await runtimeSessions()).map((session) => session.id).sort();
	assert.deepEqual(afterContinuation, beforeContinuation, "Continuing work created a duplicate conversation.");
	assert.equal(
		(await runtimeSessions()).filter((session) => session.id === standardSession.id).length,
		1,
		"Continuation must preserve the exact standard conversation ID.",
	);

	await openHome();
	const frequent = await revealWidget("frequent-tabs");
	const switchButton = frequent.getByRole("button", {
		name: "Switch to Widget fixture page",
		exact: true,
	});
	await switchButton.waitFor();
	const tabsBeforeSwitch = (await browserState()).tabs.map((tab) => tab.id).sort();
	await switchButton.click();
	await page.waitForFunction(
		async (tabId) => {
			const response = await window.kestrel.request({ type: "browser-get-state" });
			return response.ok && "browserState" in response && response.browserState.activeTabId === tabId;
		},
		fixtureTabId,
	);
	const stateAfterSwitch = await browserState();
	assert.deepEqual(
		stateAfterSwitch.tabs.map((tab) => tab.id).sort(),
		tabsBeforeSwitch,
		"Switching to a frequent open page must not duplicate its tab.",
	);
	assert.equal(stateAfterSwitch.activeTabId, fixtureTabId);

	await openHome();
	const memories = await revealWidget("recent-memories");
	await memories.getByText("Useful context, ready to reuse", { exact: true }).waitFor();
	assert.equal(await memories.locator(".kestrel-widget-memory-list li").count(), 0);
	assert.equal(
		await memories.getByText("Remember that I prefer concise status updates", { exact: true }).count(),
		0,
		"The empty widget must not inject a sample preference.",
	);
	const beforeMemory = (await runtimeSessions()).map((session) => session.id).sort();
	await memories.getByRole("button", { name: "Open Memory", exact: true }).click();
	await page.getByRole("heading", { name: "Memory", exact: true }).waitFor();
	const memoryState = await browserState();
	assert.match(
		memoryState.tabs.find((tab) => tab.id === memoryState.activeTabId)?.url ?? "",
		/^kestrel:\/\/memory/,
	);
	assert.deepEqual(
		(await runtimeSessions()).map((session) => session.id).sort(),
		beforeMemory,
		"Opening Memory must not inject a sample task.",
	);

	await openHome();
	const usage = await revealWidget("route-usage");
	await usage.getByText("No Codex accounts are configured yet.", { exact: true }).waitFor();
	await usage.getByRole("button", { name: "Set up Codex", exact: true }).click();
	await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
	const openConnections = page.getByRole("button", { name: "Open Connections", exact: true });
	if (await openConnections.isVisible()) {
		// The canonical app routes model setup through the dedicated Connections
		// workspace. Verify its real ChatGPT account destination as well.
		await openConnections.click();
		await page.getByRole("combobox", { name: "More connection settings", exact: true }).selectOption("models");
		await page.getByRole("heading", { name: "Model provider", exact: true }).waitFor();
		await page.getByText("ChatGPT", { exact: true }).waitFor();
	} else {
		await page.locator("#setting-agent-connections").waitFor();
		await page.getByRole("heading", { name: "Accounts and access", exact: true }).waitFor();
	}


	// Keep the actual unconfigured setup check above. This disposable renderer
	// fixture replaces only usage readings; all other requests use the real bridge.
	const fixtureNow = Date.now();
	const usageFixture = {
		providerId: "codex-subscription-widget-fixture",
		providerPoolId: "codex-subscription",
		label: "Widget fixture · Codex",
		email: "widget-fixture@example.invalid",
		plan: "Plus",
		status: "ready",
		ordinaryUsageAllowed: true,
		updatedAt: new Date(fixtureNow).toISOString(),
		windows: [
			{ label: "5-hour", usedPercent: 23, windowDurationMins: 300,
				resetsAt: new Date(fixtureNow + 125 * 60_000).toISOString() },
			{ label: "Weekly", usedPercent: 62, windowDurationMins: 10080,
				resetsAt: new Date(fixtureNow + (2 * 24 * 60 + 3 * 60 + 30) * 60_000).toISOString() },
		],
	};
	// Electron freezes exposed bridge properties. A disposable session preload
	// wraps the request before exposure, then delegates every non-usage request.
	const usagePreload = join(root, "usage-fixture.cjs");
	writeFileSync(usagePreload, `
		const { contextBridge } = require("electron");
		const expose = contextBridge.exposeInMainWorld.bind(contextBridge);
		let count = 0;
		contextBridge.exposeInMainWorld = (name, bridge) => {
			if (name === "kestrel") {
				const request = bridge.request.bind(bridge);
				bridge = { ...bridge, request: async (input) => {
					if (input.type !== "runtime-provider-usage") return request(input);
					count += 1;
					return { ok: true, providerUsage: [${JSON.stringify(usageFixture)}] };
				} };
				expose("widgetUsageFixture", { requestCount: () => count });
			}
			return expose(name, bridge);
		};
	`);
	await application.evaluate(({ BrowserWindow }, preload) => {
		const win = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("petOverlay"),
		);
		if (!win) throw new Error("Main desktop window was not found.");
		win.webContents.session.setPreloads([preload]);
	}, usagePreload);
	await page.reload();
	await page.waitForFunction(() => typeof window.kestrel?.request === "function");
	await openHome();
	const populatedUsage = await revealWidget("route-usage");
	// Exclude the canonical Accounts dialog's duplicate readings until opened.
	const usageRows = populatedUsage.locator(".kestrel-widget-route-usage > .kestrel-widget-route-usage-list");
	await usageRows.getByText("Widget fixture", { exact: true }).waitFor();
	await usageRows.getByText("5-hour", { exact: true }).waitFor();
	await usageRows.getByText("77% left", { exact: true }).waitFor();
	await usageRows.getByText("Weekly", { exact: true }).waitFor();
	await usageRows.getByText("38% left", { exact: true }).waitFor();
	await usageRows.getByText("Resets in 2h 5m", { exact: true }).waitFor();
	await usageRows.getByText("Resets in 2d 3h", { exact: true }).waitFor();
	assert.equal(await usageRows.getByRole("meter", { name: "5-hour remaining", exact: true }).getAttribute("aria-valuenow"), "77");
	assert.equal(await usageRows.getByRole("meter", { name: "Weekly remaining", exact: true }).getAttribute("aria-valuenow"), "38");
	const usageRequestsBeforeRefresh = await page.evaluate(() => window.widgetUsageFixture.requestCount());
	assert(usageRequestsBeforeRefresh > 0, "Configured fixture never received a usage request.");
	await populatedUsage.getByRole("button", { name: "Refresh Codex usage", exact: true }).click();
	await page.waitForFunction((before) => window.widgetUsageFixture.requestCount() > before, usageRequestsBeforeRefresh);
	await populatedUsage.getByText("Limits remaining", { exact: true }).waitFor();
	const accountsButton = populatedUsage.getByRole("button", { name: "Accounts", exact: true });
	if (await accountsButton.isVisible()) {
		await accountsButton.click();
		const accountsDialog = page.getByRole("dialog", { name: "Codex accounts", exact: true });
		await accountsDialog.waitFor();
		await accountsDialog.getByText("Widget fixture", { exact: true }).waitFor();
		assert.equal(await accountsDialog.evaluate((dialog) => dialog.matches(":modal")), true);
		await accountsDialog.getByRole("button", { name: "Close accounts", exact: true }).click();
		await accountsDialog.waitFor({ state: "hidden" });
	}

	await assertHomeGeometry(1280);
	await revealWidget("route-usage");
	await page.screenshot({ animations: "disabled", path: join(evidence, "usage-desktop.png") });
	const desktopUsageClipping = await usageContentClipping(populatedUsage);
	await assertHomeGeometry(520);
	const widgetPager = page.locator(".kestrel-widget-pager:visible");
	if (await widgetPager.count()) {
		await widgetPager.getByRole("button", { name: /^Show widget page 2 of / }).click();
	} else {
		await revealWidget("route-usage");
	}
	await page.screenshot({ animations: "disabled", path: join(evidence, "usage-compact-page-2.png") });
	await assertHomeGeometry(520);
	const compactUsage = await revealWidget("route-usage");
	const compactUsageClipping = await usageContentClipping(compactUsage);
	assert.deepEqual({ desktop: desktopUsageClipping, compact: compactUsageClipping },
		{ desktop: [], compact: [] }, "Configured usage labels/controls clipped at 1280px desktop or 520px compact.");

	await openHome();
	await assertHomeGeometry(760);
	await assertHomeGeometry(520);
	await page.screenshot({
		animations: "disabled",
		path: join(evidence, "narrow.png"),
	});
	await assertHomeGeometry(1280);
	await page.screenshot({
		animations: "disabled",
		path: join(evidence, "desktop.png"),
	});

	assert.deepEqual(pageErrors, [], `Renderer errors: ${pageErrors.join(" | ")}`);
	console.log(
		`Widget quality smoke passed: privacy-safe Recent work, exact continuation ${standardSession.id}, existing-tab switch ${fixtureTabId}, empty Memory and Codex routes, configured 5-hour/Weekly limits, resets, Refresh, Accounts when available, and 760/520 containment. Populated screenshots: ${join(evidence, "usage-desktop.png")}, ${join(evidence, "usage-compact-page-2.png")}. Screenshots: ${join(evidence, "desktop.png")}, ${join(evidence, "narrow.png")}`,
	);
} catch (error) {
	await page
		?.screenshot({ animations: "disabled", path: join(evidence, "failure.png") })
		.catch(() => undefined);
	throw error;
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
