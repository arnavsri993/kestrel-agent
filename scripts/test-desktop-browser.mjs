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
	await page
		.getByRole("heading", { name: "Hi there, what should we dive into today?" })
		.waitFor();
	await page.locator("#runtime-prompt").waitFor();
	await page.locator("#new-tab-chat-input").waitFor();
	assert.equal(await page.locator(".kestrel-home-model-selector summary").count(), 1);
	assert.equal(await page.getByRole("heading", { name: "Frequent tabs" }).count(), 1);
	const homeSend = page.getByRole("button", {
		name: "Open message in Pragmatic composer",
	});
	assert.equal(await homeSend.isDisabled(), true);
	const homePrompt = "Start with the smallest useful fix.";
	const homeSessionsBefore = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	await page.locator("#new-tab-chat-input").fill(homePrompt);
	await homeSend.click();
	await page.waitForFunction((expected) => {
		const prompt = document.querySelector("#runtime-prompt");
		return prompt instanceof HTMLTextAreaElement && prompt.value === expected;
	}, homePrompt);
	const homeSessionsAfter = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	assert.equal(homeSessionsAfter, homeSessionsBefore);
	await page.getByRole("button", { name: "New chat" }).click();

	assert.equal(await page.getByRole("button", { name: "Personalize", exact: true }).count(), 0);
	await openKestrelDestination(page, "Settings");
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: /^Browser/ })
		.click();
	await page.getByRole("heading", { name: "Tabs & General" }).waitFor();
	assert.equal((await browserState()).settings.newTabBackground, "graphite");
	await page.getByRole("button", { name: "Back to Browser" }).click();
	await page
		.getByRole("heading", { name: "Hi there, what should we dive into today?" })
		.waitFor();
	await page.reload();
	await page
		.getByRole("heading", { name: "Hi there, what should we dive into today?" })
		.waitFor();
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
	await page.getByRole("button", { name: "Chat with Pragmatic", exact: true }).waitFor();
	await page.reload();
	await page
		.getByRole("heading", { name: "Hi there, what should we dive into today?" })
		.waitFor();
	await page.getByRole("button", { name: "Chat with Pragmatic", exact: true }).click();
	await page.getByRole("button", { name: "Hide Pragmatic", exact: true }).first().waitFor();
	assert.equal(await agentSidebar.evaluate((sidebar) => sidebar.inert), false);
	await page.locator("#runtime-prompt").waitFor();

	const suggestedActions = page.getByRole("button", {
		name: /^Add to Pragmatic composer:/,
	});
	assert.equal(await suggestedActions.count(), 5);
	const sessionsBeforeSuggestion = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	await suggestedActions.first().click();
	await page.waitForFunction(() => {
		const prompt = document.querySelector("#runtime-prompt");
		return (
			prompt instanceof HTMLTextAreaElement &&
			prompt.value ===
				"Review the current project and context. Identify the highest-impact issues, explain why they matter, and recommend the smallest useful next step. Do not change anything until the review is clear."
		);
	});
	const sessionsAfterSuggestion = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).length
			: -1;
	});
	assert.equal(sessionsAfterSuggestion, sessionsBeforeSuggestion);
	await page.getByRole("button", { name: "New task", exact: true }).click();

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
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained attached over the New Tab page",
	);
	await page.locator("#runtime-prompt").fill("Draft that must be cleared");
	await page.getByRole("button", { name: "New task", exact: true }).click();
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
	const rendererSourceTabId = (await browserState()).activeTabId;
	assert(rendererSourceTabId);
	await page.evaluate((href) => {
		const link = document.createElement("a");
		link.id = "renderer-managed-tab-fixture";
		link.href = href;
		link.target = "_blank";
		link.textContent = "Open renderer link";
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
	const viewport = await page.locator("#browser-viewport").boundingBox();
	assert(viewport);
	assert.deepEqual(loaded.views[0].bounds, {
		x: Math.round(viewport.x),
		y: Math.round(viewport.y),
		width: Math.round(viewport.width),
		height: Math.round(viewport.height),
	});
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("petOverlay=1"),
		);
		const view = window?.contentView.children.find(
			(child) => "webContents" in child,
		);
		if (!view || !("webContents" in view))
			throw new Error("No active user browser view is attached.");
		view.webContents.sendInputEvent({
			type: "keyDown",
			keyCode: "L",
			modifiers: ["meta"],
		});
		view.webContents.sendInputEvent({
			type: "keyUp",
			keyCode: "L",
			modifiers: ["meta"],
		});
	});
	await page.waitForFunction(
		() => document.activeElement?.id === "browser-address-input",
	);

	state = await browserState();
	const tabId = state.activeTabId;
	assert(tabId);
	const runtimeSessionId = await createRuntimeSessionWithVisibleBrowser();
	await page.getByRole("button", { name: "Open chat in the full window" }).click();
	await page
		.getByRole("heading", { name: "Agent Workspace", exact: true })
		.waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained attached over Agent",
	);
	const taskRow = page.getByRole("button", {
		name: /Visible browser test, Open, Conversation only/,
	});
	await taskRow.waitFor();
	await taskRow.click();
	assert.equal(await taskRow.getAttribute("aria-current"), "page");
	await page.getByRole("button", { name: "Back to Browser" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Native page did not return after leaving Agent",
	);
	const blocked = await callTool(
		runtimeSessionId,
		"browser.visible-act",
		{ tabId, action: { type: "click", target: "#submit" } },
		{ idempotencyKey: "visible-browser-blocked-click" },
	);
	assert.equal(blocked?.status, "blocked");
	assert.equal(
		await activeViewScript("document.querySelector('#result').textContent"),
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
		await activeViewScript("document.querySelector('#result').textContent"),
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
	await page.getByRole("button", { name: "Back" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Back navigation failed",
	);
	await page.getByRole("button", { name: "Forward" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/two`,
		"Forward navigation failed",
	);
	await page.getByRole("button", { name: "Back" }).click();
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Return to fixture failed",
	);

	await activeViewScript("document.querySelector('#popup').click() ");
	state = await waitForBrowserState(
		(value) =>
			value.tabs.length === 2 &&
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
	const detachableTab = page.getByRole("tab", { name: "Page two", exact: true });
	await detachableTab.waitFor();
	const detachableBounds = await detachableTab.boundingBox();
	assert(detachableBounds);
	const detachedWindowPromise = application.waitForEvent("window");
	await page.mouse.move(
		detachableBounds.x + detachableBounds.width / 2,
		detachableBounds.y + detachableBounds.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		detachableBounds.x + detachableBounds.width / 2,
		detachableBounds.y + detachableBounds.height + 80,
		{ steps: 4 },
	);
	await page.mouse.up();
	const detachedPage = await detachedWindowPromise;
	detachedPage.setDefaultTimeout(30_000);
	detachedPage.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	detachedPage.on("pageerror", (error) => runtimeErrors.push(error.message));
	await detachedPage.getByRole("tablist", { name: "Browser tabs" }).waitFor();
	await detachedPage.locator("#browser-address-input").waitFor();
	assert.equal(await detachedPage.getByRole("tab", { name: "Page two", exact: true }).count(), 1);
	const detachedWindowState = await waitForNativeViewInAnyWindow(
		`${origin}/two`,
		"Detached page did not attach to its new Kestrel window",
	);
	assert.equal(detachedWindowState.length, 2);
	await detachedPage.close();
	await waitForBrowserState(
		(value) => value.tabs.length === 1 && value.tabs[0]?.url === `${origin}/one`,
		"Source browser did not retain its remaining tab after detachment",
	);

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
			value.tabs.length === 2 &&
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

	await activeViewScript("document.querySelector('#download').click() ");
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
	await page
		.getByRole("heading", { name: "Pages you visited", exact: true })
		.waitFor();
	await waitForNativeView(
		(value) => value.views.length === 0,
		"Native page remained attached over History",
	);
	await page.getByPlaceholder("Search history").fill("Page one");
	await page
		.getByRole("button", { name: /Page one/ })
		.first()
		.waitFor();

	await page.keyboard.press("Meta+J");
	await page
		.getByRole("heading", { name: "Files from the web", exact: true })
		.waitFor();
	await page.getByText("kestrel-browser.txt", { exact: true }).waitFor();
	await openKestrelDestination(page, "Settings");
	await page
		.getByRole("heading", { name: "Preferences", exact: true })
		.waitFor();
	const browserSettings = page
		.locator(".settings-nav")
		.getByRole("button", { name: /^Browser/ });
	await browserSettings.click();
	assert.equal(await browserSettings.getAttribute("aria-current"), "page");
	await page
		.getByRole("heading", { name: "Tabs & General", exact: true })
		.waitFor();
	await page.getByLabel("Search engine", { exact: true }).selectOption("ecosia");
	await page.getByLabel("Tab layout").selectOption("vertical");
	state = await waitForBrowserState(
		(candidate) =>
			candidate.settings.searchEngine === "ecosia" &&
			candidate.settings.tabLayout === "vertical",
		"browser settings update",
	);
	assert.equal(state.settings.searchEngine, "ecosia");
	assert.equal(state.settings.tabLayout, "vertical");
	const useCurrentPage = page.getByRole("checkbox", {
		name: /Use current page/,
	});
	await useCurrentPage.uncheck();
	assert.equal(
		await page.evaluate(() => localStorage.getItem("kestrel:browser-context")),
		"off",
	);
	await useCurrentPage.check();

	await page.getByRole("button", { name: "Back to Browser" }).click();
	await page.getByRole("tablist", { name: "Browser tabs" }).waitFor();
	assert.equal(
		await page
			.getByRole("tablist", { name: "Browser tabs" })
			.getAttribute("aria-orientation"),
		"vertical",
	);
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
	await page.screenshot({
		path:
			process.env.KESTREL_BROWSER_SCREENSHOT ?? join(root, "browser-shell.png"),
		fullPage: false,
	});

	await application.close();
	application = undefined;
	page = undefined;

	await launch();
	await page.getByRole("tab", { name: /Page one/ }).waitFor();
	state = await browserState();
	assert.equal(state.tabs.length, 1);
	assert.equal(state.tabs[0]?.url, `${origin}/one`);
	assert(state.history.some((entry) => entry.title === "Page one"));
	assert(state.history.some((entry) => entry.title === "Page two"));
	assert.equal(state.settings.searchEngine, "ecosia");
	assert.equal(state.settings.tabLayout, "vertical");
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
