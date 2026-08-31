import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-visible-browser-"));
const userData = join(root, "user-data");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/download") {
		const body = Buffer.from("Kestrel visible browser download\n", "utf8");
		response.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"content-length": String(body.byteLength),
			"content-disposition": 'attachment; filename="kestrel-browser.txt"',
			"cache-control": "no-store",
		});
		response.end(body);
		return;
	}
	const pageName =
		url.pathname === "/two"
			? "Page two"
			: url.pathname === "/popup"
				? "Popup page"
				: "Page one";
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(`<!doctype html>
    <html>
      <head>
        <title>${pageName}</title>
        <meta name="description" content="Visible browser integration fixture">
      </head>
      <body>
        <main>
          <h1>${pageName}</h1>
          <p id="copy">A robotics reference visible in the current viewport.</p>
          <label>Name <input id="name" name="name" autocomplete="off"></label>
          <button id="submit" type="button">Submit</button>
          <output id="result">Waiting</output>
          <a id="next" href="/two">Next page</a>
          <a id="download" href="/download">Download fixture</a>
          <button id="popup" type="button">Open popup</button>
        </main>
        <script>
          document.querySelector("#submit").addEventListener("click", () => {
            document.querySelector("#result").textContent =
              "Hello " + document.querySelector("#name").value;
          });
          document.querySelector("#popup").addEventListener("click", () => {
            window.open("/popup", "_blank");
          });
        </script>
      </body>
    </html>`);
});

await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const serverAddress = server.address();
assert(serverAddress && typeof serverAddress === "object");
const origin = `http://127.0.0.1:${serverAddress.port}`;

let application;
let page;
const runtimeErrors = [];

async function launch() {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	return page;
}

async function browserState() {
	const response = await page.evaluate(() =>
		window.kestrel.request({ type: "browser-get-state" }),
	);
	assert.equal(response.ok, true);
	assert("browserState" in response);
	return response.browserState;
}

async function selectNewTab() {
	const state = await browserState();
	const newTab = state.tabs.find((tab) => tab.url === "");
	assert(newTab, "The browser test has no New Tab to select");
	await page.evaluate(
		async (tabId) =>
			window.kestrel.request({ type: "browser-select-tab", tabId }),
		newTab.id,
	);
}

async function waitForBrowserState(predicate, label) {
	const deadline = Date.now() + 30_000;
	let latest;
	while (Date.now() < deadline) {
		latest = await browserState();
		if (predicate(latest)) return latest;
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

async function nativeViewState() {
	return application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("petOverlay=1"),
		);
		if (!window) throw new Error("Kestrel main window is unavailable.");
		const views = window.contentView.children
			.filter((child) => "webContents" in child)
			.map((child) => ({
				url: child.webContents.getURL(),
				title: child.webContents.getTitle(),
				bounds: child.getBounds(),
				destroyed: child.webContents.isDestroyed(),
			}));
		return {
			browserWindowCount: BrowserWindow.getAllWindows().length,
			views,
		};
	});
}

async function waitForNativeView(predicate, label) {
	const deadline = Date.now() + 30_000;
	let latest;
	while (Date.now() < deadline) {
		latest = await nativeViewState();
		if (predicate(latest)) return latest;
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

async function assertNativeViewHiddenThroughOverlayExit(locator, label) {
	const reducedMotion = await page.evaluate(
		() => matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	// Electron/Playwright can yield between the Escape key event and this
	// assertion. If the short exit has already completed there is no live
	// renderer surface left to cover; when it is still mounted, the native view
	// must remain hidden for its whole visible exit interval.
	if (!reducedMotion && (await locator.count()) > 0) {
		assert.equal(
			(await nativeViewState()).views.length,
			0,
			`${label} restored the native page before its renderer exit completed`,
		);
	}
	await locator.waitFor({ state: "detached" });
}

async function waitForNativeViewportBounds(label) {
	const deadline = Date.now() + 30_000;
	let latest;
	while (Date.now() < deadline) {
		const viewport = await page.locator("#browser-viewport").boundingBox();
		if (viewport) {
			const expected = {
				x: Math.round(viewport.x),
				y: Math.round(viewport.y),
				width: Math.round(viewport.width),
				height: Math.round(viewport.height),
				};
				latest = await nativeViewState();
				const view = latest.views[0];
				if (
					view &&
					view.bounds.x === expected.x &&
					view.bounds.y === expected.y &&
					view.bounds.width === expected.width &&
					view.bounds.height === expected.height
				) {
					return { ...latest, expectedViewport: expected };
				}
			}
		await page.evaluate(() => window.dispatchEvent(new Event("resize")));
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

async function waitForNativeViewInAnyWindow(expectedUrl, label) {
	const deadline = Date.now() + 30_000;
	let latest;
	while (Date.now() < deadline) {
		latest = await application.evaluate(
			({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()
					.filter(
						(candidate) =>
							!candidate.webContents.getURL().includes("petOverlay=1"),
					)
					.map((candidate) => ({
						url: candidate.webContents.getURL(),
						views: candidate.contentView.children
							.filter((child) => "webContents" in child)
							.map((child) =>
								"webContents" in child ? child.webContents.getURL() : "",
							),
					})),
			expectedUrl,
		);
		if (latest.some((candidate) => candidate.views.includes(expectedUrl)))
			return latest;
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

async function waitForDetachedKestrelWindow(tabId, label) {
	const deadline = Date.now() + 30_000;
	let latest = [];
	while (Date.now() < deadline) {
		latest = application.windows().map((candidate) => candidate.url());
		for (const candidate of application.windows()) {
			if (candidate === page || candidate.isClosed()) continue;
			try {
				if (
					(await candidate
						.getByRole("tablist", { name: "Browser tabs" })
						.count()) > 0 &&
					(await candidate.locator("#browser-address-input").count()) > 0 &&
					(await candidate
						.locator(`.browser-tab[data-tab-id="${tabId}"]`)
						.count()) > 0
				)
					return candidate;
			} catch {
				// A transient WebContents page may close while the detached renderer starts.
			}
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

async function assertBrowserChromeLayout({
	vertical = false,
	sidebarVisible = true,
} = {}) {
	const layout = await page.evaluate(() => {
		const bounds = (selector) => {
			const node = document.querySelector(selector);
			if (!node) return null;
			const rect = node.getBoundingClientRect();
			return {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				right: Math.round(rect.right),
				bottom: Math.round(rect.bottom),
			};
		};
		return {
			window: { width: Math.round(innerWidth), height: Math.round(innerHeight) },
			app: bounds(".ai-browser-app"),
			horizontalTabs: bounds(".browser-tab-row-horizontal"),
			verticalTabs: bounds(".browser-tab-row-vertical"),
			toolbar: bounds(".browser-toolbar"),
			bookmarks: bounds(".browser-bookmarks-bar"),
			kestrel: bounds(".kestrel-sidebar"),
			recommendations: bounds(".kestrel-widget-canvas"),
			viewport: bounds("#browser-viewport"),
			agent: bounds(".agent-sidebar"),
			toolbarDragFill: bounds(".browser-toolbar-drag-fill"),
			toolbarAppRegion: getComputedStyle(document.querySelector(".browser-toolbar")).getPropertyValue(
				"-webkit-app-region",
			),
			toolbarDragFillAppRegion: getComputedStyle(
				document.querySelector(".browser-toolbar-drag-fill"),
			).getPropertyValue("-webkit-app-region"),
		};
	});
	const tabs = vertical ? layout.verticalTabs : layout.horizontalTabs;
	assert(layout.app);
	assert(tabs);
	assert(layout.toolbar);
	assert(layout.viewport);
	assert.equal(
		Boolean(layout.kestrel),
		sidebarVisible,
		`Kestrel navigation visibility did not match the active tab: expected ${sidebarVisible}`,
	);
	const chromeBottom = Math.max(
		vertical ? layout.toolbar.bottom : tabs.bottom,
		layout.toolbar.bottom,
		layout.bookmarks?.bottom ?? 0,
	);
	if (vertical) {
		assert(layout.toolbarDragFill);
		assert(
			layout.toolbarDragFill.width >= 32,
			"Vertical browser chrome must leave a trailing window-drag area",
		);
		assert.equal(layout.toolbarAppRegion, "drag");
		assert.equal(layout.toolbarDragFillAppRegion, "drag");
		if (sidebarVisible) {
			assert(
				tabs.x >= layout.kestrel.right,
				"Vertical tabs must begin after the lower Kestrel navigation rail",
			);
		} else {
			assert.equal(
				tabs.x,
				layout.app.x,
				"Vertical tabs must begin at the window edge without Kestrel navigation",
			);
		}
		assert(tabs.y >= chromeBottom);
		assert.equal(tabs.bottom, layout.app.bottom);
	} else {
		assert.equal(tabs.x, layout.app.x);
		assert.equal(tabs.width, layout.app.width);
	}
	assert.equal(layout.toolbar.x, layout.app.x);
	assert.equal(layout.toolbar.width, layout.app.width);
	if (sidebarVisible) {
		assert(
			layout.kestrel.y >= chromeBottom,
			"Kestrel navigation must begin below full-width browser chrome",
		);
		assert.equal(layout.kestrel.x, layout.app.x);
		assert.equal(layout.kestrel.bottom, layout.app.bottom);
		assert(
			layout.viewport.x >= layout.kestrel.right,
			"Browser content must begin after the lower Kestrel navigation rail",
		);
		if (layout.recommendations) {
			assert(
				layout.recommendations.x >= layout.kestrel.right,
				"New Tab recommendations must sit beside the Kestrel navigation rail",
			);
		}
	} else if (!vertical) {
		assert.equal(
			layout.viewport.x,
			layout.app.x,
			"Browser content must begin at the window edge without Kestrel navigation",
		);
	}
	if (vertical) {
		assert(
			layout.viewport.x >= tabs.right,
			"Vertical browser content must begin after the lower tab rail",
		);
	}
	assert(
		layout.viewport.bottom <= layout.app.bottom,
		"Browser content must stay inside the window",
	);
	if (layout.agent && layout.agent.width > 0) {
		assert(
			layout.viewport.right <= layout.agent.x,
			"Browser content must stay before the lower Agent rail",
		);
		assert(
			layout.agent.y >= chromeBottom,
			"Agent rail must begin below full-width browser chrome",
		);
	}
}

async function activeViewScript(source) {
	return application.evaluate(async ({ BrowserWindow }, script) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("petOverlay=1"),
		);
		const view = window?.contentView.children.find(
			(child) => "webContents" in child,
		);
		if (!view || !("webContents" in view))
			throw new Error("No active user browser view is attached.");
		return view.webContents.executeJavaScript(script);
	}, source);
}

async function readActiveViewScript(source, label) {
	const deadline = Date.now() + 30_000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await activeViewScript(source);
		} catch (error) {
			lastError = error;
			await page.evaluate(() => window.dispatchEvent(new Event("resize")));
			await new Promise((resolveWait) => setTimeout(resolveWait, 75));
		}
	}
	throw new Error(
		`${label}: ${lastError instanceof Error ? lastError.message : "active view script failed"}`,
	);
}

async function sendInputToActiveView(input, label) {
	const deadline = Date.now() + 30_000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await application.evaluate(
				({ BrowserWindow }, event) => {
					const window = BrowserWindow.getAllWindows().find(
						(candidate) => !candidate.webContents.getURL().includes("petOverlay=1"),
					);
					const view = window?.contentView.children.find(
						(child) => "webContents" in child,
					);
					if (!view || !("webContents" in view))
						throw new Error("No active user browser view is attached.");
					view.webContents.sendInputEvent(event);
				},
				input,
			);
		} catch (error) {
			lastError = error;
			await page.evaluate(() => window.dispatchEvent(new Event("resize")));
			await new Promise((resolveWait) => setTimeout(resolveWait, 75));
		}
	}
	throw new Error(
		`${label}: ${lastError instanceof Error ? lastError.message : "active view input failed"}`,
	);
}

async function createRuntimeSessionWithVisibleBrowser() {
	return page.evaluate(async () => {
		const created = await window.kestrel.request({
			type: "runtime-create-session",
			title: "Visible browser test",
		});
		if (!created.ok || !("session" in created) || !created.session)
			throw new Error("A fresh runtime session could not be created.");
		const tools = await window.kestrel.request({
			type: "runtime-discover-tools",
			sessionId: created.session.id,
			query: "browser",
		});
		if (!tools.ok || !("tools" in tools))
			throw new Error("Fresh-session browser tools are unavailable.");
		const names = new Set((tools.tools ?? []).map((tool) => tool.name));
		for (const name of [
			"browser.tabs",
			"browser.visible-act",
			"browser.search-history",
			"browser.visible-downloads",
		])
			if (!names.has(name)) throw new Error(`${name} was not installed.`);
		return created.session.id;
	});
}

async function waitForRuntimeRunsToSettle(sessionId) {
	const settled = await page.waitForFunction(async (id) => {
		const response = await window.kestrel.request({
			type: "runtime-list-runs",
			sessionId: id,
		});
		if (!response.ok || !("runs" in response)) return false;
		const runs = response.runs ?? [];
		return (
			runs.length > 0 &&
			runs.every((run) =>
				["completed", "failed", "cancelled"].includes(run.status),
			)
		);
	}, sessionId);
	await settled.dispose();
}

async function callTool(sessionId, toolName, input, options = {}) {
	return page.evaluate(
		async ({ sessionId, toolName, input, options }) => {
			const response = await window.kestrel.request({
				type: "runtime-call-tool",
				sessionId,
				toolName,
				input,
				...options,
			});
			if (!response.ok) throw new Error(response.error);
			return response.execution;
		},
		{ sessionId, toolName, input, options },
	);
}

try {
	await launch();
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	// The New Tab greeting is intentionally contextual and may be generated
	// from the local time and recent activity. Wait for the stable semantic
	// heading instead of coupling this smoke test to one fallback sentence.
	await page.locator("#new-tab-title").waitFor();
	await page.locator("#runtime-prompt").waitFor();
	await page.locator("#new-tab-chat-input").waitFor();
	assert.equal(
		await page.getByRole("button", { name: "Open task settings" }).count(),
		1,
	);
	assert.equal(await page.getByRole("heading", { name: "Frequent tabs" }).count(), 1);
	await assertBrowserChromeLayout();
	const homeSend = page.getByRole("button", {
		name: "Send message to Pragmatic",
	});
	assert.equal(await homeSend.isDisabled(), true);
	const homePrompt = "Start with the smallest useful fix.";
	const homeSessionIdsBefore = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).map((session) => session.id)
			: [];
	});
	await page.locator("#new-tab-chat-input").fill(homePrompt);
	await homeSend.click();
	await page.waitForFunction(async (expected) => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return (
			response.ok &&
			"sessions" in response &&
			(response.sessions ?? []).length === expected.length + 1
		);
	}, homeSessionIdsBefore);
	assert.equal(await page.locator("#runtime-prompt").inputValue(), "");
	const homeSessionId = await page.evaluate(async (existingIds) => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		if (!response.ok || !("sessions" in response)) return null;
		return (
			response.sessions ?? []
		).find((session) => !existingIds.includes(session.id))?.id ?? null;
	}, homeSessionIdsBefore);
	assert(homeSessionId, "The home task did not expose its new runtime session.");
	await waitForRuntimeRunsToSettle(homeSessionId);
	const homeSessionsAfter = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	assert.equal(homeSessionsAfter, homeSessionIdsBefore.length + 1);
	await page
		.locator(".kestrel-sidebar")
		.getByRole("button", { name: "New chat" })
		.click();

	assert.equal(await page.getByRole("button", { name: "Personalize", exact: true }).count(), 0);
	await openKestrelDestination(page, "Settings");
	await page
		.locator(".settings-scope-switcher")
		.getByRole("tab", { name: /^Browser/ })
		.click();
	await page
		.getByRole("heading", { name: "Make the browser feel like yours." })
		.waitFor();
	assert.equal((await browserState()).settings.newTabBackground, "graphite");
	await selectNewTab();
	await waitForBrowserState(
		(value) => {
			const active = value.tabs.find((tab) => tab.id === value.activeTabId);
			return active?.url === "";
		},
		"Browser did not return to the New Tab page",
	);
	await page.locator("#new-tab-title").waitFor();
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	assert.equal((await browserState()).settings.newTabBackground, "graphite");

	await page.getByRole("button", { name: "Hide Pragmatic", exact: true }).first().click();
	const agentSidebar = page.locator(".agent-sidebar");
	assert.equal(await agentSidebar.getAttribute("aria-hidden"), "true");
	assert.equal(
		await agentSidebar.evaluate((sidebar) => sidebar.inert),
		true,
	);
	assert.equal(
		await agentSidebar
			.locator("button")
			.first()
			.evaluate((button) => {
				button.focus();
				return document.activeElement === button;
			}),
		false,
	);
	await page.getByRole("button", { name: "Show Pragmatic", exact: true }).waitFor();
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	await page.getByRole("button", { name: "Show Pragmatic", exact: true }).click();
	await page.getByRole("button", { name: "Hide Pragmatic", exact: true }).first().waitFor();
	assert.equal(await agentSidebar.evaluate((sidebar) => sidebar.inert), false);
	await page.locator("#runtime-prompt").waitFor();

	assert.equal(await page.locator(".runtime-suggestions").count(), 0);
	await page
		.locator(".kestrel-sidebar")
		.getByRole("button", { name: "New chat" })
		.click();

	const initialSessions = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	const initialTabs = (await browserState()).tabs.length;
	const tabList = page.getByRole("tablist", { name: "Browser tabs" });
	assert.equal(await tabList.getAttribute("aria-orientation"), "horizontal");
	await page.getByRole("button", { name: "New Tab", exact: true }).click();
	let state = await browserState();
	assert.equal(state.tabs.length, initialTabs + 1);
	const addedBlankTab = state.activeTabId;
	assert(addedBlankTab);
	const horizontalTabs = page.getByRole("tab");
	await horizontalTabs.nth(1).waitFor();
	const crowdedTabIds = await page.evaluate(async (count) => {
		const ids = [];
		for (let index = 0; index < count; index += 1) {
			const response = await window.kestrel.request({
				type: "browser-create-tab",
				active: false,
			});
			if (!response.ok || !("browserState" in response))
				throw new Error("A crowded tab fixture could not be created.");
			const created = response.browserState.tabs.at(-1);
			if (!created) throw new Error("The crowded tab fixture had no id.");
			ids.push(created.id);
		}
		return ids;
	}, 18);
	state = await waitForBrowserState(
		(value) => value.tabs.length === initialTabs + 1 + crowdedTabIds.length,
		"crowded tab fixture",
	);
	const tabRail = page.locator(".browser-tabs");
	const newTabControl = page.getByRole("button", {
		name: "New Tab",
		exact: true,
	});
	const railMetrics = await tabRail.evaluate((node) => ({
		clientWidth: node.clientWidth,
		scrollWidth: node.scrollWidth,
	}));
	assert(
		railMetrics.scrollWidth > railMetrics.clientWidth + 1,
		`Crowded tabs collapsed instead of using the bounded tab rail: ${railMetrics.scrollWidth}px <= ${railMetrics.clientWidth}px`,
	);
	const railBounds = await tabRail.boundingBox();
	const newTabBounds = await newTabControl.boundingBox();
	const windowWidth = await page.evaluate(() => window.innerWidth);
	assert(railBounds);
	assert(newTabBounds);
	assert(newTabBounds.x >= railBounds.x + railBounds.width);
	assert(newTabBounds.x + newTabBounds.width <= windowWidth);
	const firstTabId = state.tabs[0]?.id;
	assert(firstTabId);
	await horizontalTabs.first().click();
	await waitForBrowserState(
		(value) => value.activeTabId === firstTabId,
		"clicking an existing crowded tab",
	);
	const lastCrowdedTabId = crowdedTabIds.at(-1);
	assert(lastCrowdedTabId);
	await page.evaluate(
		async (tabId) => window.kestrel.request({ type: "browser-select-tab", tabId }),
		lastCrowdedTabId,
	);
	await waitForBrowserState(
		(value) => value.activeTabId === lastCrowdedTabId,
		"selecting the last crowded tab",
	);
	await page.waitForFunction(
		(index) =>
			document.querySelectorAll(".browser-tabs .browser-tab")[
				index
			]?.classList.contains("active") === true,
		state.tabs.length - 1,
	);
	const activeTabVisibility = await tabRail.evaluate((node) => {
		const active = node.querySelector(".browser-tab.active");
		if (!active) return false;
		const rail = node.getBoundingClientRect();
		const tab = active.getBoundingClientRect();
		return tab.left >= rail.left && tab.right <= rail.right;
	});
	assert(activeTabVisibility);
	const widthsBeforeClose = await tabRail
		.locator(".browser-tab")
		.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
	assert(widthsBeforeClose.length >= 5);
	assert(
		widthsBeforeClose.every((width) => width >= 110),
		`Crowded tabs fell below the readable minimum: ${JSON.stringify(widthsBeforeClose)}`,
	);
	await tabRail.locator(".browser-tab.active .browser-tab-close").click();
	state = await waitForBrowserState(
		(value) => value.tabs.length === initialTabs + crowdedTabIds.length,
		"closing one crowded tab from the tab strip",
	);
	await page.waitForFunction(
		(count) => document.querySelectorAll(".browser-tabs .browser-tab").length === count,
		widthsBeforeClose.length - 1,
	);
	const widthsDuringClose = await tabRail
		.locator(".browser-tab")
		.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
	for (const width of widthsDuringClose) {
		assert(
			Math.abs(width - widthsBeforeClose[0]) <= 1.5,
			`Tabs resized during a close burst: ${width}px vs ${widthsBeforeClose[0]}px`,
		);
	}
	await page.waitForTimeout(700);
	const widthsAfterClose = await tabRail
		.locator(".browser-tab")
		.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
	for (const width of widthsAfterClose) {
		assert(
			Math.abs(width - widthsBeforeClose[0]) <= 1.5,
			`The still-crowded strip snapped after its close settle: ${width}px vs ${widthsBeforeClose[0]}px`,
		);
	}
	const remainingCrowdedTabIds = crowdedTabIds.filter(
		(tabId) => tabId !== lastCrowdedTabId,
	);
	await page.evaluate(async (tabIds) => {
		for (const tabId of tabIds)
			await window.kestrel.request({ type: "browser-close-tab", tabId });
	}, remainingCrowdedTabIds);
	await waitForBrowserState(
		(value) => value.tabs.length === initialTabs + 1,
		"crowded tab cleanup",
	);
	await page.waitForFunction(
		(before) =>
			(document.querySelector(".browser-tabs .browser-tab")?.getBoundingClientRect()
				.width ?? 0) > before + 1,
		widthsBeforeClose[0],
	);
	await horizontalTabs.first().focus();
	await horizontalTabs.first().press("ArrowRight");
	assert.equal(
		await horizontalTabs
			.nth(1)
			.evaluate((node) => node === document.activeElement),
		true,
	);
	await page.evaluate(async (tabId) => {
		await window.kestrel.request({ type: "browser-close-tab", tabId });
	}, addedBlankTab);
	state = await browserState();
	const rendererSourceTab = state.tabs.find((tab) => tab.url === "");
	assert(rendererSourceTab);
	await page.evaluate(
		async (tabId) =>
			window.kestrel.request({ type: "browser-select-tab", tabId }),
		rendererSourceTab.id,
	);
	await waitForBrowserState(
		(value) => value.activeTabId === rendererSourceTab.id,
		"selecting the renderer-managed source tab",
	);
	await page.locator(".new-tab-page").waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained attached over the New Tab page",
	);
	await page.locator("#runtime-prompt").fill("Draft that must be cleared");
	await page
		.locator(".kestrel-sidebar")
		.getByRole("button", { name: "New chat" })
		.click();
	const clearedDraft = await page.waitForFunction(() => {
		const prompt = document.querySelector("#runtime-prompt");
		return (
			prompt instanceof HTMLTextAreaElement &&
			prompt.value === "" &&
			prompt === document.activeElement
		);
	});
	await clearedDraft.dispose();
	assert.equal(await page.locator("#runtime-prompt").inputValue(), "");
	assert.equal(
		await page
			.locator("#runtime-prompt")
			.evaluate((node) => node === document.activeElement),
		true,
	);
	assert.equal((await browserState()).tabs.length, initialTabs);
	const rendererSourceTabId = rendererSourceTab.id;
	await page.evaluate((href) => {
		const link = document.createElement("a");
		link.id = "renderer-managed-tab-fixture";
		link.href = href;
		link.target = "_blank";
		link.textContent = "Open renderer link";
		Object.assign(link.style, {
			position: "fixed",
			top: "140px",
			left: "260px",
			zIndex: "20000",
			padding: "8px",
			background: "white",
			color: "black",
		});
		document.querySelector(".new-tab-page")?.append(link);
	}, `${origin}/renderer-link`);
	await page.locator("#renderer-managed-tab-fixture").click();
	state = await waitForBrowserState(
		(value) =>
			value.tabs.length === initialTabs + 1 &&
			value.tabs.some((tab) => tab.url === `${origin}/renderer-link`),
		"Trusted renderer target=_blank link did not open in a managed tab",
	);
	const rendererManagedTab = state.tabs.find(
		(tab) => tab.url === `${origin}/renderer-link`,
	);
	assert(rendererManagedTab);
	assert.equal((await nativeViewState()).browserWindowCount, 1);
	await page.evaluate(
		async ({ managedTabId, sourceTabId }) => {
			await window.kestrel.request({
				type: "browser-close-tab",
				tabId: managedTabId,
			});
			await window.kestrel.request({
				type: "browser-select-tab",
				tabId: sourceTabId,
			});
		},
		{
			managedTabId: rendererManagedTab.id,
			sourceTabId: rendererSourceTabId,
		},
	);
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Renderer-managed tab remained attached after returning to New Tab",
	);
	const sessionsAfterIndependentActions = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	assert.equal(sessionsAfterIndependentActions, initialSessions);

	const search = page.locator("#browser-address-input");
	await search.fill(`${origin}/one`);
	await search.press("Enter");
	const loaded = await waitForNativeView(
		(value) =>
			value.views.length === 1 &&
			value.views[0]?.url === `${origin}/one` &&
			value.views[0]?.title === "Page one",
		"Visible page did not load",
	);
	assert.equal(loaded.browserWindowCount, 1);
	assert.equal(loaded.views[0].title, "Page one");
	assert.equal(loaded.views[0].destroyed, false);
	await page.locator(".kestrel-sidebar").waitFor({ state: "detached" });
	await assertBrowserChromeLayout({ sidebarVisible: false });
	const resized = await waitForNativeViewportBounds(
		"Native page did not resize after Kestrel navigation hid",
	);
	const viewport = resized.expectedViewport;
	assert(viewport);
	assert.equal(resized.views[0].bounds.x, Math.round(viewport.x));
	assert.equal(resized.views[0].bounds.y, Math.round(viewport.y));
	assert.equal(resized.views[0].bounds.height, Math.round(viewport.height));
	assert(
		Math.abs(resized.views[0].bounds.width - Math.round(viewport.width)) <= 8,
		`Native viewport width drifted: ${JSON.stringify({
			native: resized.views[0].bounds.width,
			viewport: Math.round(viewport.width),
		})}`,
	);
	// Browser pages are native WebContentsViews layered beside the renderer.
	// Menus opened from the browser chrome must temporarily release that view;
	// DOM z-index alone cannot place a renderer menu above a native sibling.
	await page.getByRole("button", { name: "Tab tools", exact: true }).click();
	const initialTabToolsMenu = page.getByRole("menu", { name: "Tab tools" });
	await initialTabToolsMenu.waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained above the tab tools menu",
	);
	await page.keyboard.press("Escape");
	await assertNativeViewHiddenThroughOverlayExit(initialTabToolsMenu, "Tab tools menu");
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after closing tab tools",
	);
	await page.getByRole("button", { name: "Browser menu", exact: true }).click();
	const browserMenu = page.getByRole("menu", { name: "Browser menu" });
	await browserMenu.waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained above the browser menu",
	);
	for (const label of [
		"New tab",
		"Zoom out",
		"Reset zoom to 100 percent",
		"Zoom in",
		"Favorites",
		"History",
		"Tab groups",
		"Downloads",
		"Extensions",
		"Passwords",
		"Clear browsing data…",
		"Print page",
		"Screenshot",
		"Find in page…",
		"More tools",
		"Settings",
		"Command Center",
	])
		assert.equal(
			await browserMenu.getByRole("menuitem", { name: label }).count(),
			1,
			`Browser menu is missing ${label}`,
		);
	await page.keyboard.press("Escape");
	await assertNativeViewHiddenThroughOverlayExit(browserMenu, "Browser menu");
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after closing browser menu",
	);
	await page.getByRole("button", { name: "Tools", exact: true }).click();
	const toolbarToolsMenu = page.getByRole("menu", { name: "Tools" });
	await toolbarToolsMenu.waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained above the toolbar tools menu",
	);
	await page.keyboard.press("Escape");
	await assertNativeViewHiddenThroughOverlayExit(toolbarToolsMenu, "Toolbar tools menu");
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after closing toolbar tools",
	);
	await sendInputToActiveView(
		{
			type: "keyDown",
			keyCode: "L",
			modifiers: ["meta"],
		},
		"The browser address-bar shortcut could not reach the active page",
	);
	await sendInputToActiveView(
		{
			type: "keyUp",
			keyCode: "L",
			modifiers: ["meta"],
		},
		"The browser address-bar shortcut could not finish on the active page",
	);
	await page.waitForFunction(
		() => document.activeElement?.id === "browser-address-input",
	);
	await page.keyboard.press("Escape");
	await assertNativeViewHiddenThroughOverlayExit(
		page.locator("#browser-address-suggestions"),
		"Address suggestions",
	);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after leaving the address bar",
	);
	await page.evaluate(() => {
		document.querySelector("#browser-address-input")?.blur();
	});
	await page.locator("#browser-address-input").click();
	await page.waitForFunction(() => {
		const input = document.querySelector("#browser-address-input");
		return (
			input instanceof HTMLInputElement &&
			document.activeElement === input &&
			input.selectionStart === 0 &&
			input.selectionEnd === input.value.length
		);
	});
	await page.waitForFunction(
		() => document.activeElement?.id === "browser-address-input",
	);
	const addressInput = page.locator("#browser-address-input");
	const currentAddress = `${origin}/one`;
	assert.equal(await addressInput.inputValue(), currentAddress);
	const selection = await addressInput.evaluate((node) => ({
		start: node.selectionStart,
		end: node.selectionEnd,
		length: node.value.length,
	}));
	assert.deepEqual(selection, {
		start: 0,
		end: selection.length,
		length: selection.length,
	});
	await addressInput.press("Meta+C");
	assert.equal(
		await application.evaluate(({ clipboard }) => clipboard.readText()),
		currentAddress,
	);
	const pastedAddress = `${origin}/two`;
	await application.evaluate(
		({ clipboard }, text) => clipboard.writeText(text),
		pastedAddress,
	);
	await addressInput.press("Meta+V");
	await page.waitForFunction(
		(expected) =>
			document.querySelector("#browser-address-input")?.value === expected,
		pastedAddress,
	);
	assert.equal(await addressInput.inputValue(), pastedAddress);
	await addressInput.fill(currentAddress);
	await page.locator("#browser-address-suggestions").waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained above the address suggestions",
	);
	await page.keyboard.press("Escape");
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after closing address suggestions",
	);

	state = await browserState();
	const tabId = state.activeTabId;
	assert(tabId);
	const runtimeSessionId = await createRuntimeSessionWithVisibleBrowser();
	await page.getByRole("button", { name: "Open Agent tab" }).click();
	await page
		.getByRole("heading", { name: "Tasks", exact: true })
		.waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained attached over Agent",
	);
	const taskRow = page.getByRole("button", {
		name: /Visible browser test, Open/,
	});
	await taskRow.waitFor();
	await taskRow.click();
	assert.equal(await taskRow.getAttribute("aria-current"), "page");
	await page.getByRole("tab", { name: /Page one/ }).first().click();
	await waitForBrowserState(
		(value) => {
			const active = value.tabs.find((tab) => tab.id === value.activeTabId);
			return active?.url === `${origin}/one`;
		},
		"Browser did not return to Page one after leaving Agent",
	);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not reattach after returning from Agent",
	);
	const blocked = await callTool(
		runtimeSessionId,
		"browser.visible-act",
		{ tabId, action: { type: "click", target: "#submit" } },
		{ idempotencyKey: "visible-browser-blocked-click" },
	);
	assert.equal(blocked?.status, "blocked");
	assert.equal(
		await readActiveViewScript(
			"document.querySelector('#result').textContent",
			"Native page was not attached for blocked-act verification",
		),
		"Waiting",
	);

	const typed = await callTool(
		runtimeSessionId,
		"browser.visible-act",
		{ tabId, action: { type: "type", target: "#name", text: "Kestrel" } },
		{
			approvalStatus: "approved",
			idempotencyKey: "visible-browser-approved-type",
		},
	);
	assert.equal(typed?.status, "verified");
	const clicked = await callTool(
		runtimeSessionId,
		"browser.visible-act",
		{ tabId, action: { type: "click", target: "#submit" } },
		{
			approvalStatus: "approved",
			idempotencyKey: "visible-browser-approved-click",
		},
	);
	assert.equal(clicked?.status, "verified");
	assert.equal(
		await readActiveViewScript(
			"document.querySelector('#result').textContent",
			"Native page was not attached for approved-act verification",
		),
		"Hello Kestrel",
	);

	const contextResponse = await page.evaluate(
		async (activeTabId) =>
			window.kestrel.request({
				type: "browser-get-context",
				tabId: activeTabId,
			}),
		tabId,
	);
	assert.equal(contextResponse.ok, true);
	assert("browserContext" in contextResponse);
	assert.equal(contextResponse.browserContext.trust, "untrusted_browser");
	assert.match(
		contextResponse.browserContext.visibleText,
		/robotics reference/,
	);
	assert(
		contextResponse.browserContext.forms.some((form) => form.name === "name"),
	);

	const snapshot = await callTool(
		runtimeSessionId,
		"browser.visible-snapshot",
		{ tabId },
		{ approvalStatus: "approved" },
	);
	assert.equal(snapshot?.status, "verified");
	assert.equal(snapshot?.output?.trust, "untrusted_browser");
	await waitForNativeView(
		(value) =>
			value.views.length === 1 &&
			value.views[0]?.url === `${origin}/one` &&
			value.views[0]?.bounds.width >= 160 &&
			value.views[0]?.bounds.height >= 120,
		"Native page was not ready for visible screenshot",
	);
	const screenshot = await callTool(
		runtimeSessionId,
		"browser.visible-screenshot",
		{ tabId },
		{ approvalStatus: "approved" },
	);
	assert.equal(screenshot?.status, "verified");
	assert.equal(screenshot?.output?.trust, "untrusted_browser");
	assert.match(String(screenshot?.output?.pngBase64 ?? ""), /^iVBOR/);

	const address = page.locator("#browser-address-input");
	await address.fill(`${origin}/two`);
	await address.press("Enter");
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/two`,
		"Second page did not load",
	);
	await waitForBrowserState(
		(value) => {
			const active = value.tabs.find((tab) => tab.id === value.activeTabId);
			return active?.url === `${origin}/two` && active.canGoBack === true;
		},
		"Back navigation did not become available",
	);
	assert.equal(
		await page.getByRole("button", { name: "Forward" }).count(),
		0,
		"Forward should be hidden until forward navigation is available",
	);
	await page.getByRole("button", { name: "Back" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Back navigation failed",
	);
	await waitForBrowserState(
		(value) => {
			const active = value.tabs.find((tab) => tab.id === value.activeTabId);
			return active?.url === `${origin}/one` && active.canGoForward === true;
		},
		"Forward navigation did not become available",
	);
	await page.getByRole("button", { name: "Forward" }).waitFor();
	await page.getByRole("button", { name: "Forward" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/two`,
		"Forward navigation failed",
	);
	await waitForBrowserState(
		(value) => {
			const active = value.tabs.find((tab) => tab.id === value.activeTabId);
			return active?.url === `${origin}/two` && active.canGoBack === true;
		},
		"Back navigation did not recover after moving forward",
	);
	await page.getByRole("button", { name: "Back" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Return to fixture failed",
	);

	const tabsBeforePagePopup = (await browserState()).tabs.length;
	await readActiveViewScript(
		"document.querySelector('#popup').click()",
		"Native page was not attached for popup click",
	);
	state = await waitForBrowserState(
		(value) =>
			value.tabs.length === tabsBeforePagePopup + 1 &&
			value.tabs.some((tab) => tab.url.endsWith("/popup")),
		"Popup tab did not open from in-page click",
	);
	let popupTab = state.tabs.find((tab) => tab.url.endsWith("/popup"));
	assert(popupTab);
	assert.equal((await nativeViewState()).browserWindowCount, 1);
	await page.evaluate(
		async ({ popupTabId, originalTabId }) => {
			await window.kestrel.request({
				type: "browser-close-tab",
				tabId: popupTabId,
			});
			await window.kestrel.request({
				type: "browser-select-tab",
				tabId: originalTabId,
			});
		},
		{ popupTabId: popupTab.id, originalTabId: tabId },
	);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Original tab was not restored after popup close",
	);

	const sourceTabIdsBeforeDetach = (await browserState()).tabs.map(
		(tab) => tab.id,
	);
	const detachableTabId = await page.evaluate(async (input) => {
		const response = await window.kestrel.request({
			type: "browser-create-tab",
			input,
			active: false,
		});
		if (!response.ok || !("browserState" in response))
			throw new Error("A detachable tab could not be created.");
		return response.browserState.tabs.at(-1)?.id;
	}, `${origin}/two`);
	assert(detachableTabId);
	await waitForBrowserState(
		(value) => value.tabs.some((tab) => tab.id === detachableTabId && tab.url === `${origin}/two`),
		"Detachable tab did not load",
	);
	const detachableTab = page.locator(
		`.browser-tab[data-tab-id="${detachableTabId}"]`,
	);
	await detachableTab.waitFor();
	const detachableBounds = await detachableTab.boundingBox();
	assert(detachableBounds);
	const detachX = detachableBounds.x + detachableBounds.width / 2;
	const detachY = detachableBounds.y + detachableBounds.height / 2;
	await page.mouse.move(detachX, detachY);
	await page.mouse.down();
	await page.waitForTimeout(50);
	await page.mouse.move(detachX, detachY + 64, { steps: 8 });
	await page.mouse.up();
	await waitForBrowserState(
		(value) => !value.tabs.some((tab) => tab.id === detachableTabId),
		"Detached tab did not leave the source window",
	);
	const detachedWindowState = await waitForNativeViewInAnyWindow(
		`${origin}/two`,
		"Detached page did not attach to its new Kestrel window",
	);
	assert.equal(detachedWindowState.length, 2);
	const detachedPage = await waitForDetachedKestrelWindow(
		detachableTabId,
		"Detached Kestrel renderer did not become available",
	);
	detachedPage.setDefaultTimeout(30_000);
	detachedPage.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	detachedPage.on("pageerror", (error) => runtimeErrors.push(error.message));
	await detachedPage.getByRole("tablist", { name: "Browser tabs" }).waitFor();
	await detachedPage.locator("#browser-address-input").waitFor();
	assert.equal(await detachedPage.getByRole("tab", { name: "Page two", exact: true }).count(), 1);
	await detachedPage.close();
	await waitForBrowserState(
		(value) =>
			value.tabs.length === sourceTabIdsBeforeDetach.length &&
			sourceTabIdsBeforeDetach.every((id) =>
				value.tabs.some((tab) => tab.id === id),
			) &&
			!value.tabs.some((tab) => tab.id === detachableTabId) &&
			value.tabs.some((tab) => tab.id === tabId && tab.url === `${origin}/one`),
		"Source browser did not retain its remaining tab after detachment",
	);

	const tabsBeforeToolPopup = (await browserState()).tabs.length;
	const openedPopup = await callTool(
		runtimeSessionId,
		"browser.visible-act",
		{ tabId, action: { type: "click", target: "#popup" } },
		{
			approvalStatus: "approved",
			idempotencyKey: "visible-browser-approved-popup",
		},
	);
	assert.equal(openedPopup?.status, "verified");
	state = await waitForBrowserState(
		(value) =>
			value.tabs.length === tabsBeforeToolPopup + 1 &&
			value.tabs.some((tab) => tab.url.endsWith("/popup")),
		"Popup tab did not open from tool act",
	);
	popupTab = state.tabs.find((tab) => tab.url.endsWith("/popup"));
	assert(popupTab);
	assert.equal((await nativeViewState()).browserWindowCount, 1);
	await page.evaluate(
		async ({ popupTabId, originalTabId }) => {
			await window.kestrel.request({
				type: "browser-close-tab",
				tabId: popupTabId,
			});
			await window.kestrel.request({
				type: "browser-select-tab",
				tabId: originalTabId,
			});
		},
		{ popupTabId: popupTab.id, originalTabId: tabId },
	);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Original tab was not restored after popup close",
	);

	await readActiveViewScript(
		"document.querySelector('#download').click()",
		"Native page was not attached for download click",
	);
	state = await waitForBrowserState(
		(value) =>
			value.downloads.some(
				(download) =>
					download.filename === "kestrel-browser.txt" &&
					download.status === "completed",
			),
		"Visible browser download did not complete",
	);
	const download = state.downloads.find(
		(item) => item.filename === "kestrel-browser.txt",
	);
	assert(download);
	assert.equal(download.status, "completed");
	assert.equal(download.filename, "kestrel-browser.txt");
	assert.equal(download.canReveal, true);
	assert.equal(
		existsSync(join(userData, "browser-downloads", download.filename)),
		true,
	);
	const historyTool = await callTool(
		runtimeSessionId,
		"browser.search-history",
		{ query: "Page one", limit: 10 },
		{ approvalStatus: "approved" },
	);
	assert.equal(historyTool?.status, "verified");
	assert.equal(historyTool?.output?.trust, "untrusted_browser");
	assert(
		historyTool?.output?.entries?.some((entry) => entry.title === "Page one"),
	);
	const downloadsTool = await callTool(
		runtimeSessionId,
		"browser.visible-downloads",
		{},
		{ approvalStatus: "approved" },
	);
	assert.equal(downloadsTool?.status, "verified");
	assert.equal(downloadsTool?.output?.trust, "untrusted_browser");
	assert.equal(
		downloadsTool?.output?.downloads?.at(-1)?.filename,
		"kestrel-browser.txt",
	);

	await page.keyboard.press("Meta+H");
	await page.getByPlaceholder("Search history").waitFor();
	await page.getByPlaceholder("Search history").fill("Page one");
	await page
		.getByRole("button", { name: /Page one/ })
		.first()
		.waitFor();

	await page.keyboard.press("Meta+J");
	await page
		.getByRole("heading", { name: "Downloaded files", exact: true })
		.waitFor();
	await page.getByText("kestrel-browser.txt", { exact: true }).waitFor();
	await openKestrelDestination(page, "Settings");
	await page
		.getByRole("heading", { name: "Settings", exact: true })
		.waitFor();
	const browserSettings = page
		.locator(".settings-scope-switcher")
		.getByRole("tab", { name: /^Browser/ });
	await browserSettings.click();
	assert.equal(await browserSettings.getAttribute("aria-selected"), "true");
	await page
		.getByRole("heading", { name: "Make the browser feel like yours.", exact: true })
		.waitFor();
	await page
		.locator("label.background-option")
		.filter({ hasText: "Mountain valley" })
		.click();
	await page.getByLabel("Search engine", { exact: true }).selectOption("ecosia");
	const useCurrentPage = page.getByRole("switch", {
		name: "Use current page context with agent",
	});
	if ((await useCurrentPage.getAttribute("aria-checked")) === "true")
		await useCurrentPage.click();
	assert.equal(
		await page.evaluate(() => localStorage.getItem("kestrel:browser-context")),
		"off",
	);
	await useCurrentPage.click();
	assert.equal(await useCurrentPage.getAttribute("aria-checked"), "true");
	await page.getByLabel("Tab layout").selectOption("vertical");
	state = await waitForBrowserState(
		(candidate) =>
			candidate.settings.searchEngine === "ecosia" &&
			candidate.settings.tabLayout === "vertical" &&
			candidate.settings.newTabBackground === "mountains",
		"browser settings update",
	);
	assert.equal(state.settings.searchEngine, "ecosia");
	assert.equal(state.settings.tabLayout, "vertical");
	assert.equal(state.settings.newTabBackground, "mountains");

	await page.getByRole("tab", { name: /Page one/ }).first().click();
	await waitForBrowserState(
		(value) => {
			const active = value.tabs.find((tab) => tab.id === value.activeTabId);
			return active?.url === `${origin}/one`;
		},
		"Browser did not return to Page one after leaving Settings",
	);
	await page.getByRole("tablist", { name: "Browser tabs" }).waitFor();
	assert.equal(
		await page
			.getByRole("tablist", { name: "Browser tabs" })
			.getAttribute("aria-orientation"),
		"vertical",
	);
	await page.waitForFunction(() => {
		const viewport = document.querySelector("#browser-viewport");
		const agent = document.querySelector(".agent-sidebar");
		if (!viewport || !agent) return false;
		const viewportBounds = viewport.getBoundingClientRect();
		const agentBounds = agent.getBoundingClientRect();
		return viewportBounds.width > 0 && viewportBounds.right <= agentBounds.x;
	});
	await page.locator(".kestrel-sidebar").waitFor({ state: "detached" });
	await assertBrowserChromeLayout({ vertical: true, sidebarVisible: false });
	const tabToolsTrigger = page.getByRole("button", { name: "Tab tools" });
	await tabToolsTrigger.click();
	const tabToolsMenu = page.getByRole("menu", { name: "Tab tools" });
	await tabToolsMenu.waitFor();
	const tabToolsBounds = await tabToolsMenu.boundingBox();
	const windowBounds = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
	}));
	assert(tabToolsBounds, "Vertical tab tools menu did not receive a layout box");
	assert(
		tabToolsBounds.x >= 0 &&
			tabToolsBounds.y >= 0 &&
			tabToolsBounds.x + tabToolsBounds.width <= windowBounds.width &&
			tabToolsBounds.y + tabToolsBounds.height <= windowBounds.height,
		`Vertical tab tools menu escaped the window: ${JSON.stringify({ tabToolsBounds, windowBounds })}`,
	);
	await page.keyboard.press("Escape");
	await tabToolsMenu.waitFor({ state: "detached" });
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after leaving Settings",
	);
	const verticalViewport = await page
		.locator("#browser-viewport")
		.boundingBox();
	assert(verticalViewport);
	await waitForNativeView(
		(value) =>
			value.views[0]?.bounds.x === Math.round(verticalViewport.x) &&
			value.views[0]?.bounds.y === Math.round(verticalViewport.y) &&
			value.views[0]?.bounds.width === Math.round(verticalViewport.width) &&
			value.views[0]?.bounds.height === Math.round(verticalViewport.height),
		"Native page did not resize for the vertical tab rail",
	);
	const inactiveVerticalTabId = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "browser-create-tab",
			active: false,
		});
		if (!response.ok || !("browserState" in response))
			throw new Error("An inactive vertical tab could not be created.");
		return response.browserState.tabs.at(-1)?.id;
	});
	assert(inactiveVerticalTabId);
	const verticalTabs = page.getByRole("tab");
	await verticalTabs.nth(1).waitFor();
	await verticalTabs.first().focus();
	await verticalTabs.first().press("ArrowDown");
	assert.equal(
		await verticalTabs
			.nth(1)
			.evaluate((node) => node === document.activeElement),
		true,
	);
	await page.evaluate(
		async (tabId) =>
			window.kestrel.request({ type: "browser-close-tab", tabId }),
		inactiveVerticalTabId,
	);
	const organizationFixtureUrls = [`${origin}/two`, `${origin}/one`];
	const organizationFixtureTabIds = await page.evaluate(async (urls) => {
		const ids = [];
		for (const input of urls) {
			const response = await window.kestrel.request({
				type: "browser-create-tab",
				input,
				active: false,
			});
			if (!response.ok)
				throw new Error("Organization fixture tab could not be created.");
			if (!("browserState" in response))
				throw new Error("Organization fixture state was not returned.");
			const created = response.browserState.tabs.at(-1);
			if (!created) throw new Error("Organization fixture tab had no id.");
			ids.push(created.id);
		}
		return ids;
	}, organizationFixtureUrls);
	state = await waitForBrowserState(
		(value) =>
			organizationFixtureUrls.every((url) =>
				value.tabs.some((tab) => tab.url === url),
			),
		"organization fixture tabs",
	);
	const tabOrderBeforeOrganization = state.tabs.map((tab) => tab.id);
	const organizationPreview = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "browser-preview-organize-tabs",
		});
		if (!response.ok || !("browserOrganization" in response))
			throw new Error("The tab organization preview was unavailable.");
		return response.browserOrganization;
	});
	const previewFolderOrder = [];
	for (const tab of organizationPreview.tabs) {
		if (tab.tabFolderId && !previewFolderOrder.includes(tab.tabFolderId))
			previewFolderOrder.push(tab.tabFolderId);
	}
	assert.deepEqual(
		previewFolderOrder,
		organizationPreview.tabFolders.map((folder) => folder.id),
		"Organization preview must preserve first-seen group order",
	);
	await page.getByRole("button", { name: "Tab tools", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Organize tabs", exact: true })
		.click();
	const organizeDialog = page.getByRole("dialog", { name: "Organize tabs" });
	await organizeDialog.waitFor();
	assert.equal(
		await organizeDialog.getByText("Does this grouping fit?", { exact: true }).count(),
		0,
	);
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained attached over the organize tabs dialog",
	);
	await organizeDialog.getByRole("button", { name: "Close organize tabs" }).click();
	await assertNativeViewHiddenThroughOverlayExit(organizeDialog, "Organize tabs dialog");
	assert.deepEqual(
		(await browserState()).tabs.map((tab) => tab.id),
		tabOrderBeforeOrganization,
		"Canceling tab organization must leave tab order unchanged",
	);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after canceling tab organization",
	);
	await page.getByRole("button", { name: "Tab tools", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Organize tabs", exact: true })
		.click();
	await organizeDialog.waitFor();
	await organizeDialog.getByRole("button", { name: /^Edit / }).first().click();
	await organizeDialog.getByLabel("Folder name").fill("Local Pages");
	await organizeDialog.getByRole("button", { name: "Rose", exact: true }).click();
	await organizeDialog.getByRole("button", { name: "Save", exact: true }).click();
	await organizeDialog.getByRole("button", { name: "Group tabs", exact: true }).click();
	await organizeDialog.waitFor({ state: "detached" });
	state = await waitForBrowserState(
		(value) => value.tabFolders.some((folder) => folder.name === "Local Pages"),
		"reviewed tab organization",
	);
	assert.deepEqual(
		state.tabs.map((tab) => tab.id),
		organizationPreview.tabs.map((tab) => tab.id),
		"Applying reviewed organization must preserve the proposed group/tab order",
	);
	const reviewedFolder = state.tabFolders.find((folder) => folder.name === "Local Pages");
	assert(reviewedFolder);
	assert.equal(reviewedFolder.color, "rose");
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after applying tab organization",
	);
	await page.evaluate(async (tabIds) => {
		for (const tabId of tabIds) {
			const response = await window.kestrel.request({
				type: "browser-close-tab",
				tabId,
			});
			if (!response.ok) throw new Error("Organization fixture cleanup failed.");
		}
	}, organizationFixtureTabIds);
	await waitForBrowserState(
		(value) => !organizationFixtureTabIds.some((tabId) => value.tabs.some((tab) => tab.id === tabId)),
		"organization fixture cleanup",
	);
	await page.screenshot({
		path:
			process.env.KESTREL_BROWSER_SCREENSHOT ?? join(root, "browser-shell.png"),
		fullPage: false,
	});
	const urlsBeforeRestart = (await browserState()).tabs.map((tab) => tab.url);

	await application.close();
	application = undefined;
	page = undefined;

	await launch();
	await page.getByRole("tab", { name: /Page one/ }).waitFor();
	state = await browserState();
	assert.deepEqual(
		state.tabs.map((tab) => tab.url),
		urlsBeforeRestart,
	);
	assert(state.tabs.some((tab) => tab.url === `${origin}/one`));
	assert(state.history.some((entry) => entry.title === "Page one"));
	assert(state.history.some((entry) => entry.title === "Page two"));
	assert.equal(state.settings.searchEngine, "ecosia");
	assert.equal(state.settings.tabLayout, "vertical");
	assert.equal(state.settings.newTabBackground, "mountains");
	assert.equal(
		await page
			.getByRole("tablist", { name: "Browser tabs" })
			.getAttribute("aria-orientation"),
		"vertical",
	);
	assert.equal(state.downloads.at(-1)?.status, "completed");
	assert.equal(state.downloads.at(-1)?.canReveal, false);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Restored tab did not reload",
	);

	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		"Visible browser smoke passed: independent tabs/tasks, agent task resume, horizontal and vertical tab keyboard layouts, native bounds, navigation, history, context, approval-gated actions, AX/screenshot, popup tabs, full Kestrel detached windows, downloads, search settings, hidden-view routing, and restart restore.\n",
	);
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
