import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-chat-configuration-"));
const userData = join(root, "user-data");
const reviewScreenshot = resolve(
	"artifacts/screenshots/desktop/setup-revised/chat-configuration-review.png",
);
const appliedScreenshot = resolve(
	"artifacts/screenshots/desktop/setup-revised/chat-configuration-applied.png",
);
mkdirSync(dirname(reviewScreenshot), { recursive: true });

let providerCalls = 0;
const providerErrors = [];
const server = createServer(async (request, response) => {
	try {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					data: [{ id: "fixture-model", object: "model" }],
				}),
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
		providerCalls += 1;
		const tools = new Set(
			(body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean),
		);
		assert.equal(tools.has("agent.config.inspect"), true);
		assert.equal(tools.has("agent.config.plan"), true);
		assert.equal(tools.has("agent.config.apply"), true);

		let text;
		let toolCall;
		if (providerCalls === 1) {
			assert.equal(
				body.messages.some(
					(message) =>
						message.role === "system" &&
						String(message.content).includes(
							"self-configuration as a reviewable transaction",
						),
				),
				true,
			);
			text =
				"I’ll inspect the editable chat and behavior surfaces before proposing anything.";
			toolCall = {
				id: "visual-inspect-call",
				name: "agent.config.inspect",
				arguments: { query: "response style chat density" },
			};
		} else if (providerCalls === 2) {
			text =
				"Both settings are editable. I’m staging the exact candidate and running its isolated checks now.";
			toolCall = {
				id: "visual-plan-call",
				name: "agent.config.plan",
				arguments: {
					requestSummary: "Use concise replies and compact chat density.",
					patch: [
						{
							op: "replace",
							path: "/behavior/responseStyle",
							value: "concise",
						},
						{
							op: "replace",
							path: "/ui/density",
							value: "compact",
						},
					],
				},
			};
		} else if (providerCalls === 3) {
			const lastToolMessage = [...body.messages]
				.reverse()
				.find((message) => message.role === "tool");
			const proposal = JSON.parse(lastToolMessage.content).output.proposal;
			text =
				"The live agent is unchanged. The typed schema, secret scan, protected boundary, recovery path, subsystem checks, and round-trip simulation passed. Review this exact diff before applying it.";
			toolCall = {
				id: "visual-apply-call",
				name: "agent.config.apply",
				arguments: {
					proposalId: proposal.id,
					expectedBaseVersionId: proposal.baseVersionId,
					preview: proposal.diff,
				},
			};
		} else {
			text =
				"The concise response style and compact chat density are verified and active. The prior version remains available as the undo target.";
		}

		const delta = {
			...(text ? { content: text } : {}),
			...(toolCall
				? {
						tool_calls: [
							{
								index: 0,
								id: toolCall.id,
								type: "function",
								function: {
									name: toolCall.name,
									arguments: JSON.stringify(toolCall.arguments),
								},
							},
						],
					}
				: {}),
		};
		const event = {
			id: `fixture-response-${providerCalls}`,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					delta,
					finish_reason: toolCall ? "tool_calls" : "stop",
				},
			],
			usage: { prompt_tokens: 20, completion_tokens: 12 },
		};
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
	} catch (error) {
		providerErrors.push(error instanceof Error ? error.message : String(error));
		response.writeHead(500, { "content-type": "text/plain" });
		response.end("fixture provider failed");
	}
});

await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");

const runtimeErrors = [];
let application;

async function launch() {
	application = await electron.launch({
		args: [resolve("apps/desktop/out/main/index.js")],
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_USER_DATA: userData,
			NOUS_API_KEY: "local-test-credential",
			NOUS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			NOUS_MODEL: "fixture-model",
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(15_000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	return page;
}

try {
	let page = await launch();
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	await page.evaluate(async () => {
		const snapshot = await window.kestrel.request({ type: "snapshot" });
		if (!snapshot.ok || !snapshot.snapshot)
			throw new Error("The initial fixture snapshot is unavailable.");
		for (const approval of snapshot.snapshot.approvals.filter(
			(candidate) => candidate.status === "pending",
		)) {
			const rejected = await window.kestrel.request({
				type: "reject",
				approvalId: approval.id,
			});
			if (!rejected.ok) throw new Error(rejected.error);
		}
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	assert.equal(
		(
			await page.locator(".agent-task-line .ui-status > span").textContent()
		)?.trim(),
		"Ready",
	);

	await page.locator('summary[aria-label="Task settings"]').click();
	await page.getByLabel("Execution").selectOption("manual");
	await page
		.locator(".runtime-task-controls label", { hasText: /^Provider/ })
		.locator("select")
		.selectOption("nous");
	await page
		.locator(".runtime-task-controls label", { hasText: /^Model/ })
		.locator("input")
		.fill("fixture-model");
	await page.locator('summary[aria-label="Task settings"]').click();
	await page
		.getByRole("textbox", { name: "Message Kestrel" })
		.fill("Use concise replies and a compact chat layout from now on.");
	await page.getByRole("button", { name: "Send message" }).click();

	await page.getByText("Configuration plan staged", { exact: true }).waitFor();
	const applyButton = page.getByRole("button", {
		name: "Apply this version",
		exact: true,
	});
	await applyButton.waitFor();
	assert.equal(
		await page
			.getByRole("button", { name: "Always allow here", exact: true })
			.count(),
		0,
	);
	await page
		.locator(".configuration-plan")
		.getByText("Review exact diff", { exact: true })
		.click();
	await page
		.locator(".configuration-plan")
		.getByText("/behavior/responseStyle", { exact: false })
		.waitFor();
	await page
		.locator(".configuration-plan")
		.getByText("Review exact diff", { exact: true })
		.click();
	await page
		.locator(".approval-message")
		.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await page.screenshot({ path: reviewScreenshot });

	await applyButton.click();
	const appliedCard = page.locator(".configuration-applied");
	await appliedCard
		.getByText("Configuration verified and active", { exact: true })
		.waitFor();
	await appliedCard.scrollIntoViewIfNeeded();
	const session = await page.evaluate(async () => {
		const sessions = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		if (!sessions.ok || !sessions.sessions?.length)
			throw new Error("The configuration chat session is unavailable.");
		return {
			id: sessions.sessions[0].id,
			title: sessions.sessions[0].title,
		};
	});
	const inspection = await page.evaluate(async (currentSessionId) => {
		const result = await window.kestrel.request({
			type: "runtime-call-tool",
			sessionId: currentSessionId,
			toolName: "agent.config.inspect",
			input: {},
		});
		if (!result.ok || result.execution?.status !== "verified")
			throw new Error("The applied configuration could not be read back.");
		return result.execution.output?.inspection;
	}, session.id);
	assert.equal(inspection.current.behavior.responseStyle, "concise");
	assert.equal(inspection.current.ui.density, "compact");
	assert.equal(
		await page.locator(".ai-browser-app.configuration-density-compact").count(),
		1,
	);

	const prepareUndo = appliedCard.getByRole("button", {
		name: "Prepare undo",
		exact: true,
	});
	await prepareUndo.click();
	const composer = page.getByRole("textbox", { name: "Message Kestrel" });
	assert.match(await composer.inputValue(), /^Restore configuration version /);
	await page.waitForFunction(
		() => document.activeElement?.getAttribute("id") === "runtime-prompt",
	);
	assert.equal(
		await composer.evaluate((element) => document.activeElement === element),
		true,
	);
	await page
		.locator(".agent-conversation-host .message-list")
		.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
	await page.waitForFunction(
		() =>
			document
				.querySelector(".agent-task-line .ui-status > span")
				?.textContent?.trim()
				.toLowerCase() === "ready",
	);
	await page.screenshot({ path: appliedScreenshot });

	const snapshot = await page.evaluate(() =>
		window.kestrel.request({ type: "snapshot" }),
	);
	assert.equal(snapshot.ok, true);
	assert.equal(snapshot.snapshot.configuration.sequence, 2);

	await application.close();
	application = undefined;
	page = await launch();
	await page
		.locator(".agent-sidebar-history-list > button")
		.filter({ hasText: session.title })
		.click();
	await page
		.locator(".configuration-applied")
		.getByText("Configuration verified and active", { exact: true })
		.waitFor();
	assert.equal(
		await page.locator(".ai-browser-app.configuration-density-compact").count(),
		1,
	);
	assert.equal(
		(
			await page.locator(".agent-task-line .ui-status > span").textContent()
		)?.trim(),
		"Ready",
	);
	await page
		.locator(".configuration-applied")
		.getByRole("button", { name: "Prepare undo", exact: true })
		.waitFor();

	const dimensions = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: window.innerWidth,
	}));
	assert.ok(
		dimensions.documentWidth <= dimensions.viewportWidth,
		`Configuration chat overflowed: ${JSON.stringify(dimensions)}`,
	);
	assert.equal(providerCalls, 4);
	assert.deepEqual(providerErrors, []);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		`Chat configuration inspect, isolated plan, exact approval, verified apply, undo preparation, restart persistence, and rendered ledger passed. Screenshots: ${reviewScreenshot}, ${appliedScreenshot}\n`,
	);
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
