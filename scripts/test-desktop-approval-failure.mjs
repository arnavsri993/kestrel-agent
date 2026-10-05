import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-approval-failure-"));
const evidenceDirectory = process.env.KESTREL_APPROVAL_EVIDENCE_DIR;
if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
const prompt = "Fail approved configuration fixture.";
const receiptPrompt = "Create the isolated browser receipt fixture.";
let taskCalls = 0;
let receiptCalls = 0;
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
		const browserReceipt = String(user?.content ?? "") === receiptPrompt;
		const userIndex = body.messages.findLastIndex(message => message.role === "user");
		const receiptResult = body.messages.slice(userIndex + 1).some(message =>
			message.role === "tool" && message.tool_call_id === "fixture-receipt-call");
		const createBrowser = browserReceipt && !receiptResult;
		if (tool || String(user?.content ?? "") === "Continue with a fresh fixture task.") taskCalls++;
		if (browserReceipt) receiptCalls++;
		if (tool) assert(body.tools.some(item => item.function.name === "agent.config.apply"));
		if (createBrowser) assert(body.tools.some(item => item.function.name === "browser.create"));
		const event = {
			id: "approval-failure-fixture",
			model: "fixture-model",
			choices: [{ index: 0, delta: tool ? {
				content: "Review the deliberately missing fixture proposal.",
				tool_calls: [{ index: 0, id: "fixture-apply-call", type: "function", function: {
					name: "agent.config.apply",
					arguments: JSON.stringify({ proposalId: "missing-fixture-proposal", expectedBaseVersionId: "missing-fixture-version", preview: "Synthetic missing proposal; no configuration change." }),
				} }],
			} : createBrowser ? {
				tool_calls: [{ index: 0, id: "fixture-receipt-call", type: "function", function: {
					name: "browser.create", arguments: JSON.stringify({ allowedOrigins: [`http://127.0.0.1:${server.address().port}`] }),
				} }],
			} : { content: browserReceipt ? "Browser receipt fixture completed." : "Fresh fixture task completed." },
			finish_reason: tool || createBrowser ? "tool_calls" : "stop" }],
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
	const chatToggle = page.locator("#browser-agent-toggle");
	await chatToggle.waitFor();
	if (await chatToggle.getAttribute("aria-expanded") !== "true")
		await chatToggle.click();
	const input = page.locator("#runtime-prompt");
	await input.waitFor();
	const send = page.locator(".agent-conversation-host").getByRole("button", { name: "Send message", exact: true });
	await input.fill(prompt);
	await send.click();
	const approve = page.getByRole("button", { name: "Apply this version", exact: true });
	await approve.waitFor();
	const card = page.locator(".approval-message");
	assert.equal(await card.locator("details[open]").count(), 0);
	assert.equal(await card.getByRole("button", { name: "Reject once", exact: true }).isVisible(), true);
	assert.equal(await card.getByRole("button", { name: "Always allow here", exact: true }).count(), 0, "A protected configuration action must never offer persistent approval.");
	assert.equal(await card.getByRole("button", { name: "Always deny here", exact: true }).isVisible(), false);
	assert.match(await card.locator(".approval-preview").innerText(), /Synthetic missing proposal/);
	for (const width of [1440, 1000]) {
		await page.setViewportSize({ width, height: 900 });
		await card.scrollIntoViewIfNeeded();
		const bounds = await card.locator(".runtime-approval-once button").evaluateAll(buttons => buttons.map(button => { const { x, y, right, width } = button.getBoundingClientRect(); return { x, y, right, width }; }));
		assert.equal(bounds.length, 2);
		assert(Math.abs(bounds[0].y - bounds[1].y) < 2, "One-time approval choices should share a row.");
		assert(bounds.every(bound => bound.width > 0 && bound.x >= 0 && bound.right <= width), "Approval controls must stay within the viewport.");
		if (evidenceDirectory) await page.screenshot({ path: join(evidenceDirectory, `approval-${width}.png`) });
	}
	const choices = card.locator("details").filter({ has: page.locator("summary", { hasText: "Remember a choice" }) });
	await choices.locator("summary").focus();
	await page.keyboard.press("Space");
	assert.equal(await choices.getAttribute("open"), "");
	assert.match(await choices.innerText(), /all requests[\s\S]*in this conversation, including different inputs/);
	assert.equal(await choices.getByRole("button", { name: "Always deny here", exact: true }).isVisible(), true);
	assert.match(await choices.locator("summary").evaluate(element => getComputedStyle(element).outlineStyle), /solid/);
	await choices.locator("summary").focus();
	await page.keyboard.press("Space");
	const exactInput = card.locator("details").filter({ has: page.locator("summary", { hasText: "Plan identifiers and exact input" }) });
	await exactInput.locator("summary").focus();
	await page.keyboard.press("Enter");
	assert.equal(await exactInput.getAttribute("open"), "");
	assert.match(await exactInput.innerText(), /missing-fixture-proposal/);
	assert.match(await exactInput.innerText(), /Policy level/);
	await exactInput.locator("summary").focus();
	await page.keyboard.press("Enter");
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
	const receipts = outcome.locator(".action-receipts");
	await receipts.locator(":scope > summary").focus();
	await page.keyboard.press("Enter");
	assert.match(await receipts.locator(":scope > summary").innerText(), /1 action\b/);
	const currentReceipt = receipts.locator(":scope > .action-receipt-list > .action-receipt");
	assert.equal(await currentReceipt.count(), 1);
	assert.match(await currentReceipt.locator(":scope > header .action-receipt-status").innerText(), /uncertain/i);
	assert.equal(await currentReceipt.locator(":scope > .action-receipt-history").count(), 0,
		"The consumed one-time grant must not look like a second action.");
	await receipts.locator(":scope > summary").focus();
	await page.keyboard.press("Enter");
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
	const assistantMessages = page.locator(".agent-conversation-host .assistant-message[data-runtime-message-id]");
	await assistantMessages.getByText("Fresh fixture task completed.", { exact: true }).waitFor();
	const final = await page.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(final.ok);
	assert.equal(final.sessions.find(item => item.id === session.id).status, "active");
	assert.equal(taskCalls, 2);
	await input.fill(receiptPrompt);
	await send.click();
	const browserPreview = card.getByRole("region", { name: "Action preview", exact: true });
	await browserPreview.waitFor();
	assert.match(await browserPreview.innerText(), /Create an isolated browser session/);
	assert.match(await browserPreview.innerText(), /Allowed sites/);
	assert.equal(await browserPreview.locator("dd").innerText(), `http://127.0.0.1:${server.address().port}`);
	assert.equal(await card.locator("details[open]").count(), 0, "Browser approval technical and persistent choices start closed.");
	const browserInput = card.locator("details").filter({ has: page.locator("summary", { hasText: "Raw tool input" }) });
	await browserInput.locator("summary").focus();
	await page.keyboard.press("Enter");
	assert.deepEqual(JSON.parse(await browserInput.locator("pre").innerText()), { allowedOrigins: [`http://127.0.0.1:${server.address().port}`] });
	await browserInput.locator("summary").focus();
	await page.keyboard.press("Space");
	for (const width of [1440, 1000]) {
		await page.setViewportSize({ width, height: 900 });
		await browserPreview.scrollIntoViewIfNeeded();
		assert(await browserPreview.evaluate(node => {
			const bounds = node.getBoundingClientRect();
			return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
		}), "The complete browser scope must fit inside desktop and compact Chat.");
		if (evidenceDirectory) await page.screenshot({ path: join(evidenceDirectory, `browser-approval-${width}.png`) });
	}
	await page.getByRole("button", { name: "Allow once", exact: true }).click();
	await assistantMessages.getByText("Browser receipt fixture completed.", { exact: true }).waitFor();
	await page.locator(".runtime-stream-preview").waitFor({ state: "detached" });
	const browserReceipts = outcome.locator(".action-receipts");
	await browserReceipts.locator(":scope > summary").focus();
	await page.keyboard.press("Enter");
	assert.match(await browserReceipts.locator(":scope > summary").innerText(), /1 action\b/);
	const browserReceipt = browserReceipts.locator(":scope > .action-receipt-list > .action-receipt");
	assert.equal(await browserReceipt.count(), 1);
	assert.equal(await browserReceipt.locator(":scope > header .action-receipt-status").innerText(), "Verified");
	const history = browserReceipt.locator(":scope > .action-receipt-history");
	assert.equal(await history.getAttribute("open"), null);
	assert.equal(await history.locator(".action-receipt-status").isVisible(), false);
	for (const width of [1440, 1000]) {
		await history.locator(":scope > summary").focus();
		await page.setViewportSize({ width, height: 900 });
		await page.waitForFunction(compact => document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-compact") === compact, width === 1000);
		assert(await history.locator(":scope > summary").evaluate(node => document.activeElement === node),
			"Resizing into compact Chat must preserve the focused receipt disclosure.");
		await page.keyboard.press("Enter");
		assert.equal(await history.locator(".action-receipt-status").innerText(), "Waiting for approval");
		assert.match(await history.locator(":scope > summary").evaluate(element => getComputedStyle(element).boxShadow), /rgba?\(/);
		assert(await browserReceipt.evaluate(node => {
			const bounds = node.getBoundingClientRect();
			return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth;
		}), "The action and history must fit inside desktop and compact Chat.");
		if (evidenceDirectory) await page.screenshot({ path: join(evidenceDirectory, `action-receipt-history-${width}.png`) });
		await history.locator(":scope > summary").focus();
		await page.keyboard.press("Space");
		assert.equal(await history.getAttribute("open"), null);
	}
	const recordedReceipts = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-action-receipts", sessionId }), session.id);
	assert(recordedReceipts.ok);
	assert.equal(recordedReceipts.receipts.filter(receipt => receipt.toolName === "browser.create").length, 2,
		"Grouping the visible result must preserve both bounded core receipts.");
	assert.equal(receiptCalls, 2);
	const handoff = page.locator(".runtime-activity-handoff");
	assert.match(await handoff.innerText(), /^Create browser session verified\./);
	assert.doesNotMatch(await handoff.innerText(), /browser\.create/);
	const observed = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-executions", sessionId }), session.id);
	assert(observed.ok);
	const verifiedBrowser = observed.executions.filter(item => item.toolName === "browser.create" && item.status === "verified");
	assert.equal(verifiedBrowser.length, 1);
	await handoff.getByRole("button", { name: "View evidence in Activity", exact: true }).click();
	await page.locator(`#activity-item-${verifiedBrowser[0].id}.activity-item-focused`).waitFor();
	assert.deepEqual(providerErrors, []);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write("Desktop approval failure passed: compact one-time controls at 1440/1000, keyboard disclosures with exact scope/input, protected persistent-approval exclusion, visible error, retired stale control, no replay, reusable session, and one current browser action with preserved keyboard-accessible history. Provider: deterministic HTTP fixture; profile: disposable; no real model generation.\n");
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
