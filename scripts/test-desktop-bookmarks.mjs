import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { exerciseSavedPages } from "./desktop-bookmark-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-saved-pages-"));
const userData = join(root, "user-data");
const testHome = join(root, "home");
const testCodexHome = join(root, "codex-home");
for (const path of [testHome, testCodexHome]) mkdirSync(path, { recursive: true });
const environment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
		process.env[key] === undefined ? [] : [[key, process.env[key]]]),
);
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const server = createServer((request, response) => {
	if (request.url === "/favicon.png") {
		response.writeHead(200, { "content-type": "image/png" });
		response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
		return;
	}
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end('<!doctype html><html><head><title>Page one</title><link rel="icon" href="/favicon.png"></head><body><h1>Page one</h1></body></html>');
});
let application;
let page;
const errors = [];

async function browserState() {
	const response = await page.evaluate(() => window.kestrel.request({ type: "browser-get-state" }));
	assert.equal(response.ok, true);
	assert(response.browserState);
	return response.browserState;
}

async function waitForBrowserState(predicate, label) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const state = await browserState();
		if (predicate(state)) return state;
		await page.waitForTimeout(75);
	}
	throw new Error(label);
}

async function waitForNativeView(predicate, label) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const state = await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && !candidate.webContents.getURL().includes("petOverlay=1"));
			if (!window) throw new Error("Kestrel fixture window is unavailable.");
			return { views: window.contentView.children.filter(child => "webContents" in child).map(child => ({ url: child.webContents.getURL() })) };
		});
		if (predicate(state)) return state;
		await page.waitForTimeout(75);
	}
	throw new Error(label);
}

try {
	await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
	const origin = `http://127.0.0.1:${server.address().port}`;
	application = await electron.launch({
		executablePath: packagedExecutable ? resolve(packagedExecutable) : requireFromDesktop("electron"),
		args: packagedExecutable ? ["--use-mock-keychain"] : [resolve("apps/desktop"), "--use-mock-keychain"],
		env: {
			...environment,
			HOME: testHome,
			CODEX_HOME: testCodexHome,
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_TEST_MOCK_KEYCHAIN: "1",
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForURL(url => url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"));
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	// Start with Agent open so the responsive transition must return through
	// the visible Close chat/Hide control before bookmark management.
	const agentToggle = page.locator("#browser-agent-toggle");
	if ((await agentToggle.getAttribute("aria-expanded")) !== "true") await agentToggle.click();
	const created = await page.evaluate(input => window.kestrel.request({ type: "browser-create-tab", input, active: true }), `${origin}/one`);
	assert.equal(created.ok, true);
	await waitForNativeView(state => state.views[0]?.url === `${origin}/one`, "Fixture native page did not load.");
	await waitForBrowserState(state => state.tabs.some(tab => tab.url === `${origin}/one` && tab.title === "Page one" && tab.faviconDataUrl?.startsWith("data:image/")), "Fixture title and favicon did not arrive.");
	await exerciseSavedPages({ page, application, origin, browserState, waitForBrowserState, waitForNativeView, packagedExecutable });
	await page.reload();
	await waitForBrowserState(state => state.bookmarks.length === 0 && state.bookmarkFolders.length === 0, "Deleted Saved pages fixtures returned after reload.");
	assert.deepEqual(errors, []);
	process.stdout.write("Saved pages smoke passed: real native fixture, keyboard entry, responsive pane, presentation/folder choices, editing, deletion, and reload persistence.\n");
} catch (error) {
	try {
		const directory = resolve(".tmp/desktop-browser");
		mkdirSync(directory, { recursive: true });
		await page?.screenshot({ path: join(directory, `${packagedExecutable ? "packaged" : "source"}-saved-pages-failure.png`) });
	} catch { /* Preserve the original failure when evidence capture is unavailable. */ }
	throw error;
} finally {
	await application?.close();
	if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
