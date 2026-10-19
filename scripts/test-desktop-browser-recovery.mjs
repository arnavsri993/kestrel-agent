import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
// This smoke deliberately crashes only browser views in its own disposable
// profile. KESTREL_DESKTOP_EXECUTABLE may point at /Applications/Kestrel.app's
// executable; the person's running app, profile, and Keychain stay untouched.
const root = mkdtempSync(join(tmpdir(), "kestrel-browser-recovery-profile-"));
const userData = join(root, "user-data");
const artifactDir = process.env.KESTREL_BROWSER_RECOVERY_ARTIFACT_DIR
	? resolve(process.env.KESTREL_BROWSER_RECOVERY_ARTIFACT_DIR)
	: mkdtempSync(join(tmpdir(), "kestrel-browser-recovery-artifacts-"));
mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable ? resolve(packagedExecutable) : requireFromDesktop("electron");
const launchArgs = packagedExecutable ? ["--use-mock-keychain"] : [resolve("apps/desktop")];
const receipt = { status: "running", startedAt: new Date().toISOString(), executablePath,
	packagedExecutable: Boolean(packagedExecutable), isolatedUserData: userData, artifactDir, checks: [] };
const runtimeErrors = [];
const slowResponses = new Set();
let slowRequests = 0;
let application;
let page;
let launchNumber = 0;
function log(message) {
	const line = `${new Date().toISOString()} ${message}\n`;
	appendFileSync(join(artifactDir, "smoke.log"), line);
	process.stdout.write(line);
}
function fixture(request, response) {
	const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	if (pathname === "/favicon.ico") {
		response.writeHead(204).end();
		return;
	}
	const title = pathname === "/two" ? "Companion fixture" : "Recovery fixture";
	response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.write(`<!doctype html><html><head><title>${title}</title></head>
		<body><main><h1 id="fixture-ready">${title}</h1>
		<p>Local browser recovery verification.</p></main>`);
	if (pathname === "/slow") {
		slowRequests += 1;
		slowResponses.add(response);
		response.on("close", () => slowResponses.delete(response));
		// Intentionally keep the main document open until Stop or test cleanup.
		response.flushHeaders();
		return;
	}
	response.end("</body></html>");
}
const server = createServer(fixture);
const retryServer = createServer(fixture);
async function listen(target, port = 0) {
	await new Promise((resolveListen, rejectListen) => {
		const failed = (error) => { target.off("listening", ready); rejectListen(error); };
		const ready = () => { target.off("error", failed); resolveListen(); };
		target.once("error", failed);
		target.once("listening", ready);
		target.listen(port, "127.0.0.1");
	});
	const address = target.address();
	assert(address && typeof address === "object");
	return address.port;
}
async function closeServer(target) {
	if (!target.listening) return;
	const closed = new Promise((resolveClose, rejectClose) =>
		target.close((error) => error ? rejectClose(error) : resolveClose()),
	);
	target.closeAllConnections();
	await bounded(closed, "Local fixture shutdown", 10_000);
}
async function bounded(promise, label, timeout = 30_000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeout); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function check(name, run) {
	const started = Date.now();
	log(`Starting: ${name}`);
	try {
		const evidence = await bounded(run(), name, 60_000);
		receipt.checks.push({ name, status: "passed", durationMs: Date.now() - started, evidence });
		log(`Passed: ${name}`);
	} catch (error) {
		receipt.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: String(error) });
		throw error;
	}
}
async function launch() {
	launchNumber += 1;
	application = await electron.launch({
		executablePath, args: launchArgs, timeout: 45_000,
		env: {
			...process.env,
			// Inherited recovery overrides must never opt this disposable profile
			// into the person's Keychain or provider-owned protected storage.
			KESTREL_USE_MOCK_KEYCHAIN: "1", KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE: "1",
			KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_TEST_USER_DATA: userData,
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	const child = application.process();
	const sequence = launchNumber;
	for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
		stream?.on("data", (data) =>
			appendFileSync(join(artifactDir, `launch-${sequence}-${name}.log`), data),
		);
	}
	const actual = await application.evaluate(({ app }) => ({ userData: app.getPath("userData"), version: app.getVersion() }));
	assert.equal(resolve(actual.userData), resolve(userData), "Refusing to test a non-disposable profile.");
	receipt.appVersion = actual.version;
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error")
			appendFileSync(join(artifactDir, "renderer-console.log"), `${message.text()}\n`);
	});
	await page.waitForURL((url) => url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"));
	await page.waitForLoadState("domcontentloaded");
	await page.emulateMedia({ reducedMotion: "reduce" });
	if (launchNumber === 1) {
		await page.evaluate(() => {
			localStorage.setItem("kestrel:onboarded", "yes");
			localStorage.setItem("kestrel:default-browser-prompted", "yes");
		});
		await page.reload();
	}
	await page.locator("#browser-address-input").waitFor();
}
async function closeApplication() {
	if (!application) return;
	const closing = application;
	application = undefined;
	page = undefined;
	try {
		await bounded(closing.close(), "Disposable Kestrel shutdown", 20_000);
	} catch (error) {
		closing.process().kill("SIGKILL");
		throw error;
	}
}
async function request(input) {
	const response = await bounded(page.evaluate((value) => window.kestrel.request(value), input), input.type);
	assert.equal(response.ok, true, `${input.type}: ${response.error ?? "request failed"}`);
	return response;
}
async function browserState() {
	const response = await request({ type: "browser-get-state" });
	assert("browserState" in response);
	return response.browserState;
}
async function waitFor(read, predicate, label) {
	const deadline = Date.now() + 30_000;
	let latest;
	while (Date.now() < deadline) {
		latest = await bounded(read(), label, 10_000);
		if (predicate(latest)) return latest;
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}
async function navigate(input) {
	const address = page.locator("#browser-address-input");
	await address.fill(input);
	await address.press("Enter");
}
async function fixtureVisible(url, title = "Recovery fixture") {
	await waitFor(browserState, (state) => {
		const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
		return tab?.url === url && !tab.loading && !tab.error && !tab.crashed;
	}, `Tab did not recover ${url}`);
	return waitFor(() => application.evaluate(async ({ BrowserWindow }, expectedUrl) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.webContents.getURL().includes("petOverlay=1")) continue;
			for (const view of window.contentView.children) {
				if (!("webContents" in view) || view.webContents.isDestroyed()) continue;
				const wc = view.webContents;
				if (wc.getURL() !== expectedUrl) continue;
				try {
					return { id: wc.id, pid: wc.getOSProcessId(), url: wc.getURL(), bounds: view.getBounds(), visible: view.getVisible(),
						heading: await wc.executeJavaScript('document.querySelector("#fixture-ready")?.textContent'),
						loading: wc.isLoading() };
				} catch { return null; }
			}
		}
		return null;
	}, url), (value) => value?.heading === title && value.visible && !value.loading && value.bounds.width > 100 && value.bounds.height > 100,
	`Fixture DOM was not visibly attached for ${url}`);
}
async function screenshot(name) {
	const captures = await bounded(application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((candidate) =>
			!candidate.webContents.getURL().includes("petOverlay=1"));
		if (!window) throw new Error("Kestrel test window is unavailable.");
		const view = window.contentView.children.find((candidate) =>
			"webContents" in candidate && candidate.getVisible() && !candidate.webContents.isDestroyed());
		// BrowserWindow.capturePage omits native child-view pixels on macOS.
		// Keep its shell capture and the actual visible page capture separately.
		return {
			shell: (await window.capturePage()).toPNG().toString("base64"),
			page: view ? (await view.webContents.capturePage()).toPNG().toString("base64") : undefined,
		};
	}), `Screenshot ${name}`, 10_000);
	const paths = {};
	for (const [surface, png] of Object.entries(captures)) {
		if (!png) continue;
		paths[surface] = join(artifactDir, `${name}-${surface}.png`);
		writeFileSync(paths[surface], Buffer.from(png, "base64"));
	}
	return paths;
}
async function nativeHandle(url) {
	return application.evaluateHandle(({ webContents }, expectedUrl) => {
		const wc = webContents.getAllWebContents().find((candidate) =>
			!candidate.isDestroyed() && candidate.getURL() === expectedUrl);
		if (!wc) throw new Error(`Fixture WebContents missing: ${expectedUrl}`);
		return wc;
	}, url);
}
async function assertCompanion(tabId, url) {
	const state = await browserState();
	const companion = state.tabs.find((tab) => tab.id === tabId);
	assert(companion && companion.url === url && !companion.crashed && !companion.error,
		"Recovery damaged the unrelated companion tab.");
}
try {
	const port = await listen(server);
	const retryPort = await listen(retryServer);
	const oneUrl = `http://127.0.0.1:${port}/one`;
	const twoUrl = `http://localhost:${port}/two`;
	const retryUrl = `http://127.0.0.1:${retryPort}/one`;
	await launch();
	const firstTabId = (await browserState()).activeTabId;
	assert(firstTabId);
	await navigate(oneUrl);
	await fixtureVisible(oneUrl);
	await request({ type: "browser-create-tab", input: twoUrl, active: true });
	const companionId = (await browserState()).activeTabId;
	assert(companionId && companionId !== firstTabId);
	const companion = await fixtureVisible(twoUrl, "Companion fixture");
	await request({ type: "browser-select-tab", tabId: firstTabId });
	const primary = await fixtureVisible(oneUrl);
	assert.notEqual(primary.pid, companion.pid, "Crash fixtures must use independent renderer processes.");
	let retired;
	await check("Renderer crash preserves tab and Reload visibly recovers", async () => {
		retired = await nativeHandle(oneUrl);
		await retired.evaluate((wc) => wc.forcefullyCrashRenderer());
		await waitFor(browserState, (state) => state.tabs.some((tab) =>
			tab.id === firstTabId && tab.crashed && !tab.loading && tab.url === oneUrl), "Crash was not recoverable");
		await page.locator(".browser-error-state").waitFor({ state: "visible" });
		const failureScreenshot = await screenshot("renderer-crash");
		await assertCompanion(companionId, twoUrl);
		await page.getByRole("button", { name: "Reload", exact: true }).click();
		const recovered = await fixtureVisible(oneUrl);
		assert.notEqual(recovered.id, primary.id);
		return { tabId: firstTabId, oldViewId: primary.id, recovered, failureScreenshot,
			screenshot: await screenshot("renderer-crash-recovered") };
	});
	await check("Stale events cannot damage the replacement view", async () => {
		const emitted = await retired.evaluate((wc) => ({
			crash: wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 99 }),
			title: wc.emit("page-title-updated", {}, "Stale retired title"),
			failure: wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://stale.invalid/", true),
		}));
		assert(Object.values(emitted).every(Boolean), "No stale listeners were exercised.");
		const recovered = await fixtureVisible(oneUrl);
		assert.equal((await browserState()).tabs.find((tab) => tab.id === firstTabId)?.title, "Recovery fixture");
		await assertCompanion(companionId, twoUrl);
		await retired.dispose();
		return { emitted, recovered };
	});
	await check("Unexpected WebContents destruction remains recoverable", async () => {
		const current = await nativeHandle(oneUrl);
		const oldViewId = await current.evaluate((wc) => wc.id);
		await current.evaluate((wc) => wc.close({ waitForBeforeUnload: false }));
		await current.dispose();
		await waitFor(browserState, (state) => state.tabs.some((tab) =>
			tab.id === firstTabId && tab.crashed && !tab.loading && tab.url === oneUrl), "Destroyed view lost its tab");
		await page.locator(".browser-error-state").waitFor({ state: "visible" });
		await assertCompanion(companionId, twoUrl);
		await page.getByRole("button", { name: "Reload", exact: true }).click();
		const recovered = await fixtureVisible(oneUrl);
		assert.notEqual(recovered.id, oldViewId);
		return { oldViewId, recovered, screenshot: await screenshot("destroyed-view-recovered") };
	});
	await check("Unavailable destination retries the intended URL", async () => {
		await closeServer(retryServer);
		await navigate(retryUrl);
		await waitFor(browserState, (state) => state.tabs.some((tab) =>
			tab.id === firstTabId && tab.url === retryUrl && tab.error && !tab.loading), "Unavailable destination did not settle");
		await page.locator(".browser-error-state").waitFor({ state: "visible" });
		const failureScreenshot = await screenshot("unavailable-destination");
		await listen(retryServer, retryPort);
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		const recovered = await fixtureVisible(retryUrl);
		await assertCompanion(companionId, twoUrl);
		return { intendedUrl: retryUrl, recovered, failureScreenshot,
			screenshot: await screenshot("unavailable-destination-recovered") };
	});
	await check("Stop settles a real slow load and later navigation works", async () => {
		const before = slowRequests;
		await navigate(`http://127.0.0.1:${port}/slow`);
		await waitFor(browserState, (state) => slowRequests > before &&
			state.tabs.some((tab) => tab.id === firstTabId && tab.loading), "Slow response did not remain loading");
		await page.getByRole("button", { name: "Stop loading", exact: true }).click();
		await waitFor(browserState, (state) => state.tabs.some((tab) =>
			tab.id === firstTabId && !tab.loading && !tab.error), "Stop left the tab loading or failed");
		await page.getByRole("button", { name: "Reload", exact: true }).waitFor();
		await navigate(oneUrl);
		const recovered = await fixtureVisible(oneUrl);
		await assertCompanion(companionId, twoUrl);
		return { slowRequestReceived: slowRequests > before, recovered,
			screenshot: await screenshot("stop-then-navigate") };
	});
	await check("Relaunch restores retained URLs from the same disposable profile", async () => {
		const before = (await browserState()).tabs.map(({ id, url }) => ({ id, url }));
		await closeApplication();
		await launch();
		const after = await browserState();
		assert.deepEqual(after.tabs.map(({ id, url }) => ({ id, url })), before);
		assert.equal(after.activeTabId, firstTabId);
		await fixtureVisible(oneUrl);
		await request({ type: "browser-select-tab", tabId: companionId });
		await fixtureVisible(twoUrl, "Companion fixture");
		await request({ type: "browser-select-tab", tabId: firstTabId });
		const recovered = await fixtureVisible(oneUrl);
		return { sameProfile: true, retainedTabs: before, recovered,
			screenshot: await screenshot("relaunch-restored") };
	});
	assert.deepEqual(runtimeErrors, [], "The Kestrel shell raised a renderer exception.");
	receipt.status = "passed";
} catch (error) {
	receipt.status = "failed";
	receipt.error = error instanceof Error ? error.stack ?? error.message : String(error);
	if (application && page) {
		try { receipt.failureScreenshot = await screenshot("failure"); } catch { /* Preserve the original failure. */ }
		try { receipt.lastBrowserState = await browserState(); } catch { /* App may already have exited. */ }
	}
	process.exitCode = 1;
} finally {
	const cleanupErrors = [];
	try { await closeApplication(); } catch (error) { cleanupErrors.push(String(error)); }
	for (const response of slowResponses) response.destroy();
	for (const target of [server, retryServer]) {
		try { await closeServer(target); } catch (error) { cleanupErrors.push(String(error)); }
	}
	try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(String(error)); }
	if (cleanupErrors.length) {
		receipt.status = "failed";
		receipt.cleanupErrors = cleanupErrors;
		process.exitCode = 1;
	}
	receipt.runtimeErrors = runtimeErrors;
	receipt.completedAt = new Date().toISOString();
	const path = join(artifactDir, "receipt.json");
	writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	log(`Browser recovery smoke ${receipt.status}; receipt: ${path}`);
	if (receipt.error) process.stderr.write(`${receipt.error}\n`);
}
