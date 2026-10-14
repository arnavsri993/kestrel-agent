import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-browser-scope-"));
const fixtureHome = join(root, "home");
mkdirSync(fixtureHome, { recursive: true });
const evidence = process.env.KESTREL_BROWSER_SCOPE_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable ? resolve(packagedExecutable) : requireFromDesktop("electron");
const hostEnvironment = Object.fromEntries(
	["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "DISPLAY"].flatMap(
		key => process.env[key] ? [[key, process.env[key]]] : [],
	),
);
const privatePath = "private-redirect-path-sentinel";
const privateQuery = "private-redirect-query-sentinel";
let targetRequests = 0;
const target = createServer((_request, response) => {
	targetRequests += 1;
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
	response.end("<!doctype html><title>Explicitly allowed destination</title><h1>Destination reached</h1>");
});
const listen = async server => {
	await new Promise((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	assert(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
};
const targetOrigin = await listen(target);
const source = createServer((request, response) => {
	if (request.url === "/redirect") {
		response.writeHead(302, { location: `${targetOrigin}/${privatePath}?token=${privateQuery}#private-fragment-sentinel` });
		response.end();
		return;
	}
	if (request.url === "/same-origin") {
		response.writeHead(302, { location: "/ok" });
		response.end();
		return;
	}
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
	response.end(`<!doctype html><title>Allowed source</title><h1>Allowed source reached</h1>${request.url === "/resources" ? `<iframe src="${targetOrigin}/frame"></iframe><img src="${targetOrigin}/image">` : ""}`);
});
const sourceOrigin = await listen(source);
let application;
let report;
try {
	application = await electron.launch({
		executablePath,
		args: packagedExecutable ? ["--use-mock-keychain"] : [resolve("apps/desktop"), "--use-mock-keychain"],
		env: {
			...hostEnvironment,
			HOME: fixtureHome,
			CODEX_HOME: join(fixtureHome, ".codex"),
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	report = await page.evaluate(async ({ sourceOrigin, targetOrigin }) => {
		const listed = await window.kestrel.request({ type: "runtime-list-sessions" });
		if (!listed.ok) throw new Error(listed.error);
		let sessionId;
		for (const candidate of listed.sessions ?? []) {
			const discovered = await window.kestrel.request({ type: "runtime-discover-tools", sessionId: candidate.id, query: "browser.create" });
			if (discovered.ok && discovered.tools?.some(tool => tool.name === "browser.create")) {
				sessionId = candidate.id;
				break;
			}
		}
		if (!sessionId) throw new Error("Isolated browser tools were not installed.");
		let callSequence = 0;
		const run = async (toolName, input) => {
			let result = await window.kestrel.request({ type: "runtime-call-tool", sessionId, toolName, input, approvalStatus: "approved", idempotencyKey: `scope-fixture-${++callSequence}` });
			if (!result.ok) throw new Error(result.error);
			if (toolName === "browser.create" && result.execution?.status === "blocked" && result.execution.output?.approvalRequired) {
				result = await window.kestrel.request({ type: "runtime-call-tool", sessionId, toolName, input, approvalStatus: "approved", approvalGrantExecutionId: result.execution.id, idempotencyKey: `scope-approved-${++callSequence}` });
				if (!result.ok) throw new Error(result.error);
			}
			return result.execution;
		};
		const verified = async (toolName, input) => {
			const execution = await run(toolName, input);
			if (execution?.status !== "verified") throw new Error(`${toolName}: ${execution?.status}: ${execution?.error}`);
			return execution.output;
		};
		const created = await verified("browser.create", { allowedOrigins: [sourceOrigin] });
		const browserSessionId = created.browserSessionId;
		let denied;
		let recovered;
		let resources;
		try {
			denied = await run("browser.navigate", { browserSessionId, url: `${sourceOrigin}/redirect` });
			await verified("browser.navigate", { browserSessionId, url: `${sourceOrigin}/same-origin` });
			recovered = await verified("browser.snapshot", { browserSessionId });
			await verified("browser.navigate", { browserSessionId, url: `${sourceOrigin}/resources` });
			resources = await verified("browser.snapshot", { browserSessionId });
		} finally {
			await verified("browser.close", { browserSessionId });
		}
		// A separate, explicitly scoped fixture session grants both exact origins.
		// The failed session never grows its allowlist automatically.
		const allowed = await verified("browser.create", { allowedOrigins: [sourceOrigin, targetOrigin] });
		let allowedSnapshot;
		try {
			await verified("browser.navigate", { browserSessionId: allowed.browserSessionId, url: `${sourceOrigin}/redirect` });
			allowedSnapshot = await verified("browser.snapshot", { browserSessionId: allowed.browserSessionId });
		} finally {
			await verified("browser.close", { browserSessionId: allowed.browserSessionId });
		}
		return {
			deniedStatus: denied?.status,
			deniedError: denied?.error ?? "",
			recoveredTitle: recovered.title,
			resourcesTitle: resources.title,
			allowedTitle: allowedSnapshot.title,
			allowedText: JSON.stringify(allowedSnapshot.accessibilityTree),
		};
	}, { sourceOrigin, targetOrigin });
	// Only the separately authorized session can reach the target server.
	report.targetRequests = targetRequests;
	if (evidence) writeFileSync(join(evidence, "scope-results.json"), JSON.stringify(report, null, 2));
	assert.notEqual(report.deniedStatus, "verified", "An outside-origin redirect must fail closed");
	assert(report.deniedError.includes(targetOrigin) && /(?:redirect|navigation).*origin allowlist/i.test(report.deniedError), "The failure must identify the blocked destination origin and scope boundary");
	for (const sentinel of [privatePath, privateQuery, "private-fragment-sentinel"]) {
		assert(!report.deniedError.includes(sentinel), "Scope errors must omit destination paths, queries, and fragments");
	}
	assert.equal(report.recoveredTitle, "Allowed source", "A previous scope denial must not taint a later allowed navigation");
	assert.equal(report.resourcesTitle, "Allowed source", "Blocked iframe and image requests must not fail the main-frame navigation");
	assert.equal(report.allowedTitle, "Explicitly allowed destination");
	assert.match(report.allowedText, /Destination reached/);
	assert.equal(targetRequests, 1, "Only the separately allowed main-frame navigation may reach the destination");
	console.log("Isolated browser scope fixture passed: private redirect blocked, allowed retry and subresources handled, explicit two-origin session reached destination.");
} finally {
	if (report && evidence) writeFileSync(join(evidence, "scope-results.json"), JSON.stringify(report, null, 2));
	await application?.close();
	for (const server of [source, target]) {
		server.closeAllConnections();
		await new Promise(done => server.close(done));
	}
	rmSync(root, { recursive: true, force: true });
}
