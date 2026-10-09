import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-context-continuity-"));
const evidence = process.env.KESTREL_CONTEXT_CONTINUITY_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const requireDesktop = createRequire(resolve("apps/desktop/package.json"));
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const brief = "Prepare a five-minute Kestrel demo for AI builders, under 600 words, with two fallback plans and citations. Keep the original deliverable during research recovery.";
const recovery = "NAVIGATION-RECOVERY: use the direct destination and continue the original brief without asking me to repeat it.";
const restartedRecovery = "RESTART-RECOVERY: continue the same brief with its audience, duration, word limit, fallbacks and citations.";
const errors = [];
let recoveryRequests = 0;
const server = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/v1/models") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }));
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const users = (body.messages ?? []).filter(message => message.role === "user").map(message =>
		typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n"));
	const latest = users.at(-1);
	let text = "Original brief captured.";
	if (latest === recovery || latest === restartedRecovery) {
		recoveryRequests += 1;
		if (!users.includes(brief) || users.indexOf(brief) >= users.length - 1) {
			errors.push("The original user brief was absent or ordered after the recovery request.");
			text = "MISSING-BRIEF: context continuity failed.";
		} else {
			text = latest === recovery ? "RECOVERED-BRIEF: five minutes, AI builders, under 600 words, two fallbacks and citations." : "RESTARTED-BRIEF: the original requirements survived restart and continued recovery.";
		}
	}
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
	response.end(`data: ${JSON.stringify({ id: "context-fixture", model: "fixture-model", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
let app;
async function launch() {
	app = await electron.launch({
		executablePath: executable ? resolve(executable) : requireDesktop("electron"),
		args: executable ? ["--use-mock-keychain"] : [resolve("apps/desktop"), "--use-mock-keychain"],
		env: { ...process.env, KESTREL_TEST_USER_DATA: join(root, "profile"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", NOUS_API_KEY: "local-test-credential", NOUS_BASE_URL: `http://127.0.0.1:${address.port}/v1`, NOUS_MODEL: "fixture-model" },
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
	await page.reload();
	const toggle = page.locator("#browser-agent-toggle");
	if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
	await page.locator("#runtime-prompt").waitFor();
	return page;
}
async function send(page, text) {
	await page.getByRole("textbox", { name: "Message Kestrel" }).fill(text);
	await page.locator(".agent-conversation-host").getByRole("button", { name: "Send message", exact: true }).click();
}
async function waitForRecovery(page, marker) {
	await page.waitForFunction(marker => document.querySelector(".agent-conversation-host")?.textContent?.includes(marker) || document.querySelector(".agent-conversation-host")?.textContent?.includes("MISSING-BRIEF"), marker);
	assert.deepEqual(errors, []);
	await page.locator(".agent-conversation-host").getByText(marker, { exact: false }).waitFor();
}
try {
	let page = await launch();
	await page.locator(".agent-conversation-host").getByRole("button", { name: /^Model:/ }).click();
	const menu = page.getByRole("dialog", { name: "Choose a provider, account, model, and thinking level" });
	await menu.locator('.model-selector-column[aria-label="Provider"]').getByRole("button", { name: /^Nous/ }).click();
	await menu.getByLabel("Explicit model ID").fill("fixture-model");
	await menu.getByLabel("Explicit model ID").press("Enter");
	await menu.waitFor({ state: "detached" });
	await send(page, brief);
	await page.getByText("Original brief captured.", { exact: true }).waitFor();
	const sessionId = await page.evaluate(async brief => {
		const sessions = await window.kestrel.request({ type: "runtime-list-sessions" });
		if (!sessions.ok) throw new Error(sessions.error);
		for (const session of sessions.sessions ?? []) {
			const result = await window.kestrel.request({ type: "runtime-list-messages", sessionId: session.id });
			if (result.messages?.some(message => message.role === "user" && message.content === brief)) return session.id;
		}
		throw new Error("The test conversation was not stored.");
	}, brief);
	await page.evaluate(async sessionId => {
		for (let index = 0; index < 20; index += 1) {
			const result = await window.kestrel.request({ type: "runtime-append-message", sessionId, role: "assistant", content: `Captured research fixture ${index}: ${"page evidence ".repeat(900)}` });
			if (!result.ok) throw new Error(result.error);
		}
	}, sessionId);
	await send(page, recovery);
	await waitForRecovery(page, "RECOVERED-BRIEF:");
	if (evidence) await page.screenshot({ path: join(evidence, "recovered-brief.png") });
	await app.close();
	app = undefined;
	page = await launch();
	await send(page, restartedRecovery);
	await waitForRecovery(page, "RESTARTED-BRIEF:");
	assert(recoveryRequests >= 2);
	if (evidence) await page.screenshot({ path: join(evidence, "restarted-brief.png") });
	process.stdout.write("Context continuity passed: original brief retained through oversized research history, recovery follow-up, app restart and continued recovery. Synthetic provider/history; real Core and profile persistence.\n");
} finally {
	await app?.close();
	await new Promise(resolveClose => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
