import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-approval-failure-"));
const prompt = "Fail approved configuration fixture.";
let taskCalls = 0;
const providerErrors = [];
const server = createServer(async (request, response) => {
	try {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }),
			);
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const user = [...(body.messages ?? [])].reverse().find(message => message.role === "user");
		const tool = String(user?.content ?? "") === prompt;
		if (tool || String(user?.content ?? "") === "Continue with a fresh fixture task.") taskCalls++;
		if (tool) assert(body.tools.some(item => item.function.name === "agent.config.apply"));
		const event = {
			id: "approval-failure-fixture",
			model: "fixture-model",
			choices: [{ index: 0, delta: tool ? {
				content: "Review the deliberately missing fixture proposal.",
				tool_calls: [{ index: 0, id: "fixture-apply-call", type: "function", function: {
					name: "agent.config.apply",
					arguments: JSON.stringify({ proposalId: "missing-fixture-proposal", expectedBaseVersionId: "missing-fixture-version", preview: "Synthetic missing proposal; no configuration change." }),
				} }],
			} : { content: "Fresh fixture task completed." }, finish_reason: tool ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 2 },
		};
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
			.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
	} catch (error) {
		providerErrors.push(String(error));
		response.writeHead(500).end("Fixture provider failed.");
	}
});
await new Promise((resolveListen, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolveListen);
});
let application;
let page;
const runtimeErrors = [];
try {
	const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE;
	application = await electron.launch({
		...(executablePath ? { executablePath } : {}),
		args: [...(executablePath ? [] : [resolve("apps/desktop/out/main/index.js")]), "--use-mock-keychain"],
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: join(root, "profile"),
			KESTREL_REAL_USER_PROFILE: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			NOUS_API_KEY: "synthetic-local-fixture",
			NOUS_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
			NOUS_MODEL: "fixture-model",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(20_000);
	page.on("pageerror", error => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:execution-mode", "manual");
		localStorage.setItem("kestrel:provider-id", "nous");
		localStorage.setItem("kestrel:model", "fixture-model");
		localStorage.setItem("kestrel:reasoning-effort", "none");
	});
	await page.reload();
	const input = page.locator("#runtime-prompt");
	await input.waitFor();
	const send = page.locator(".agent-conversation-host").getByRole("button", { name: "Send message", exact: true });
	await input.fill(prompt);
	await send.click();
	const approve = page.getByRole("button", { name: "Apply this version", exact: true });
	await approve.waitFor();
	const before = await page.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(before.ok);
	const session = before.sessions.find(item => item.title.includes("configuration fixture"));
	assert(session, "The fixture conversation was not created.");
	const runs = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-runs", sessionId }), session.id);
	assert(runs.ok);
	const pending = runs.runs.find(run => run.status === "waiting_approval");
	assert(pending, "The real core never reached its approval boundary.");
	await approve.focus();
	await page.keyboard.press("Enter");
	const outcome = page.getByRole("region", { name: "Latest task outcome" });
	await outcome.getByRole("status").getByText(/(?:proposal|plan).*not found/i).waitFor();
	await approve.waitFor({ state: "detached" });
	if (process.env.KESTREL_APPROVAL_FAILURE_SCREENSHOT)
		await page.screenshot({ path: process.env.KESTREL_APPROVAL_FAILURE_SCREENSHOT });
	const after = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-runs", sessionId }), session.id);
	assert(after.ok);
	const failed = after.runs.find(run => run.id === pending.id);
	assert.equal(failed.status, "failed");
	assert.equal(failed.pendingToolExecutionId, undefined);
	const executions = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-executions", sessionId }), session.id);
	assert(executions.ok);
	assert.equal(executions.executions.filter(item => item.toolName === "agent.config.apply" && item.status === "failed").length, 1);
	assert.equal(executions.executions.find(item => item.id === pending.pendingToolExecutionId).output.approvalRequired, false);
	const executionIds = executions.executions.map(item => item.id).sort();
	const stale = await page.evaluate(runId => window.kestrel.request({ type: "runtime-resume-agent", runId, approvalDecision: "approved" }), pending.id);
	assert.equal(stale.ok, false);
	assert.match(stale.error, /not waiting at an approval boundary/i);
	const afterStale = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-executions", sessionId }), session.id);
	assert(afterStale.ok);
	assert.deepEqual(afterStale.executions.map(item => item.id).sort(), executionIds, "A stale approval must not create another execution.");
	assert.equal(taskCalls, 1, "A failed approved action must not be automatically replayed.");
	await input.fill("Continue with a fresh fixture task.");
	await send.click();
	await page.locator(".agent-conversation-host").getByText("Fresh fixture task completed.", { exact: true }).waitFor();
	const final = await page.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(final.ok);
	assert.equal(final.sessions.find(item => item.id === session.id).status, "active");
	assert.equal(taskCalls, 2);
	assert.deepEqual(providerErrors, []);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write("Desktop approval failure passed: keyboard approval, visible error, retired stale control, no replay, and reusable session. Provider: local HTTP fixture; profile: disposable.\n");
} catch (error) {
	if (page && process.env.KESTREL_APPROVAL_FAILURE_SCREENSHOT) {
		await page.screenshot({ path: process.env.KESTREL_APPROVAL_FAILURE_SCREENSHOT });
		console.error(await page.locator(".agent-conversation-host").innerText());
	}
	throw error;
} finally {
	await application?.close();
	await new Promise(resolveClose => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
