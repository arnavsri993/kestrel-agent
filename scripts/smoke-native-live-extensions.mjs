import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import {
	assertNativeBrowserFixtureStopped,
	captureNativeBrowserFixtureStorage,
	nativeBrowserFixtureStorageArgs,
	nativeBrowserFixtureStorageEnv,
	prepareNativeBrowserFixtureProfile,
	selectNativeBrowserFixtureStorage,
	waitForNativeBrowserFixtureStopped,
} from "./native-browser-fixture-storage.mjs";

// Explicit candidate selection prevents this integration check from racing a
// native build or touching the canonical app/profile. The TCP CDP endpoint is
// inspection-only; product operations use the real renderer request boundary.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(process.env.KESTREL_NATIVE_TEST_APP?.trim(), "Set KESTREL_NATIVE_TEST_APP to the completed candidate Kestrel.app");
const storage = await selectNativeBrowserFixtureStorage({
	candidate: resolve(process.env.KESTREL_NATIVE_TEST_APP.trim()),
	root,
});
const app = storage.candidate;
const formatterOnly = process.env.KESTREL_TEST_STORE_FORMATTER_ONLY === "1";
assert.equal(storage.mode, process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT === "1" ? "production-vault" : "test-key");
const candidateSha256 = storage.candidateSha256;
const executable = join(app, "Contents/MacOS/Kestrel");
const id = "bcjindcccaagfpapjjmafapmmgkkhgoa";
const listingUrl = `https://chromewebstore.google.com/detail/json-formatter/${id}`;
const configuredEvidence = process.env.KESTREL_NATIVE_LIVE_EXTENSION_EVIDENCE?.trim();
const evidence = resolve(configuredEvidence || join(root, ".tmp/native-live-extension-evidence"));
await mkdir(evidence, { recursive: true, mode: 0o700 });
const evidenceInfo = await lstat(evidence);
assert(evidenceInfo.isDirectory() && !evidenceInfo.isSymbolicLink() && evidenceInfo.uid === process.getuid() &&
	(evidenceInfo.mode & 0o777) === 0o700 && await realpath(evidence) === evidence,
	"Live extension evidence directory must be owned, private, and canonical.");
if (configuredEvidence) {
	assert.equal((await readdir(evidence)).length, 0, "Configured live extension evidence directory must be fresh and empty.");
}
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-chromium-desktop-canary-live-extensions-")));
await prepareNativeBrowserFixtureProfile({ profile, storage });
let preserveProfile = false;
const sentinel = randomUUID();
const report = {
	app, executableSha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
	candidateSha256, candidateSha256After: null, fixtureStorageMode: storage.mode,
	storageInitialization: null,
	extensionId: id, requests: [], launches: [], checks: {}, startedAt: new Date().toISOString(),
	workerCoverage: formatterOnly
		? { status: "skipped", reason: "KESTREL_TEST_STORE_FORMATTER_ONLY=1; Google Translate worker canary was not installed." }
		: { status: "pending", extension: "Google Translate" },
};
if (storage.mode === "production-vault") {
	// Initialize the native local vault while the generated profile is empty.
	// Store-managed extension state is added only after this sealed first launch.
	let initializer;
	let initializerBrowser;
	let initializerOutput = "";
	let initialized = false;
	const args = [
		"--kestrel-cache-path", profile,
		"--kestrel-user-extensions", "--kestrel-chrome-tab-model",
		"--kestrel-ephemeral-core", "--kestrel-renderer", "--kestrel-durable-profile",
		"--enable-automation", "--remote-debugging-port=0",
	];
	args.push(...nativeBrowserFixtureStorageArgs(storage));
	assert(!args.some((arg) => /test-profile-key|mock-keychain|real-keychain/i.test(arg)));
	assertNativeBrowserFixtureStopped(storage);
	assert.equal(await candidateDigest(app), candidateSha256, "Selected native candidate changed before profile initialization.");
	initializer = spawn(executable, args, {
		stdio: ["ignore", "pipe", "pipe"], env: nativeBrowserFixtureStorageEnv(storage),
	});
	initializer.stdout.setEncoding("utf8");
	initializer.stderr.setEncoding("utf8");
	for (const stream of [initializer.stdout, initializer.stderr]) stream.on("data", (chunk) => { initializerOutput += chunk; });
	const exited = new Promise((resolveExit) => initializer.once("exit", (code, signal) => resolveExit({ code, signal })));
	try {
		let endpoint;
		for (let attempt = 0; attempt < 600; attempt++) {
			assert.equal(initializer.exitCode, null, initializerOutput);
			endpoint = initializerOutput.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/i)?.[1];
			if (!endpoint) {
				try {
					const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
					if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
				} catch {}
			}
			if (endpoint) break;
			await delay(100);
		}
		assert(endpoint, `Production-vault profile initialization had no DevTools endpoint: ${initializerOutput}`);
		for (let attempt = 0; attempt < 600 && !initializerOutput.includes("KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY"); attempt++) {
			assert.equal(initializer.exitCode, null, initializerOutput);
			await delay(100);
		}
		assert.match(initializerOutput, /KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY/, initializerOutput);
		initializerBrowser = await chromium.connectOverCDP(endpoint);
		const session = await initializerBrowser.newBrowserCDPSession();
		try {
			const { arguments: effective } = await session.send("Browser.getBrowserCommandLine");
			assert(Array.isArray(effective) && effective.includes("--kestrel-durable-profile"));
			assert(!effective.some((arg) => /^--(?:use-mock-keychain|kestrel-real-keychain|kestrel-test-profile-key)(?:=|$)/.test(arg)));
			await session.send("Browser.close");
		} finally { await session.detach().catch(() => {}); }
		const outcome = await Promise.race([exited, delay(15_000).then(() => null)]);
		assert(outcome, "Production-vault profile initializer did not stop.");
		assert.deepEqual(outcome, { code: 0, signal: null }, initializerOutput);
		await initializerBrowser.close().catch(() => {});
		initializerBrowser = undefined;
		await waitForNativeBrowserFixtureStopped(storage);
		report.storageInitialization = await captureNativeBrowserFixtureStorage({ profile, storage });
		initialized = true;
	} finally {
		await initializerBrowser?.close().catch(() => {});
		if (initializer && initializer.exitCode === null && initializer.signalCode === null) {
			initializer.kill("SIGKILL");
			await Promise.race([exited, delay(15_000)]);
		}
		if (!initialized) {
			try { await waitForNativeBrowserFixtureStopped(storage); }
			catch (error) {
				preserveProfile = true;
				process.stderr.write(`Retained generated profile because initializer shutdown is unconfirmed: ${profile}\n${String(error)}\n`);
			}
		}
	}
}
const server = createServer((request, response) => {
	if (request.url?.startsWith("/probe.json")) {
		response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
		response.end(JSON.stringify({ kestrelLiveExtension: sentinel, nested: { native: true }, items: [1, 2, 3] }));
	} else {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<!doctype html><title>Kestrel live extension smoke</title><h1>Native extension lifecycle</h1>");
	}
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const jsonUrl = `${base}/probe.json`;
let child, browser, context, shell, shellSocket, output = "", launch = 0;
const deadline = Date.now() + 240_000;

async function until(check, description, timeout = 30_000) {
	const end = Math.min(deadline, Date.now() + timeout);
	let last;
	while (Date.now() < end) {
		if (child && child.exitCode !== null) throw new Error(`Native host exited (${child.exitCode}): ${output.slice(-5000)}`);
		try { const value = await check(); if (value) return value; } catch (error) { last = error; }
		await delay(100);
	}
	throw new Error(`Timed out: ${description}${last ? `: ${last.message}` : ""}`);
}

async function request(payload, requireSuccess = true) {
	let timer;
	let response;
	try {
		response = await Promise.race([
			shell.evaluate((value) => window.kestrel.request(value), payload),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Renderer request timed out: ${payload.type}`)), 45_000); }),
		]);
	} finally { clearTimeout(timer); }
	report.requests.push({ request: payload, response });
	if (requireSuccess) assert.equal(response.ok, true, `${payload.type}: ${JSON.stringify(response)}`);
	return response;
}

async function attachShell(endpoint) {
	// CEF's isolated privileged profile is a separate browserContextId. Chrome
	// enumerates it, but Playwright's auto-attach can omit that profile entirely.
	// Attach to the real target explicitly; never move the shell into the user
	// profile just to make an inspection client discover it.
	shellSocket = new WebSocket(endpoint);
	await new Promise((done, reject) => {
		shellSocket.addEventListener("open", done, { once: true });
		shellSocket.addEventListener("error", reject, { once: true });
	});
	const socket = shellSocket;
	let nextId = 0;
	const pending = new Map();
	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(String(data));
		const call = pending.get(message.id);
		if (!call) return;
		pending.delete(message.id); clearTimeout(call.timer);
		if (message.error) call.reject(new Error(message.error.message));
		else call.resolve(message.result);
	});
	socket.addEventListener("close", () => {
		for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Shell inspection closed")); }
		pending.clear();
	});
	function send(method, params = {}, sessionId) {
		return new Promise((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Shell inspection timed out: ${method}`)); }, 20_000);
			pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
	const target = await until(async () => {
		const { targetInfos } = await send("Target.getTargets", { filter: [{}] });
		return targetInfos.find((target) => target.type === "page" && target.url === "kestrel://app/index.html");
	}, "isolated real Kestrel shell target");
	const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
	async function evaluate(fn, argument) {
		const response = await send("Runtime.evaluate", {
			expression: `(${String(fn)})(${JSON.stringify(argument) ?? "undefined"})`,
			awaitPromise: true, returnByValue: true,
		}, sessionId);
		if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
		return response.result.value;
	}
	return {
		evaluate,
		send,
		waitForFunction: (fn) => until(() => evaluate(fn), "shell document readiness"),
		reload: () => send("Page.reload", {}, sessionId),
		locator: (selector) => ({ waitFor: () => until(() => evaluate((selector) => !!document.querySelector(selector), selector), "rendered shell") }),
		screenshot: async ({ path }) => {
			const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
			await writeFile(path, Buffer.from(data, "base64"));
		},
	};
}

async function captureWindow(label) {
	const windowNumber = output.match(/KESTREL_NATIVE_CHROMIUM_EXTENSION_OS_WINDOW (\d+)/)?.[1];
	assert(windowNumber, "The real Kestrel window must be identified before capture");
	const capture = spawnSync("/usr/sbin/screencapture", ["-x", "-l", windowNumber, join(evidence, `${label}-window.png`)], { timeout: 10_000, encoding: "utf8" });
	assert.equal(capture.status, 0, capture.stderr);
}

async function showStore() {
	const state = await request({ type: "browser-get-state" });
	await request({ type: "browser-navigate", tabId: state.browserState.activeTabId, input: listingUrl });
	await shell.locator(".chrome-web-store-install-bar").waitFor();
}

async function clickShell(selector) {
	assert.equal(await shell.evaluate((selector) => {
		const button = document.querySelector(selector);
		if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
		button.focus();
		button.click(); return true;
	}, selector), true, `Expected an enabled real control: ${selector}`);
}

async function start() {
	launch++;
	output = "";
	assertNativeBrowserFixtureStopped(storage);
	assert.equal(await candidateDigest(app), candidateSha256, "Selected native candidate changed before launch.");
	await rm(join(profile, "DevToolsActivePort"), { force: true });
	const storageArgs = nativeBrowserFixtureStorageArgs(storage);
	if (storage.mode === "production-vault") assert(!storageArgs.some((arg) => /test-profile-key|mock-keychain|real-keychain/i.test(arg)));
	child = spawn(executable, [
		"--kestrel-cache-path", profile, "--kestrel-live-extensions",
		"--kestrel-user-extensions", "--kestrel-chrome-tab-model",
		"--kestrel-ephemeral-core", "--kestrel-renderer", "--kestrel-durable-profile", ...storageArgs,
		"--remote-debugging-port=0", "--kestrel-smoke-user-browser-url", `${base}/`,
	], { stdio: ["ignore", "pipe", "pipe"], env: nativeBrowserFixtureStorageEnv(storage) });
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
		// Keep diagnostics bounded even if a renderer emits repeated messages.
		output = (output + chunk).slice(-2_000_000);
	});
	const endpoint = await until(async () => {
		const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\da-f-]+)/i);
		if (match) return match[1];
		try {
			const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
			return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
		} catch { return undefined; }
	}, "inspection endpoint", 45_000);
	browser = await chromium.connectOverCDP(endpoint);
	context = browser.contexts()[0];
	shell = await attachShell(endpoint);
	await shell.waitForFunction(() => typeof window.kestrel?.request === "function", null, { timeout: 30_000 });
	await shell.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await shell.reload();
	await shell.locator(".ai-browser-app").waitFor({ timeout: 30_000 });
	report.launches.push({ launch, pid: child.pid, endpoint });
}

async function stop() {
	if (child?.exitCode === null) {
		try { await (await browser.newBrowserCDPSession()).send("Browser.close"); }
		catch { child.kill("SIGTERM"); }
		for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) await delay(100);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	if (launch) await writeFile(join(evidence, `launch-${launch}.log`), output);
	await browser?.close().catch(() => {});
	shellSocket?.close(); shellSocket = undefined;
	browser = context = shell = undefined;
	child = undefined;
	if (launch) await waitForNativeBrowserFixtureStopped(storage);
}

async function userPage(url) {
	return until(() => browser.contexts().flatMap((candidate) => candidate.pages()).find((page) => page.url() === url), `actual user page ${url}`);
}

async function navigate(url) {
	const state = await request({ type: "browser-get-state" });
	await request({ type: "browser-navigate", tabId: state.browserState.activeTabId, input: url });
	return userPage(url);
}

async function formatted(expected, label) {
	const page = await navigate(`${jsonUrl}?step=${label}`);
	if (expected) {
		await page.waitForFunction((token) => !!document.getElementById("jsonFormatterRaw") && window.json?.kestrelLiveExtension === token, sentinel, { timeout: 15_000 });
	} else {
		await page.waitForLoadState("load");
		await delay(700);
		assert.equal(await page.evaluate(() => !!document.getElementById("jsonFormatterRaw")), false, "Disabled extension must not format JSON");
	}
	report.checks[label] = await page.evaluate(() => ({
		url: location.href, formatted: !!document.getElementById("jsonFormatterRaw"),
		parsedProbe: window.json?.kestrelLiveExtension ?? null,
		bridge: typeof window.kestrel, nativeQuery: typeof window.__kestrelNativeQuery,
	}));
	assert.equal(report.checks[label].bridge, "undefined");
	assert.equal(report.checks[label].nativeQuery, "undefined");
	await page.screenshot({ path: join(evidence, `${label}.png`) });
}

async function optionsPage() {
	const manifest = JSON.parse(await readFile(join(profile, "browser-extensions", id, "manifest.json"), "utf8"));
	const path = manifest.options_ui?.page ?? manifest.options_page;
	assert.equal(typeof path, "string", "Store package must expose its actual options page for storage inspection");
	assert(!path.startsWith("/") && !path.includes(".."), "Options path must stay inside the verified package");
	return navigate(`chrome-extension://${id}/${path}`);
}

function checkRuntime(extension) {
	assert.equal(extension.id, id);
	assert.equal(extension.enabled, true);
	assert.equal(extension.source, "chrome_web_store");
	assert.equal(extension.compatibility?.runtime.registered, "passed");
	assert.equal(extension.compatibility?.runtime.remainedLoaded, "passed");
	// This extension has no background worker. Do not turn that into fake worker
	// readiness evidence; its actual content script behavior is checked above.
	assert.notEqual(extension.compatibility?.runtime.ready, "failed");
}

try {
	await start();
	assert.deepEqual((await request({ type: "browser-list-extensions" })).extensions, []);
	for (const payload of [
		{ type: "browser-install-extension-url", inspectionId: randomUUID(), path: "/tmp/untrusted-extension" },
		{ type: "browser-inspect-extension-url", urlOrId: id, path: "/tmp/untrusted-extension" },
		{ type: "browser-toggle-extension", extensionId: "../../escape", enabled: true },
	]) assert.equal((await request(payload, false)).ok, false, "Unsafe fields and paths must be rejected");
	const inspected = await request({ type: "browser-inspect-extension-url", urlOrId: id });
	report.inspection = inspected.extensionInspection;
	assert.equal(report.inspection.id, id);
	assert.match(report.inspection.inspectionId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
	await showStore();
	await clickShell(".chrome-web-store-install-actions button");
	await shell.locator(".extension-compatibility-dialog").waitFor();
	await until(() => shell.evaluate(() => !!document.querySelector(".extension-compatibility-dialog")?.contains(document.activeElement)), "review dialog keyboard focus");
	report.review = await shell.evaluate(() => ({
		text: document.querySelector(".extension-compatibility-dialog")?.textContent,
		focusInside: !!document.querySelector(".extension-compatibility-dialog")?.contains(document.activeElement),
		buttonColor: getComputedStyle(document.querySelector(".extension-compatibility-primary")).color,
		buttonBackground: getComputedStyle(document.querySelector(".extension-compatibility-primary")).backgroundColor,
	}));
	assert.match(report.review.text, /JSON Formatter/);
	assert.match(report.review.text, /Declared access/);
	assert.equal(report.review.focusInside, true);
	assert.notEqual(report.review.buttonColor, report.review.buttonBackground, "The primary review action must have readable text");
	await captureWindow("store-review");
	await clickShell(".extension-compatibility-primary");
	const installedRecord = await until(async () => {
		const listed = await shell.evaluate(() => window.kestrel.request({ type: "browser-list-extensions" }));
		return listed.extensions?.find((extension) => extension.id === id && extension.enabled);
	}, "reviewed Store installation through the visible controls");
	const installed = { ok: true, extension: installedRecord };
	await until(() => shell.evaluate(() => !document.querySelector(".extension-compatibility-dialog")), "extension review closes after installation");
	checkRuntime(installed.extension);
	report.installed = installed.extension;
	const manifest = JSON.parse(await readFile(join(profile, "browser-extensions", id, "manifest.json"), "utf8"));
	report.package = { name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version, contentScripts: manifest.content_scripts, options: manifest.options_ui };
	assert.equal(manifest.name, "JSON Formatter");
	await showStore();
	await until(() => shell.evaluate(() => document.querySelector(".chrome-web-store-install-actions button")?.textContent?.includes("Check updates")), "installed extension update control");
	await clickShell(".chrome-web-store-install-actions button");
	await shell.locator(".extension-compatibility-dialog").waitFor();
	report.updateReview = await shell.evaluate(() => ({
		text: document.querySelector(".extension-compatibility-dialog")?.textContent,
		canInstall: !!document.querySelector(".extension-compatibility-primary"),
	}));
	assert.match(report.updateReview.text, /Extension is up to date/);
	assert.equal(report.updateReview.canInstall, false);
	await captureWindow("store-update-review");
	await clickShell(".extension-compatibility-secondary");
	await until(() => shell.evaluate(() => !document.querySelector(".extension-compatibility-dialog")), "up-to-date review closes");
	await formatted(true, "installed");
	let options = await optionsPage();
	await options.evaluate((token) => chrome.storage.local.set({ kestrelLiveSmoke: token }), sentinel);
	assert.equal(await options.evaluate(async () => (await chrome.storage.local.get("kestrelLiveSmoke")).kestrelLiveSmoke), sentinel);
	assert.equal((await request({ type: "browser-toggle-extension", extensionId: id, enabled: false })).extension.enabled, false);
	await formatted(false, "disabled");
	assert.equal((await request({ type: "browser-reload-extension", extensionId: id }, false)).ok, false, "Disabled extension reload must fail");
	checkRuntime((await request({ type: "browser-toggle-extension", extensionId: id, enabled: true })).extension);
	await formatted(true, "reenabled");
	options = await optionsPage();
	assert.equal(await options.evaluate(async () => (await chrome.storage.local.get("kestrelLiveSmoke")).kestrelLiveSmoke), sentinel, "Disable/re-enable must preserve storage");
	checkRuntime((await request({ type: "browser-reload-extension", extensionId: id })).extension);
	await formatted(true, "reloaded");
	await shell.screenshot({ path: join(evidence, "shell-before-restart.png") });
	await stop();
	await start();
	const restored = (await request({ type: "browser-list-extensions" })).extensions.find((extension) => extension.id === id);
	checkRuntime(restored);
	assert.equal(restored.version, installed.extension.version);
	report.restored = restored;
	await formatted(true, "restored");
	await captureWindow("restored-extension");
	options = await optionsPage();
	assert.equal(await options.evaluate(async () => (await chrome.storage.local.get("kestrelLiveSmoke")).kestrelLiveSmoke), sentinel, "Restart must preserve extension storage");
	report.checks.storageSurvivedToggleReloadRestart = true;
	await navigate(`${base}/`);
	await request({ type: "browser-uninstall-extension", extensionId: id });
	assert.deepEqual((await request({ type: "browser-list-extensions" })).extensions, []);
	await formatted(false, "uninstalled");
	await shell.screenshot({ path: join(evidence, "shell-after-uninstall.png") });
	// The worker canary is retained for the default mode. Formatter-only runs
	// isolate Store lifecycle acceptance from a second Store package install.
	if (!formatterOnly) {
		const workerId = "aapbdbdomjkkjkaonfhkkikfgjllcleb";
		const workerReview = await request({ type: "browser-inspect-extension-url", urlOrId: workerId });
		assert.equal(workerReview.extensionInspection.compatibility.manifest.background, "service_worker");
		const workerInstall = await request({ type: "browser-install-extension-url", inspectionId: workerReview.extensionInspection.inspectionId });
		assert.equal(workerInstall.extension.compatibility.runtime.backgroundServiceWorker, "passed");
		const { targetInfos } = await shell.send("Target.getTargets", { filter: [{}] });
		const workerTarget = targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${workerId}/`));
		assert(workerTarget, "The installed extension must have a real worker target");
		const { sessionId: workerSession } = await shell.send("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: true });
		try {
			const workerReply = await shell.send("Runtime.evaluate", {
				expression: "({id:chrome.runtime.id,bridge:typeof globalThis.kestrel,nativeQuery:typeof globalThis.__kestrelNativeQuery})", returnByValue: true,
			}, workerSession);
			assert(!workerReply.exceptionDetails);
			report.checks.officialMv3Worker = workerReply.result.value;
			assert.deepEqual(report.checks.officialMv3Worker, { id: workerId, bridge: "undefined", nativeQuery: "undefined" });
		} finally { await shell.send("Target.detachFromTarget", { sessionId: workerSession }); }
		await request({ type: "browser-uninstall-extension", extensionId: workerId });
		report.workerCoverage = { status: "passed", extension: "Google Translate", id: workerId, ...report.checks.officialMv3Worker };
	}
	report.ok = true;
} catch (error) {
	if (browser) try {
		const diagnostics = await browser.newBrowserCDPSession();
		report.targetsAtFailure = await diagnostics.send("Target.getTargets", { filter: [{}] });
		await diagnostics.detach();
	} catch {}
	report.ok = false;
	report.error = error.stack ?? String(error);
	process.exitCode = 1;
} finally {
	await stop();
	await new Promise((done) => server.close(done));
	if (!preserveProfile) await rm(profile, { recursive: true, force: true });
	report.finishedAt = new Date().toISOString();
	try { report.candidateSha256After = await candidateDigest(app); }
	catch (error) {
		report.ok = false;
		process.exitCode = 1;
		report.error = `Could not fingerprint candidate after verification: ${String(error)}`;
	}
	if (report.candidateSha256After !== candidateSha256) {
		report.ok = false;
		process.exitCode = 1;
		report.error = "The candidate bundle changed during verification.";
	}
	report.executableUnchanged = createHash("sha256").update(await readFile(executable)).digest("hex") === report.executableSha256;
	if (!report.executableUnchanged) { report.ok = false; process.exitCode = 1; report.error = "The candidate executable changed during verification."; }
	await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ ok: report.ok, error: report.error, evidence }));
}
