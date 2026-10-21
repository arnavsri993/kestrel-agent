import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

/**
 * Proves the product-shell lane can keep the privileged Kestrel bridge while
 * loading an MV3 fixture into the user-browser Chromium profile. This is not
 * the isolated extension workbench and must not replace /Applications/Kestrel.app.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredApp = process.env.KESTREL_NATIVE_TEST_APP?.trim();
const app = configuredApp || (await buildNativeChromiumHost());
const executable = join(app, "Contents/MacOS/Kestrel");
const executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
const fixture = join(root, "tests/fixtures/native-extension");
const requireParity = process.argv.includes("--require-extension-parity");
const normalTabModel = requireParity || process.argv.includes("--chrome-tab-model");
const evidenceRoot = join(root, normalTabModel ? ".tmp/native-chrome-tab-model-evidence" : ".tmp/native-user-extension-evidence");
const { createFileChromiumExtensionHostPort } = await tsImport(
	"../apps/desktop/src/main/file-chromium-extension-host-port.ts", import.meta.url,
);

const rejectProfile = await mkdtemp(join(tmpdir(), "kestrel-native-user-ext-reject-"));
const rejected = spawnSync(
	executable,
	[
		"--kestrel-extension-workbench",
		"--kestrel-user-extensions",
		"--kestrel-cache-path",
		rejectProfile,
	],
	{ encoding: "utf8", timeout: 10_000 },
);
await rm(rejectProfile, { recursive: true, force: true });
assert.equal(rejected.status, 1, `${rejected.stdout}${rejected.stderr}`);
assert.match(
	`${rejected.stdout}${rejected.stderr}`,
	/cannot run together/i,
);

const rejectChromeViewProfile = await mkdtemp(
	join(tmpdir(), "kestrel-native-chrome-view-reject-"),
);
const rejectedChromeView = spawnSync(
	executable,
	[
		"--kestrel-chrome-extension-view",
		"--kestrel-cache-path",
		rejectChromeViewProfile,
	],
	{ encoding: "utf8", timeout: 10_000 },
);
await rm(rejectChromeViewProfile, { recursive: true, force: true });
assert.equal(
	rejectedChromeView.status,
	1,
	`${rejectedChromeView.stdout}${rejectedChromeView.stderr}`,
);
assert.match(
	`${rejectedChromeView.stdout}${rejectedChromeView.stderr}`,
	/requires --kestrel-user-extensions/i,
);

const profile = await mkdtemp(join(tmpdir(), "kestrel-native-user-extensions-"));
const registeredFixture = join(profile, 'extension with "quotes" and spaces');
await cp(fixture, registeredFixture, { recursive: true });
// Verified CRX installs retain a manifest public key. Check that registry IDs
// match Chromium's key-derived identity as well as the unit-tested path case.
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const manifest = JSON.parse(await readFile(join(registeredFixture, "manifest.json"), "utf8"));
manifest.key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
await writeFile(join(registeredFixture, "manifest.json"), JSON.stringify(manifest));
// Register through the real host port rather than passing a fixture on every
// launch. This proves the persisted startup path, not Web Store installation.
const extensionPort = createFileChromiumExtensionHostPort({ profileRoot: profile });
const registeredExtension = await extensionPort.loadExtension(registeredFixture, { allowFileAccess: false });
let blockedRequests = 0;
const server = createServer((request, response) => {
	if (request.url?.startsWith("/kestrel-extension-blocked")) blockedRequests++;
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(
		"<!doctype html><title>Native user extension test</title><h1>User browser extension probe</h1>",
	);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address !== "string");
const probeUrl = `http://127.0.0.1:${address.port}/probe`;

let browser;
let child;
let output = "";
let extensionId;
let tabsQuerySupported = true;
let tabOwnership;
let toolbarActionPopup = false;

// Chrome action bubbles have real page targets but are not consistently
// surfaced as Playwright pages by CEF. Attach to the actual opened target;
// never navigate an ordinary tab to popup.html as substitute evidence.
async function inspectActionPopup(endpoint, url, screenshotPath) {
	const socket = new WebSocket(endpoint);
	const pending = new Map();
	let nextId = 0;
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		clearTimeout(waiter.timeout);
		if (message.error) waiter.reject(new Error(message.error.message));
		else waiter.resolve(message.result);
	});
	const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
		const id = ++nextId;
		const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 5_000);
		pending.set(id, { resolve, reject, timeout });
		socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	});
	try {
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		let target;
		for (let attempt = 0; attempt < 30; attempt++) {
			target = (await send("Target.getTargets")).targetInfos.find((target) => target.url === url && target.type === "page");
			if (target) break;
			await delay(100);
		}
		if (!target) return { observedPopupDocument: false };
		const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
		const { result } = await send("Runtime.evaluate", {
			expression: "({text:document.body.innerText,bridge:typeof window.kestrel,nativeQuery:typeof window.__kestrelNativeQuery})",
			returnByValue: true,
		}, sessionId);
		assert.match(result.value.text, /Manifest V3 running in native Chromium\./);
		assert.equal(result.value.bridge, "undefined");
		assert.equal(result.value.nativeQuery, "undefined");
		const screenshot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
		await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
		await send("Target.detachFromTarget", { sessionId });
		await send("Target.closeTarget", { targetId: target.targetId });
		return { observedPopupDocument: true, isolated: true, targetId: target.targetId };
	} finally {
		for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("Popup inspector closed")); }
		socket.close();
	}
}

// Exercise both directions of the real native tab model. A content script on
// the initial page is insufficient: extension-created tabs must stay in the
// same Chrome window and appear in Kestrel's tab rail, and Kestrel-created tabs
// must be discoverable by the extension. Do not substitute JavaScript shims.
async function probeTabOwnership(context, shellPage, sourcePage, worker) {
	const request = (payload) => shellPage.evaluate(
		(payload) => window.kestrel.request(payload), payload,
	);
	const query = () => worker.evaluate(() => chrome.tabs.query({}));
	const sourceTabs = await query();
	const source = sourceTabs.find((tab) => tab.url === sourcePage.url());
	assert(source, "The initial user page must belong to a real Chrome tab");
	const result = { sourceWindowId: source.windowId, kestrelCreated: {}, extensionCreated: [] };
	let kestrelTabId;
	const createdIds = [];
	try {
		const url = probeUrl.replace("/probe", "/kestrel-created");
		const created = await request({ type: "browser-create-tab", input: url, active: true });
		assert.equal(created.ok, true, JSON.stringify(created));
		kestrelTabId = created.browserState?.tabs.find((tab) => tab.url === url)?.id;
		assert(kestrelTabId, "Kestrel must report its newly created tab");
		let nativeTab;
		for (let attempt = 0; attempt < 30; attempt++) {
			nativeTab = (await query()).find((tab) => tab.url === url || tab.pendingUrl === url);
			if (nativeTab) break;
			await delay(100);
		}
		result.kestrelCreated = {
			visibleToExtension: Boolean(nativeTab),
			sameChromeWindow: nativeTab?.windowId === source.windowId,
		};
		await request({ type: "browser-close-tab", tabId: kestrelTabId });
		kestrelTabId = undefined;
		for (const { explicitWindow, active } of [
			{ explicitWindow: false, active: true },
			{ explicitWindow: true, active: true },
			{ explicitWindow: true, active: false },
		]) {
			const previousActive = (await query()).find((tab) => tab.active && tab.windowId === source.windowId)?.id;
			const previousState = await request({ type: "browser-get-state" });
			const url = probeUrl.replace("/probe", `/extension-created-${explicitWindow ? "explicit" : "default"}-${active ? "active" : "background"}`);
			const created = await worker.evaluate(async ({ url, windowId, active }) => {
				try {
					return { ok: true, tab: await chrome.tabs.create({ url, active, ...(windowId === undefined ? {} : { windowId }) }) };
				} catch (error) { return { ok: false, error: String(error) }; }
			}, { url, active, ...(explicitWindow ? { windowId: source.windowId } : {}) });
			if (created.tab?.id) createdIds.push(created.tab.id);
			let adopted = false;
			let activeSelectionMatches = !active;
			for (let attempt = 0; attempt < 30; attempt++) {
				const state = await request({ type: "browser-get-state" });
				const adoptedTab = state.browserState?.tabs.find((tab) => tab.url === url);
				adopted = Boolean(adoptedTab);
				activeSelectionMatches = !active || (adoptedTab && state.browserState.activeTabId === adoptedTab.id);
				if (adopted && activeSelectionMatches) break;
				await delay(100);
			}
			result.extensionCreated.push({
				explicitWindow,
				active,
				ok: created.ok,
				...(created.error ? { error: created.error } : {}),
				windowId: created.tab?.windowId,
				sameChromeWindow: created.tab?.windowId === source.windowId,
				adoptedInKestrel: adopted,
				activeSelectionMatches,
				url,
				backgroundSelectionPreserved: active || (
					(await query()).find((tab) => tab.active && tab.windowId === source.windowId)?.id === previousActive &&
					(await request({ type: "browser-get-state" })).browserState?.activeTabId === previousState.browserState?.activeTabId),
			});
			const updatedUrl = `${url}?updated=1`;
			if (created.tab?.id) {
				await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: created.tab.id, url: updatedUrl });
				let updated = false;
				for (let attempt = 0; attempt < 30; attempt++) {
					updated = (await request({ type: "browser-get-state" })).browserState?.tabs.some((tab) => tab.url === updatedUrl) ?? false;
					if (updated) break;
					await delay(100);
				}
				result.extensionCreated.at(-1).updatedInKestrel = updated;
			}
		}
	} finally {
		if (kestrelTabId) await request({ type: "browser-close-tab", tabId: kestrelTabId });
		for (const id of createdIds) await worker.evaluate((id) => chrome.tabs.remove(id), id);
	}
	for (let attempt = 0; attempt < 30; attempt++) {
		const state = await request({ type: "browser-get-state" });
		for (const tab of result.extensionCreated) {
			tab.removedFromKestrel = !state.browserState.tabs.some((item) => item.url === tab.url || item.url === `${tab.url}?updated=1`);
		}
		if (result.extensionCreated.every((tab) => tab.removedFromKestrel)) break;
		await delay(100);
	}
	result.passed = result.kestrelCreated.visibleToExtension && result.kestrelCreated.sameChromeWindow &&
		result.extensionCreated.every((tab) => tab.ok && tab.sameChromeWindow && tab.adoptedInKestrel && tab.activeSelectionMatches && tab.backgroundSelectionPreserved && tab.updatedInKestrel && tab.removedFromKestrel);
	return result;
}
try {
	for (let launch = 0; launch < 2; launch++) {
		// Both processes load only the registration written by the actual host port.
		output = "";
		await rm(join(profile, "DevToolsActivePort"), { force: true });
		child = spawn(
			executable,
			[
				"--kestrel-cache-path",
				profile,
				"--kestrel-user-extensions",
				...(normalTabModel ? ["--kestrel-chrome-tab-model"] : ["--kestrel-chrome-extension-view"]),
				"--kestrel-ephemeral-core",
				"--kestrel-renderer",
				"--kestrel-durable-profile",
				"--remote-debugging-port=0",
				"--kestrel-smoke-user-browser-url",
				probeUrl,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const exited = new Promise((resolveExit) =>
			child.once("exit", (code, signal) => resolveExit({ code, signal })),
		);

		let endpoint;
		for (let attempt = 0; attempt < 200; attempt++) {
			assert.equal(child.exitCode, null, output);
			const listening = output.match(
				/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/i,
			);
			if (listening) {
				endpoint = listening[1];
				break;
			}
			try {
				const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8"))
					.trim()
					.split("\n");
				if (port && path) {
					endpoint = `ws://127.0.0.1:${port}${path}`;
					break;
				}
			} catch {
				// DevTools port file can lag startup markers briefly.
			}
			await delay(100);
		}
		assert(endpoint, `Missing DevTools endpoint after user-extension shell start: ${output}`);

		for (let attempt = 0; attempt < 150; attempt++) {
			if (
				output.includes("KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED") &&
				output.includes("KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY") &&
				output.includes("KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK")
			) {
				break;
			}
			assert.equal(child.exitCode, null, output);
			await delay(100);
		}
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED/, output);
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_EXTENSION_PATHS count=1/, output);
		if (normalTabModel) {
			assert.match(output, /KESTREL_NATIVE_CHROMIUM_NORMAL_TAB_MODEL_READY/, output);
		} else {
			assert.match(output, /KESTREL_NATIVE_CHROMIUM_EXTENSION_WINDOW_STYLE chrome/, output);
			assert.match(output, /KESTREL_NATIVE_CHROMIUM_EXTENSION_VIEW_STYLE chrome/, output);
		}
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_EXTENSION_SAME_WINDOW_OK/, output);
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY/, output);
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK/, output);

		browser = await chromium.connectOverCDP(endpoint);
		const context = browser.contexts()[0];
		assert(context, "Expected a CDP browser context");

		let shellPage;
		let userPage;
		for (let attempt = 0; attempt < 80; attempt++) {
			const pages = context.pages();
			for (const page of pages) {
				const url = page.url();
				if (!shellPage && (url.includes("kestrel-shell/index.html") || url.startsWith("kestrel://")))
					shellPage = page;
				if (!userPage && url.includes("/probe")) userPage = page;
			}
			if (shellPage && userPage) break;
			await delay(100);
		}
		assert(shellPage, `Privileged shell page missing: ${output}`);
		assert(userPage, `User browser probe page missing: ${output}`);

		assert.equal(await shellPage.evaluate(() => typeof window.kestrel), "object");
		await shellPage.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
		// This disposable fixture exercises normal browser layout, not onboarding.
		// No real profile, model credential, or provider sign-in is involved.
		await shellPage.evaluate(() => {
			localStorage.setItem("kestrel:onboarded", "yes");
			localStorage.setItem("kestrel:default-browser-prompted", "yes");
		});
		await shellPage.reload();
		await shellPage.locator(".ai-browser-app").waitFor();
		for (let attempt = 0; attempt < 150 && !output.includes("KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK"); attempt++) {
			assert.equal(child.exitCode, null, output);
			await delay(100);
		}
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK/, "The real renderer must receive a Core snapshot.");
		assert.equal(
			await shellPage.evaluate(() => document.documentElement.dataset.kestrelExtensionProbe || ""),
			"",
			"Privileged shell must not receive extension content scripts",
		);

		await userPage.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
		const first = await userPage.evaluate(() =>
			JSON.parse(document.documentElement.dataset.kestrelExtensionProbe),
		);
		assert.equal(first.manifest, 3);
		assert.equal(first.runs, launch === 0 ? 1 : 3, JSON.stringify(first));
		assert.match(first.id, /^[a-p]{32}$/);
		assert.equal(first.id, registeredExtension.id, "The host registry must identify Chromium's actual extension");
		if (launch === 0) extensionId = first.id;
		else assert.equal(first.id, extensionId, "Extension identity must survive restart");
		assert.equal(first.tab.url, first.tab.senderUrl, "chrome.tabs.get must return the actual user page");
		assert.equal(
			first.tabFound,
			true,
			"The Chrome-style user view must be visible to chrome.tabs.query in the Kestrel window",
		);
		tabsQuerySupported &&= first.tabFound;
		assert.deepEqual(first.scripting, { bridge: "undefined", nativeQuery: "undefined" });
		assert.equal(await userPage.evaluate(() => document.documentElement.dataset.kestrelExtensionScriptInjected), "true");
		assert.equal(await userPage.evaluate(() => typeof window.kestrel), "undefined");
		assert.equal(await userPage.evaluate(async () => {
			try { await fetch("/kestrel-extension-blocked"); return false; }
			catch { return true; }
		}), true, "DNR must block the request, not merely accept a rule");
		assert.equal(blockedRequests, 0, "A blocked request must never reach the server");
		assert.equal(await userPage.evaluate(async () => (await fetch("/kestrel-extension-allowed")).ok), true);

		if (launch === 0) {
			await userPage.reload();
			await userPage.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
			assert.equal(
				await userPage.evaluate(
					() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe).runs,
				),
				2,
			);
		}

		const evidence = evidenceRoot;
		await mkdir(evidence, { recursive: true });
		await shellPage.screenshot({ path: join(evidence, `privileged-shell-${launch}.png`) });
		// React's actual browser layout owns the visible native content bounds.
		const viewport = await shellPage.locator("#browser-viewport").boundingBox();
		assert(viewport && viewport.width > 0 && viewport.height > 0);
		await userPage.waitForFunction(({ width, height, nativeToolbar }) =>
			Math.abs(innerWidth - width) <= 2 && (nativeToolbar ?
				innerHeight > 0 && innerHeight < height && height - innerHeight < 150 :
				Math.abs(innerHeight - height) <= 2),
			{ width: Math.round(viewport.width), height: Math.round(viewport.height), nativeToolbar: normalTabModel });
		await userPage.screenshot({ path: join(evidence, `user-browser-extension-${launch}.png`) });
		const osWindow = output.match(/KESTREL_NATIVE_CHROMIUM_EXTENSION_OS_WINDOW (\d+)/);
		assert(osWindow, `Missing native Kestrel window number: ${output}`);
		const capture = spawnSync("/usr/sbin/screencapture", [
			"-x", "-l", osWindow[1], join(evidence, `kestrel-window-${launch}.png`),
		], { encoding: "utf8", timeout: 10_000 });
		assert.equal(capture.status, 0, `Native window capture failed: ${capture.stderr}`);
		if (normalTabModel && launch === 0) {
			const pageSession = await context.newCDPSession(userPage);
			const windowSession = await browser.newBrowserCDPSession();
			try {
				const { targetInfo } = await pageSession.send("Target.getTargetInfo");
				const { windowId, bounds } = await windowSession.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
				for (const size of [{ width: 1000, height: 760 }, { width: bounds.width, height: bounds.height }]) {
					await windowSession.send("Browser.setWindowBounds", { windowId, bounds: size });
					await shellPage.waitForFunction((width) => Math.abs(innerWidth - width) <= 2, size.width);
					let fitted = false;
					for (let attempt = 0; attempt < 60; attempt++) {
						const region = await shellPage.locator("#browser-viewport").boundingBox();
						const actual = await userPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
						fitted = region && Math.abs(region.width - actual.width) <= 2 && actual.height > 0 && actual.height < region.height;
						if (fitted) break;
						await delay(100);
					}
					assert(fitted, "Native Chrome controls and content must follow React bounds after window resize");
					const resized = spawnSync("/usr/sbin/screencapture", ["-x", "-l", osWindow[1], join(evidence, `kestrel-resized-${size.width}.png`)], { timeout: 10_000 });
					assert.equal(resized.status, 0);
				}
			} finally {
				await pageSession.detach();
				await windowSession.detach();
			}
		}
		if (launch === 1 && normalTabModel) {
			const worker = context.serviceWorkers().find((entry) =>
				entry.url().startsWith(`chrome-extension://${extensionId}/`));
			assert(worker, "Expected the fixture's real MV3 service worker");
			tabOwnership = await probeTabOwnership(context, shellPage, userPage, worker);
			if (normalTabModel) {
				assert.equal(tabOwnership.passed, true, JSON.stringify(tabOwnership));
				const action = await worker.evaluate(async () => {
					try {
						const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
						await chrome.action.openPopup({ windowId: tab.windowId });
						return { ok: true };
					}
					catch (error) { return { ok: false, error: String(error) }; }
				});
				const popup = action.ok ? await inspectActionPopup(endpoint,
                    `chrome-extension://${extensionId}/popup.html`,
                    join(evidence, "native-action-popup.png")) : { observedPopupDocument: false };
                toolbarActionPopup = popup.observedPopupDocument;
                await writeFile(join(evidence, "action-popup.json"), JSON.stringify({ ...action, ...popup }, null, 2) + "\n");
				// Closing the last web tab through Kestrel must leave its Home and
				// privileged shell alive, rather than closing Chrome's native window.
				const beforeClose = await shellPage.evaluate(() => window.kestrel.request({ type: "browser-get-state" }));
				for (const tab of beforeClose.browserState.tabs) {
					const closed = await shellPage.evaluate((tabId) => window.kestrel.request({ type: "browser-close-tab", tabId }), tab.id);
					assert.equal(closed.ok, true, JSON.stringify(closed));
				}
				await shellPage.waitForFunction(async () => {
					const state = await window.kestrel.request({ type: "browser-get-state" });
					return state.ok && state.browserState.tabs.length === 1 && state.browserState.tabs[0].url === "";
				});
				assert.equal(child.exitCode, null, "Last-tab close must preserve Kestrel Home");
			}
			await writeFile(join(evidence, "tab-ownership.json"), JSON.stringify(tabOwnership, null, 2) + "\n");
		}

		const session = await browser.newBrowserCDPSession();
		await session.send("Browser.close");
		const result = await Promise.race([
			exited,
			delay(15_000, undefined, { ref: false }).then(() => {
				throw new Error(`Native user-extension shell shutdown timed out: ${output}`);
			}),
		]);
		assert.deepEqual(result, { code: 0, signal: null }, output);
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED/);
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY/);
		assert.doesNotMatch(output, /Electron Framework/);
		await browser.close().catch(() => {});
		browser = undefined;
		child = undefined;
	}
	console.log(
		"Native user extension checks passed: same-window Chrome-style user view with Alloy Kestrel shell, real renderer/Core, MV3 messaging, tabs.get/tabs.query, scripting, actual DNR blocking, bridge isolation, extension identity/storage after a full app restart without reloading the extension, and clean shutdown.",
	);
	const checks = {
		realKestrelRendererAndCore: true,
		mv3ContentScriptsAndWorkerMessaging: true,
		storageAndIdentityAfterAppRestart: true,
		persistedHostPortStartupRegistration: true,
		tabsGet: true,
		scripting: true,
		declarativeNetRequestActuallyBlocks: true,
		privilegedShellIsolation: true,
		sameKestrelWindow: true,
		userViewFitsReactBrowserViewport: true,
		tabsQuery: tabsQuerySupported,
		allKestrelTabsHaveChromeOwnership: tabOwnership?.passed === true,
		kestrelExtensionManagerInstallAndLiveToggle: false,
		toolbarActionPopups: toolbarActionPopup,
		chromeWebStoreInstall: false,
		chromeWebStoreUpdates: false,
	};
	const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
	const evidence = evidenceRoot;
	assert.equal(createHash("sha256").update(await readFile(executable)).digest("hex"), executableSha256,
		"The native app candidate changed while its extension checks were running");
	await writeFile(join(evidence, "compatibility.json"), JSON.stringify({
		version: 1,
		app: resolve(app),
		executableSha256,
		checkedAt: new Date().toISOString(),
		normalTabModel,
		checks,
		missing,
		fullExtensionParity: missing.length === 0,
	}, null, 2) + "\n");
	console.log(`Native extension parity ${missing.length === 0 ? "passed" : "BLOCKED"}: ${missing.join(", ") || "all checks passed"}.`);
	if (requireParity) assert.deepEqual(missing, [], "Electron retirement requires complete Chrome extension acceptance; fixture success alone is insufficient.");
} catch (error) {
	console.error(output);
	throw error;
} finally {
	await browser?.close().catch(() => {});
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await new Promise((resolveKill) => child.once("exit", resolveKill));
	}
	await new Promise((resolveClose) => server.close(resolveClose));
	await rm(profile, { recursive: true, force: true });
}
