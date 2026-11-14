#!/usr/bin/env node
// Explicit, disposable whole-desktop computer-use canary. This script never
// enables computer use or grants macOS permissions. The operator must enable
// it in Kestrel Settings, complete any OS permission handoff, and approve the
// single generated-fixture click in Kestrel's normal approval UI.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { nativePanelProbe } from "./native-panel-probe.mjs";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.env.KESTREL_NATIVE_TEST_APP?.trim();
if (process.platform !== "darwin") throw new Error("This native desktop canary only runs on macOS.");
if (process.env.KESTREL_TEST_NATIVE_DESKTOP_COMPUTER !== "1") throw new Error("Set KESTREL_TEST_NATIVE_DESKTOP_COMPUTER=1 to opt in. No app was launched.");
if (!supplied) throw new Error("Set KESTREL_NATIVE_TEST_APP to the disposable .tmp candidate. No app was launched.");
const expectedCandidate = resolve(root, ".tmp/native-chromium-host/Kestrel.app");
const candidate = await realpath(resolve(supplied));
const temporaryBuildRoot = await realpath(resolve(root, ".tmp"));
assert.equal(candidate, expectedCandidate, "Candidate must be the exact disposable .tmp native Chromium app.");
assert(candidate.startsWith(`${temporaryBuildRoot}/`));
const expectedHash = process.env.KESTREL_NATIVE_COMPUTER_EXPECTED_SHA256?.trim().toLowerCase();
assert.match(expectedHash ?? "", /^[a-f0-9]{64}$/, "Set the reviewed candidate SHA-256 before launch.");
const executable = join(candidate, "Contents/MacOS/Kestrel");
const bundleId = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(candidate, "Contents/Info.plist")], { encoding: "utf8" }).trim();
assert.equal(bundleId, "com.kestrel.native-chromium-host.dev");
await lstat(executable);
const digest = await candidateDigest(candidate);
assert.equal(digest, expectedHash, "Reviewed candidate hash changed; no app was launched.");
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const sqliteProbe = new Database(":memory:");
sqliteProbe.close();

const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-computer-canary-")));
await chmod(profile, 0o700);
await markDisposableNativeTestProfile(profile);
await mkdir(join(profile, "Default"), { mode: 0o700 });
await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({}), { mode: 0o600 });
const profileInfo = await lstat(profile);
assert(profileInfo.isDirectory() && !profileInfo.isSymbolicLink() && profileInfo.uid === process.getuid() && (profileInfo.mode & 0o077) === 0);

const fixtureId = randomUUID();
const fixtureText = `NATIVE_DESKTOP_FIXTURE_${fixtureId}`;
const fixtureTitle = `Kestrel desktop fixture ${fixtureId}`;
let fixtureRequests = 0;
let stubRequests = 0;
let initialCapture;
let initialPngBase64;
let initialExecutionId;
let targetLogicalPoint;
let clickPlan;
let screenshotRequested = false;
let stubFailure;
let postScreenshotRequested = false;
const deliveredFrames = [];
let resolveCapturePermit;
const capturePermit = new Promise(resolve => { resolveCapturePermit = resolve; });
let child;
let browser;
let companion;
let home;
let settings;
let fixturePage;
let runId;
let server;
let fixtureTabId;
let sessionId;
let postActionPngBase64;
let stopped = false;
let profileRemoved = false;
let forcedStop = false;
let cleanupFailed = false;
const restartOnly = process.argv.includes("--restart-only");
const receipt = {
	version: 1,
	kind: "native-desktop-computer-use-canary",
	scope: restartOnly ? "default-off-restart-only-no-capture-or-input" : "approved-single-click-with-model-images",
	candidate: ".tmp/native-chromium-host/Kestrel.app",
	candidateSha256: digest,
	profile: "generated-private-temporary-profile-with-test-key",
	fixture: { id: fixtureId, title: fixtureTitle, action: restartOnly ? "restart status only; no capture or input" : "one click increments a unique count" },
	provider: { kind: "deterministic Ollama-compatible image stub", bind: "127.0.0.1", requestBodiesLogged: false, externalImageTransmission: false, visionInferenceTested: false },
	phases: [],
};
function check(condition, message) { if (!condition) throw new Error(message); }
function requestStream(response, message) {
	response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "close" });
	response.end(JSON.stringify({ model: "native-desktop-canary", message: { role: "assistant", ...message }, done: true,
		prompt_eval_count: 1, eval_count: 1 }) + "\n");
}
function callTool(response, name, args) {
	requestStream(response, { tool_calls: [{ function: { name, arguments: args } }] });
}
function modelFrame(body) {
	const observations = (body.messages ?? []).filter(message => Array.isArray(message.images) && message.images.length);
	check(observations.length === 1 && observations[0].images.length === 1, "Expected exactly one current structured model image.");
	const imageMessage = observations[0];
	check(imageMessage.role === "user", "Model image must use the adapter's supported image role.");
	const reference = JSON.parse(imageMessage.content);
	check(reference.kind === "untrusted_screenshot_observation" && reference.toolName === "computer.screenshot" && reference.trust === "untrusted_desktop", "Missing model-visible screenshot reference.");
	const receipts = (body.messages ?? []).filter(message => message.role === "tool").map(message => {
		try { return { ...JSON.parse(message.content), toolName: message.tool_name }; } catch { return undefined; }
	});
	const tool = receipts.find(item => item?.output?.screenshot?.executionId === reference.executionId);
	check(tool?.status === "verified" && tool.toolName === "computer.screenshot" && !tool.output.pngBase64, "Model metadata must retain the execution reference without text-encoded pixels.");
	const pixels = Buffer.from(imageMessage.images[0], "base64");
	check(pixels.length > 1024 && pixels.toString("base64") === imageMessage.images[0] && pixels.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
		pixels.readUInt32BE(16) === tool.output.width && pixels.readUInt32BE(20) === tool.output.height, "Model did not receive the actual dimension-matched PNG image.");
	const frame = { ...tool.output, executionId: reference.executionId, pngSha256: createHash("sha256").update(pixels).digest("hex") };
	deliveredFrames.push({ executionId: frame.executionId, captureId: frame.captureId, pngSha256: frame.pngSha256 });
	return frame;
}
async function handleStubRequest(request, response) {
	if (request.url === `/fixture/${fixtureId}`) {
		fixtureRequests++;
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${fixtureTitle}</title><style>body{font:24px system-ui;margin:40px}button{font:inherit;padding:18px 28px}#count{font-weight:700}</style><h1>${fixtureText}</h1><button id="target" type="button">Increment fixture count</button><p>Count: <output id="count">0</output></p><script>const targetButton=document.querySelector('#target'),countOutput=document.querySelector('#count');targetButton.addEventListener('click',e=>{window.__fixtureTrustedClick=e.isTrusted;countOutput.value=String(Number(countOutput.value)+1)});</script>`);
		return;
	}
	if (request.url === "/api/tags" || request.url === "/api/show" || request.url === "/api/version") {
		response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
		response.end(JSON.stringify(request.url === "/api/tags" ? { models: [{ name: "native-desktop-canary", model: "native-desktop-canary", size: 1, digest: "0".repeat(64) }] } :
			request.url === "/api/show" ? { capabilities: ["completion", "tools", "vision"], model_info: { "llama.context_length": 32768 } } : { version: "local-fixture" }));
		return;
	}
	if (request.url !== "/api/chat" || request.method !== "POST") {
		response.writeHead(404); response.end(); return;
	}
	stubRequests++;
	let bodyText = "";
	for await (const chunk of request) { bodyText += chunk; if (bodyText.length > 30_000_000) { response.writeHead(413); response.end(); return; } }
	let body;
	try { body = JSON.parse(bodyText); }
	catch { response.writeHead(400); response.end(); return; }
	bodyText = "";
	check(body.model === "native-desktop-canary", "Unexpected model reached the local stub.");
	const available = new Set((body.tools ?? []).map(tool => tool?.function?.name));
	receipt.provider.advertisedToolNames = [...available].filter(name => typeof name === "string").slice(0, 200);
	if (available.has("computer.screenshot") && !screenshotRequested) {
		screenshotRequested = true;
		const allowed = await capturePermit;
		check(allowed === true, "Canary did not confirm the generated fixture remained the active browser tab.");
		callTool(response, "computer.screenshot", {});
		return;
	}
	if (available.has("computer.act") && !clickPlan) {
		// Plan only from the actual model request, never a Core API side channel.
		const capture = modelFrame(body);
		body = undefined;
		check(/^[0-9a-f-]{36}$/i.test(capture.captureId), "Screenshot capture ID is invalid.");
		check(capture.foregroundProcessId === child.pid && Number.isInteger(capture.frontmostWindowId) && capture.frontmostWindowId > 0 && Number.isInteger(capture.displayId) && capture.displayId > 0,
			"Captured foreground identity is not the owned Kestrel candidate or is incomplete; no click will be sent.");
		const logical = targetLogicalPoint;
		check(logical && capture.logicalBounds && capture.frontmostWindowBounds, "DOM target or native screenshot bounds are missing.");
		const { logicalBounds, frontmostWindowBounds } = capture;
		const inside = (point, bounds) => point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
		check(inside(logical, logicalBounds) && inside(logical, frontmostWindowBounds), "Fixture target is outside the captured display or frontmost window; no click planned.");
		const x = Math.round((logical.x - logicalBounds.x) * capture.width / logicalBounds.width);
		const y = Math.round((logical.y - logicalBounds.y) * capture.height / logicalBounds.height);
		check(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < capture.width && y < capture.height, "Mapped fixture click point is outside the captured image.");
		clickPlan = { x, y, captureId: capture.captureId };
		receipt.clickPlan = { ...clickPlan, derivedFrom: "visible fixture DOM center mapped through native logical display bounds", insideDisplayAndFrontmostWindow: true,
			foregroundProcessId: capture.foregroundProcessId, frontmostWindowId: capture.frontmostWindowId, displayId: capture.displayId };
		callTool(response, "computer.act", { action: { type: "click", ...clickPlan } });
		receipt.clickPlanReady = true;
		return;
	}
	if (clickPlan && available.has("computer.screenshot") && !postScreenshotRequested) {
		postScreenshotRequested = true;
		callTool(response, "computer.screenshot", {});
		return;
	}
	if (postScreenshotRequested && available.has("computer.act")) {
		const frame = modelFrame(body);
		check(frame.captureId !== clickPlan.captureId, "Post-input image reused the input authority frame.");
		requestStream(response, { content: "Received the fresh post-click image for the generated fixture. Independent DOM verification follows." });
		return;
	}
	requestStream(response, { content: "Local desktop fixture model ready." });
}
server = createServer((request, response) => {
	void handleStubRequest(request, response).catch(error => {
		stubFailure = error instanceof Error ? error.message : String(error);
		if (!response.headersSent) response.writeHead(500, { "cache-control": "no-store" });
		response.end();
	});
});
server.keepAliveTimeout = 1_000;
server.headersTimeout = 5_000;
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(page, value) {
	const result = await page.evaluate(input => window.kestrel.request(input), value);
	check(result?.ok === true, `Native Core request failed: ${String(result?.error ?? "unknown error")}`);
	return result;
}
async function activateNativePage(page) {
	const state = await request(home, { type: "browser-get-state" });
	const targetUrl = new URL(page.url()), uiUrl = new URL(home.url());
	let displayedUrl = page.url();
	if (targetUrl.protocol === uiUrl.protocol && targetUrl.hostname === uiUrl.hostname) {
		const app = targetUrl.searchParams.get("app");
		displayedUrl = app ? new URL(`kestrel://${app}`).toString() : "";
	}
	const matches = state.browserState?.tabs.filter(tab => tab.url === displayedUrl) ?? [];
	check(matches.length === 1, "Canary page does not identify exactly one native tab.");
	await request(home, { type: "browser-select-tab", tabId: matches[0].id });
	await page.bringToFront();
	const focused = await home.evaluate(async () => {
		const tab = await new Promise(resolve => chrome.tabs.getCurrent(resolve));
		if (!Number.isSafeInteger(tab?.windowId)) return false;
		await chrome.windows.update(tab.windowId, { focused: true });
		return (await chrome.windows.get(tab.windowId)).focused;
	});
	check(focused === true, "Owned native window did not become focused.");
	const selected = await request(home, { type: "browser-get-state" });
	check(selected.browserState?.activeTabId === matches[0].id, "Canary page is not the active native tab before UI interaction.");
}
async function reconnect(predicate) {
	const endpoint = receipt.endpoint;
	await browser?.close().catch(() => {});
	browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
	for (let attempt = 0; attempt < 100; attempt++) {
		const pages = browser.contexts().flatMap(context => context.pages());
		home = pages.find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
		settings = pages.find(page => /index\.html\?app=settings/.test(page.url()));
		if (predicate) {
			const match = pages.find(page => predicate(page.url()));
			if (match && home) return match;
		}
		if (attempt % 10 === 0) {
			const cdp = await browser.newBrowserCDPSession();
			let targetExists = false;
			try {
				const targets = await cdp.send("Target.getTargets");
				targetExists = targets.targetInfos.some(target => target.type === "page" &&
					((predicate && predicate(target.url)) || (!home && /chrome-extension:\/\/[^/]+\/index\.html$/.test(target.url))));
			} finally { await cdp.detach().catch(() => {}); }
			if (targetExists) {
				await browser.close();
				browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
			}
		}
		await delay(100);
	}
	if (predicate) throw new Error("Native-created fixture target did not attach after a CDP reconnect.");
	return undefined;
}
async function startCandidate() {
	let output = "";
	home = undefined; settings = undefined;
	delete receipt.endpoint;
	check(await candidateDigest(candidate) === digest, "Candidate changed before launch.");
	child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? "en_US.UTF-8" },
	});
	receipt.ownedProcessId = child.pid;
	stopped = false;
	let launchFailed = false;
	child.once("error", () => { launchFailed = true; });
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => { output = (output + chunk).slice(-4096); });
	child.stderr.on("data", chunk => { output = (output + chunk).slice(-4096); });
	let endpoint;
	for (let attempt = 0; attempt < 300; attempt++) {
		check(!launchFailed && child.exitCode === null && child.signalCode === null, "Candidate failed to launch or exited before its private Core bridge became ready.");
		endpoint = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
		if (endpoint) break;
		await delay(100);
	}
	check(endpoint, "Timed out waiting for the native candidate. Runtime output is intentionally not copied to the receipt.");
	receipt.endpoint = endpoint;
	browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
	for (let attempt = 0; attempt < 300; attempt++) {
		check(!launchFailed && child.exitCode === null && child.signalCode === null, "Candidate exited before Kestrel Home became ready.");
		const pages = browser.contexts().flatMap(context => context.pages());
		home = pages.find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
		if (home) break;
		if (attempt % 10 === 0) {
			const cdp = await browser.newBrowserCDPSession();
			let homeTargetExists = false;
			try {
				const targets = await cdp.send("Target.getTargets");
				homeTargetExists = targets.targetInfos.some(target => target.type === "page" && /chrome-extension:\/\/[^/]+\/index\.html$/.test(target.url));
			} finally { await cdp.detach().catch(() => {}); }
			if (homeTargetExists) {
				await browser.close();
				browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
			}
		}
		await delay(100);
	}
	check(home, "Kestrel Home did not become ready.");
	await home.waitForFunction(() => typeof window.kestrel?.request === "function", undefined, { timeout: 30_000 });
	return home;
}
async function stopCandidate() {
	await browser?.close().catch(() => {}); browser = undefined;
	if (!child || child.exitCode !== null || child.signalCode !== null) { stopped = true; return; }
	const exit = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
	child.kill("SIGTERM");
	let outcome = await Promise.race([exit, delay(15_000).then(() => undefined)]);
	if (!outcome) { forcedStop = true; child.kill("SIGKILL"); outcome = await Promise.race([exit, delay(5_000).then(() => undefined)]); }
	check(outcome, "Candidate remains alive after bounded cleanup.");
	stopped = true;
	check(!forcedStop && outcome.code === 0 && outcome.signal === null, "Candidate required forced shutdown or did not exit cleanly.");
}
async function waitForStatus(enabled) {
	const end = Date.now() + 20 * 60_000;
	for (;;) {
		check(child.exitCode === null && child.signalCode === null, "Candidate exited while waiting for user consent/permissions.");
		const result = await request(home, { type: "computer-use-status" });
		const status = result.computerUseStatus;
		if (enabled ? status.enabled && status.controlReady : !status.enabled) return status;
		if (Date.now() >= end) throw new Error("Timed out waiting for the operator's Kestrel UI choice or macOS permission handoff.");
		await delay(500);
	}
}
async function readRunState(sessionId) {
	const [runs, executions, approvals] = await Promise.all([
		request(home, { type: "runtime-list-runs", sessionId }),
		request(home, { type: "runtime-list-executions", sessionId, limit: 50 }),
		request(home, { type: "runtime-list-pending-tool-approvals" }),
	]);
	return { runs: runs.runs ?? [], executions: executions.executions ?? [], approvals: approvals.executions ?? [] };
}
async function verifyRawDatabaseDoesNotContainScreenshot() {
	const directory = join(profile, "native-core", "database");
	const entries = await readdir(directory);
	const files = entries.filter(name => name === "kestrel.sqlite" || name.startsWith("kestrel.sqlite-") || name.startsWith("kestrel.sqlite."));
	check(files.includes("kestrel.sqlite"), "Generated Native Core database is missing.");
	const pngs = [initialPngBase64, postActionPngBase64].map(value => Buffer.from(value ?? "", "utf8"));
	check(pngs.every(png => png.length > 1024), "Canary did not observe both generated screenshot payloads.");
	const dbPath = join(directory, "kestrel.sqlite");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	db.pragma("query_only = ON");
	try {
		const screenshotRows = db.prepare("SELECT id, tool_name, payload FROM tool_executions WHERE session_id = ? AND tool_name = 'computer.screenshot'").all(sessionId);
		const rowsById = new Map(screenshotRows.map(row => [row.id, row]));
		for (const id of [initialExecutionId, receipt.freshCapture?.executionId]) {
			check(typeof id === "string", "Screenshot execution ID is missing from the canary evidence.");
			const row = rowsById.get(id);
			check(row?.tool_name === "computer.screenshot", "Expected screenshot execution was not found in SQLite.");
		}
		check(screenshotRows.length >= 2, "Expected screenshot execution rows were not all present in SQLite.");
		for (const row of screenshotRows) {
			const envelope = JSON.parse(row.payload);
			check(envelope.kestrelEncryptedTool === 1 && typeof envelope.ciphertext === "string" && typeof envelope.iv === "string" && typeof envelope.authTag === "string", "Screenshot execution payload is not stored as the protected envelope.");
		}
		const prefix = `runtime-tool:${sessionId}:computer.screenshot:%`;
		const idempotency = db.prepare("SELECT result FROM idempotency_keys WHERE key LIKE ? LIMIT 50").all(prefix);
		check(idempotency.length > 0, "No screenshot idempotency result rows were found for protected persistence inspection.");
		for (const row of idempotency) {
			check(typeof row.result === "string" && row.result.startsWith("kestrel-encrypted-idempotency-v1:"), "Screenshot idempotency result is not encrypted with the protected prefix.");
			const envelope = JSON.parse(row.result.slice("kestrel-encrypted-idempotency-v1:".length));
			check(typeof envelope.ciphertext === "string" && typeof envelope.iv === "string" && typeof envelope.authTag === "string", "Screenshot idempotency result lacks an AES-GCM envelope.");
		}
		const claims = db.prepare("SELECT pending_result FROM idempotency_claims WHERE key LIKE ? LIMIT 50").all(prefix);
		for (const row of claims) {
			if (row.pending_result === null) continue;
			check(typeof row.pending_result === "string" && row.pending_result.startsWith("kestrel-encrypted-idempotency-v1:"), "Pending screenshot idempotency result is not encrypted with the protected prefix.");
			const envelope = JSON.parse(row.pending_result.slice("kestrel-encrypted-idempotency-v1:".length));
			check(typeof envelope.ciphertext === "string" && typeof envelope.iv === "string" && typeof envelope.authTag === "string", "Pending screenshot result lacks an AES-GCM envelope.");
		}
	} finally { db.close(); }
	for (const name of files) {
		const path = join(directory, name);
		const info = await lstat(path);
		check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid(), "Unexpected Native Core database entry.");
		const bytes = await readFile(path);
		for (const png of pngs) {
			check(!bytes.includes(png), "Screenshot PNG payload appeared in raw SQLite/WAL bytes.");
			for (let offset = 0; offset + 64 <= png.length; offset += Math.max(64, Math.floor((png.length - 64) / 32))) {
				check(!bytes.includes(png.subarray(offset, offset + 64)), "A sampled screenshot PNG fragment appeared in raw SQLite/WAL bytes.");
			}
		}
	}
	receipt.encryptedScreenshotPersistence = { databaseFiles: files, screenshotRowsProtected: true, idempotencyRowsProtected: true, sampledPngFragmentsAbsentFromRawBytes: true, secureErasureClaimed: false };
	initialPngBase64 = undefined;
	postActionPngBase64 = undefined;
}

try {
	const homePage = await startCandidate();
	if (restartOnly) {
		receipt.provider = { kind: "none", bind: "unused", localCompletionRequests: 0, externalImageTransmission: false };
		for (let attempt = 0; attempt < 3; attempt++) {
			const status = await request(home, { type: "computer-use-status" });
			check(status.computerUseStatus.enabled === false, "Restart-only canary must remain default-off.");
			receipt.phases.push({ phase: `default-off-start-${attempt + 1}`, passed: true, enabled: false });
			await stopCandidate();
			if (attempt < 2) await startCandidate();
		}
		check(await candidateDigest(candidate) === digest, "Candidate changed during restart-only canary.");
		receipt.result = "passed";
	} else {
	// This generated profile isolates computer control. First-run onboarding has
	// its own canary and is not evidence produced by this flow.
	await homePage.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await homePage.reload();
	await homePage.locator("#new-tab-chat-input").waitFor();
	receipt.onboarding = "preconfigured disposable fixture; onboarding not tested";
	const initial = await request(homePage, { type: "computer-use-status" });
	check(initial.computerUseStatus.enabled === false, "Fresh disposable profile must start with computer use off.");
	receipt.phases.push({ phase: "fresh-profile-default-off", passed: true, screenRecording: initial.computerUseStatus.screenRecording, accessibility: initial.computerUseStatus.accessibility });

	// Configure only a generated loopback provider through Settings UI.
	const settingsButton = home.getByRole("button", { name: "Open settings", exact: true });
	await settingsButton.click();
	settings = await reconnect(url => /index\.html\?app=settings/.test(url));
	check(settings, "Kestrel Settings did not open through product UI.");
	await activateNativePage(settings);
	await selectSettingsSection(settings, "agent-models", "Models & routing");
	const form = settings.locator(".provider-account-add");
	await form.waitFor();
	await form.locator("select").selectOption("ollama");
	await form.getByLabel("Account label", { exact: true }).fill("Native desktop canary");
	await form.getByLabel(/Base URL/).fill(baseUrl);
	await form.getByLabel("Fallback model ID (optional)", { exact: true }).fill("native-desktop-canary");
	await form.locator("summary").filter({ hasText: "Advanced connection settings" }).click();
	await form.getByRole("button", { name: "Add account", exact: true }).click();
	const providerCard = settings.locator(".provider-account-card").filter({ hasText: "Native desktop canary" });
	await providerCard.getByText("Ready", { exact: true }).waitFor();
	check(stubRequests === 0, "Provider setup must not issue a completion before the canary run.");
	receipt.phases.push({ phase: "loopback-stub-configured-through-product-settings", passed: true, address: "127.0.0.1", externalProviderUsed: false });

	const created = await request(home, { type: "browser-create-tab", input: `${baseUrl}/fixture/${fixtureId}`, active: true });
	fixtureTabId = created.tabId ?? created.browserState?.activeTabId;
	check(typeof fixtureTabId === "string", "Generated fixture tab was not created.");
	fixturePage = await reconnect(url => url === `${baseUrl}/fixture/${fixtureId}`);
	await fixturePage.getByRole("heading", { name: fixtureText, exact: true }).waitFor();
	check(fixtureRequests > 0, "Generated fixture was not served by the loopback server.");
	const targetGeometry = await fixturePage.locator("#target").evaluate(element => {
		const rect = element.getBoundingClientRect();
		const contentTop = window.screenY + window.outerHeight - window.innerHeight;
		return { x: window.screenX + rect.left + rect.width / 2, y: contentTop + rect.top + rect.height / 2,
			visible: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
			count: document.querySelector("#count").value, title: document.title };
	});
	check(targetGeometry.visible && targetGeometry.count === "0" && targetGeometry.title === fixtureTitle, "Fixture click target is not uniquely visible before action.");
	targetLogicalPoint = { x: targetGeometry.x, y: targetGeometry.y };
	const companionPages = browser.contexts().flatMap(context => context.pages());
	home = companionPages.find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
	settings = companionPages.find(page => /index\.html\?app=settings/.test(page.url()));
	check(home && settings, "Manager-page handles must be refreshed after native tab creation.");
	const providers = await request(home, { type: "runtime-list-providers" });
	const providerAccount = providers.providerAccounts?.find(account => account.providerId === "ollama");
	check(typeof providerAccount?.id === "string", "Generated loopback provider account was not available to Core.");

	await activateNativePage(settings);
	await selectSettingsSection(settings, "agent-permissions", "Permissions and sandbox");
	const switchControl = settings.getByRole("switch", { name: "Enable whole-desktop computer use" });
	await switchControl.waitFor();
	assert.equal(await switchControl.getAttribute("aria-checked"), "false", "Canary must never self-enable computer use.");
	console.log("NATIVE_DESKTOP_CANARY_CONSENT_REQUIRED: enable Whole-desktop computer use in this Kestrel Settings page; grant Screen Recording and Accessibility only through macOS Settings if needed. This script will wait and will not toggle or grant permissions.");
	const readyStatus = await waitForStatus(true);
	receipt.phases.push({ phase: "explicit-product-enable-and-native-permission-readiness", passed: true, screenRecording: readyStatus.screenRecording, accessibility: readyStatus.accessibility, enabledByScript: false });

	// Open the real native companion from Settings, then submit from Home's
	// product composer so the normal conversation and approval UI are created.
	await activateNativePage(settings);
	await selectSettingsSection(settings, "browser-extensions", "Extensions");
	await settings.getByRole("link", { name: /Browse Chrome Web Store/ }).click();
	const managerPages = browser.contexts().flatMap(context => context.pages());
	home = managerPages.find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
	settings = managerPages.find(page => /index\.html\?app=settings/.test(page.url()));
	check(home && settings, "Manager-page handles must be refreshed after opening the native companion.");
	const uiUrl = new URL(home.url());
	companion = await nativePanelProbe(receipt.endpoint, `${uiUrl.protocol}//${uiUrl.host}`);
	await home.evaluate(id => {
		localStorage.setItem("kestrel:execution-mode", "manual");
		localStorage.setItem("kestrel:provider-id", "ollama");
		localStorage.setItem("kestrel:provider-account-id", id);
		localStorage.setItem("kestrel:model", "native-desktop-canary");
	}, providerAccount.id);
	await activateNativePage(home); await home.reload(); await home.locator("#new-tab-chat-input").waitFor();
	const prompt = `For generated fixture ${fixtureId}, call computer.screenshot, then call computer.act exactly once with one click on the visible Increment fixture count button. Then take a second computer.screenshot and inspect the result before completing. Do not type, press keys, batch actions, retry input, or call any other tools.`;
	await home.locator("#new-tab-chat-input").fill(prompt);
	const policyButton = home.getByRole("button", { name: "Approval policy: Ask for approval", exact: true });
	if (!(await policyButton.count())) {
		await home.getByRole("button", { name: /^Approval policy:/ }).click();
		await home.getByRole("menuitemradio", { name: /Ask for approval/ }).click();
	}
	await home.getByRole("button", { name: /^Send message to / }).click();
	for (let attempt = 0; attempt < 100; attempt++) {
		const listed = await request(home, { type: "runtime-list-sessions" });
		const match = listed.sessions?.find(item => item.title?.includes(fixtureId));
		if (match) { sessionId = match.id; break; }
		await delay(100);
	}
	check(typeof sessionId === "string", "Home composer did not create the canary conversation.");
	// Re-select the generated tab through the supported browser API before any
	// capture. A page handle alone is not proof of the active native tab.
	const selectFixture = async () => {
		await activateNativePage(fixturePage);
		await fixturePage.waitForFunction(() => document.visibilityState === "visible");
		const state = await request(home, { type: "browser-get-state" });
		check(state.browserState?.activeTabId === fixtureTabId, "Generated fixture tab is not the selected browser tab.");
	};
	await selectFixture();
	const currentGeometry = await fixturePage.locator("#target").evaluate(element => {
		const rect = element.getBoundingClientRect();
		const contentTop = window.screenY + window.outerHeight - window.innerHeight;
		return { x: window.screenX + rect.left + rect.width / 2, y: contentTop + rect.top + rect.height / 2,
			visible: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
	});
	check(currentGeometry.visible, "Fixture target moved or became hidden before capture.");
	targetLogicalPoint = { x: currentGeometry.x, y: currentGeometry.y };
	receipt.fixtureGeometry = { ...targetLogicalPoint };
	receipt.fixtureBeforeAction = { count: "0", targetVisible: true, selectedTabVerified: true };
	resolveCapturePermit(true);
	let waiting;
	for (let attempt = 0; attempt < 300; attempt++) {
		check(!stubFailure, `Local deterministic provider failed: ${stubFailure}`);
		const state = await readRunState(sessionId);
		if (!initialCapture) {
			const screenshot = state.executions.find(item => item.toolName === "computer.screenshot" && item.status === "verified" && item.output?.captureId);
			const failedScreenshot = state.executions.find(item => item.toolName === "computer.screenshot" && item.status === "failed");
			check(!failedScreenshot, "Native desktop screenshot tool failed before model input.");
			if (screenshot) {
				initialCapture = {
					captureId: screenshot.output.captureId,
					width: screenshot.output.width,
					height: screenshot.output.height,
					capturedAt: screenshot.output.capturedAt,
					logicalBounds: screenshot.output.logicalBounds,
					frontmostWindowBounds: screenshot.output.frontmostWindowBounds,
					foregroundProcessId: screenshot.output.foregroundProcessId,
					frontmostWindowId: screenshot.output.frontmostWindowId,
					displayId: screenshot.output.displayId,
				};
				initialExecutionId = screenshot.id;
				check(initialCapture.foregroundProcessId === child.pid && Number.isInteger(initialCapture.frontmostWindowId) && initialCapture.frontmostWindowId > 0 && Number.isInteger(initialCapture.displayId) && initialCapture.displayId > 0,
					"Screenshot foreground identity is not the owned Kestrel process or is incomplete.");
				receipt.initialCapture = { ...initialCapture };
				initialPngBase64 = screenshot.output.pngBase64;
				check(typeof initialPngBase64 === "string" && initialPngBase64.length > 1024, "Generated desktop screenshot payload is missing.");

			}
		}
		for (const execution of state.executions) if (execution.toolName === "computer.screenshot" && execution.output) delete execution.output.pngBase64;
		waiting = state.runs.find(run => run.status === "waiting_approval" && run.pendingToolName === "computer.act");
		if (waiting) { runId = waiting.id; break; }
		await delay(100);
	}
	check(runId, "Runtime did not stop for the normal computer.act approval.");
	check(receipt.clickPlanReady === true, "Local deterministic provider did not plan the single click.");
	const pendingApproval = (await readRunState(sessionId)).approvals.find(item => item.toolName === "computer.act" && item.status === "blocked");
	check(pendingApproval, "Kestrel has no pending real computer.act approval for the canary run.");
	const fixtureStateAtApproval = await request(home, { type: "browser-get-state" });
	check(fixtureStateAtApproval.browserState?.activeTabId === fixtureTabId, "Fixture tab is not still selected when approval is presented.");
	const approvalDeadline = Date.now() + 15_000;
	let approvalUi = "";
	while (Date.now() < approvalDeadline) {
		approvalUi = await companion.text();
		if (approvalUi.includes("Approval required") && approvalUi.includes("computer.act") && approvalUi.includes("Allow once")) break;
		await delay(100);
	}
	check(approvalUi.includes("Approval required") && approvalUi.includes("computer.act") && approvalUi.includes("Allow once"), "The native companion did not render the real pending computer.act approval card.");
	receipt.approval = { required: true, runId, pendingExecutionId: pendingApproval.id, approvalDecision: "awaiting-human-Kestrel-approval" };
	console.log(`NATIVE_DESKTOP_CANARY_APPROVAL_REQUIRED: the native companion shows the real Allow once card while the generated fixture remains selected. Review and approve exactly one computer.act click in Kestrel. Run ${runId}; execution ${pendingApproval.id}. The screenshot capture expires after 30 seconds and a changed foreground process/window fails closed. No automatic approval or retry will occur.`);

	let completedState;
	for (let attempt = 0; attempt < 600; attempt++) {
		completedState = await readRunState(sessionId);
		const run = completedState.runs.find(item => item.id === runId);
		if (run && ["completed", "failed", "cancelled"].includes(run.status)) break;
		await delay(100);
	}
	const completedRun = completedState.runs.find(item => item.id === runId);
	check(completedRun?.status === "completed", `Approved canary action did not complete successfully (status=${completedRun?.status ?? "missing"}).`);
	fixturePage = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === `${baseUrl}/fixture/${fixtureId}`);
	check(fixturePage, "Fixture page handle was lost after approval.");
	const afterClick = await fixturePage.locator("#target").evaluate(() => ({ count: document.querySelector("#count").value, trusted: window.__fixtureTrustedClick === true }));
	check(afterClick.count === "1" && afterClick.trusted, "Fresh fixture DOM proof did not observe exactly one trusted native click.");
	const actionExecution = completedState.executions.find(item => item.toolName === "computer.act" && item.status === "verified");
	check(actionExecution, "Runtime execution history lacks a verified computer.act result.");
	check(actionExecution.input?.action?.captureId === initialCapture?.captureId, "Approved action did not consume the exact screenshot capture ID.");
	const actionReceipts = await request(home, { type: "runtime-list-action-receipts", sessionId, limit: 50 });
	const actionReceipt = (actionReceipts.receipts ?? []).find(item => item.toolExecutionId === actionExecution.id);
	check(actionReceipt && actionReceipt.outcome === "verified" && actionReceipt.approval?.result === "approved_once", "Action receipt does not prove a one-time human approval and verified outcome.");
	for (const execution of completedState.executions) if (execution.toolName === "computer.screenshot" && execution.output) delete execution.output.pngBase64;
	receipt.approval = { required: true, runId, executionId: actionExecution.id, outcome: actionReceipt.outcome, approvalDecision: actionReceipt.approval.result };
	receipt.fixtureAfterAction = afterClick;
	receipt.initialCapture = { captureId: initialCapture.captureId, width: initialCapture.width, height: initialCapture.height,
		foregroundProcessId: initialCapture.foregroundProcessId, frontmostWindowId: initialCapture.frontmostWindowId, displayId: initialCapture.displayId };
	receipt.phases.push({ phase: "single-human-approved-native-click-and-fresh-dom-proof", passed: true });

	const screenshots = completedState.executions.filter(item => item.toolName === "computer.screenshot" && item.status === "verified");
	check(screenshots.length === 2 && deliveredFrames.length === 2, "Agent must capture and receive exactly two model images.");
	const fresh = screenshots.find(item => item.id !== initialExecutionId);
	check(fresh?.output?.captureId && fresh.output.captureId !== initialCapture.captureId && Date.parse(fresh.output.capturedAt) >= Date.parse(actionExecution.completedAt), "Agent did not take a distinct post-action screenshot before completing.");
	check(fresh.output.foregroundProcessId === child.pid && fresh.output.frontmostWindowId === initialCapture.frontmostWindowId && fresh.output.displayId === initialCapture.displayId,
		"Fresh post-action capture came from a different foreground process, window, or display.");
	// Re-read encrypted execution semantics only to independently attest model
	// delivery. These values never feed the deterministic model's click plan.
	const persisted = await request(home, { type: "runtime-list-executions", sessionId, limit: 50 });
	const postExecution = persisted.executions.find(item => item.id === fresh.id);
	postActionPngBase64 = postExecution?.output?.pngBase64;
	for (const [index, pixels] of [initialPngBase64, postActionPngBase64].entries()) {
		const frame = deliveredFrames[index];
		check(typeof pixels === "string" && frame.pngSha256 === createHash("sha256").update(Buffer.from(pixels, "base64")).digest("hex"), "Model image bytes did not match the independent Core execution.");
	}
	receipt.freshCapture = { executionId: fresh.id, initialCaptureId: initialCapture.captureId, postActionCaptureId: fresh.output.captureId, distinct: true, agentRequested: true, imageReturnedToReceipt: false };
	receipt.provider.deliveredFrames = deliveredFrames;
	receipt.phases.push({ phase: "agent-post-action-native-capture-and-model-image-delivery", passed: true });

	// Disable in the real product UI, verify fail-closed, then restart same
	// generated profile and confirm the saved preference remains off.
	await activateNativePage(settings);
	await selectSettingsSection(settings, "agent-permissions", "Permissions and sandbox");
	const enabledSwitch = settings.getByRole("switch", { name: "Enable whole-desktop computer use" });
	await enabledSwitch.waitFor();
	if (await enabledSwitch.getAttribute("aria-checked") === "true") await enabledSwitch.click();
	const off = await waitForStatus(false);
	check(off.enabled === false, "Computer use did not disable through its product switch.");
	const blockedCapture = await home.evaluate(sessionId => window.kestrel.request({ type: "runtime-call-tool", sessionId, toolName: "computer.screenshot", input: {} }), sessionId);
	check(blockedCapture.ok === true && blockedCapture.execution?.status === "failed", "Disabled computer use did not fail closed on screenshot request.");
	receipt.phases.push({ phase: "product-ui-disable-and-fail-closed-capture", passed: true, enabled: false, deniedExecution: blockedCapture.execution.id });
	await stopCandidate();
	await verifyRawDatabaseDoesNotContainScreenshot();
	await startCandidate();
	const restarted = await request(home, { type: "computer-use-status" });
	check(restarted.computerUseStatus.enabled === false, "Computer use was not off after restart.");
	receipt.phases.push({ phase: "same-profile-restart-remains-off", passed: true });
	await stopCandidate();
	check(await candidateDigest(candidate) === digest, "Candidate changed during canary.");
	receipt.provider.localCompletionRequests = stubRequests;
	check(stubRequests >= 4, "Deterministic loopback provider did not receive all four bounded model turns.");
	receipt.result = "passed";
	}
} catch (error) {
	receipt.result = "failed";
	receipt.failure = { phase: "canary", message: error instanceof Error ? error.message : String(error) };
	throw error;
} finally {
	resolveCapturePermit(false);
	initialPngBase64 = undefined;
	postActionPngBase64 = undefined;
	delete receipt.clickPlanReady;
	delete receipt.endpoint;
	if (companion) { companion.close(); companion = undefined; }
	if (!stopped) {
		try { await stopCandidate(); }
		catch (error) {
			cleanupFailed = true;
			receipt.cleanupFailure = error instanceof Error ? error.message : String(error);
		}
	}
	if (server) {
		server.closeAllConnections();
		const closed = await Promise.race([
			new Promise(resolveClose => server.close(() => resolveClose(true))),
			delay(2_000).then(() => false),
		]);
		if (!closed) {
			cleanupFailed = true;
			receipt.cleanupFailure = "Loopback stub server did not close within the cleanup deadline.";
		}
	}
	const processExited = !!child && (child.exitCode !== null || child.signalCode !== null);
	if (stopped && processExited) {
		const profileInfo = await lstat(profile).catch(() => undefined);
		if (profileInfo?.isDirectory() && !profileInfo.isSymbolicLink() && profileInfo.uid === process.getuid() && (profileInfo.mode & 0o077) === 0) {
			await rm(profile, { recursive: true, force: true }); profileRemoved = true;
		}
	}
	receipt.cleanup = { ownedProcessStopped: stopped, forcedStop, generatedProfileRemoved: profileRemoved };
	if (cleanupFailed || !stopped || forcedStop) {
		receipt.result = "failed";
		receipt.failure ??= { phase: "cleanup", message: receipt.cleanupFailure ?? "Owned process cleanup was incomplete or forced." };
	}
	const receiptPath = resolve(root, ".tmp", `native-desktop-computer-canary-${fixtureId}.json`);
	await mkdir(dirname(receiptPath), { recursive: true });
	await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	console.log(`NATIVE_DESKTOP_CANARY_RECEIPT: ${receiptPath}`);
}
