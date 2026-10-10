import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-workflow-reuse-"));
const userData = join(root, "user-data");
const fixtureHome = join(root, "home");
mkdirSync(fixtureHome, { recursive: true });
const evidence = process.env.KESTREL_WORKFLOW_REUSE_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop"), "--use-mock-keychain"];

let providerCalls = 0;
const task = "Create a concise checklist for reviewing pull requests.";
const hostEnvironment = Object.fromEntries(
	["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "DISPLAY"].flatMap(
		key => process.env[key] ? [[key, process.env[key]]] : [],
	),
);
const providerErrors = [];
const server = createServer(async (request, response) => {
	try {
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
		const userMessage = [...(body.messages ?? [])]
			.reverse()
			.find((message) => message.role === "user");
		assert.ok(userMessage, "fixture request did not include the task");
		const isTask = String(userMessage.content).includes(task);
		if (isTask) providerCalls += 1;
		const toolCall = isTask && providerCalls <= 3;
		if (isTask && providerCalls > 1) {
			const result = [...body.messages].reverse().find(message => message.role === "tool");
			assert.equal(result?.tool_call_id, "workflow-search", "The prior observed call must have a paired result");
			assert.equal(JSON.parse(result.content).status, "verified", "The catalog lookup must execute successfully");
		}
		const delta = toolCall
			? { tool_calls: [{
				index: 0, id: "workflow-search", type: "function",
				function: {
					name: "tools.search",
					arguments: JSON.stringify({ query: ["review", "git", "review"][providerCalls - 1] }),
				},
			}] }
			: { content: isTask ? "Completed the requested review checklist with a concise, repeatable sequence." : "Ready." };
		const event = {
			id: `workflow-reuse-fixture-${providerCalls}`,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					delta,
					finish_reason: toolCall ? "tool_calls" : "stop",
				},
			],
			usage: { prompt_tokens: 24, completion_tokens: 12 },
		};
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
	} catch (error) {
		providerErrors.push(error instanceof Error ? error.message : String(error));
		if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
		response.end("fixture provider failed");
	}
});

await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");

let application;
let page;
const runtimeErrors = [];
try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...hostEnvironment,
			HOME: fixtureHome,
			CODEX_HOME: join(fixtureHome, ".codex"),
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			NOUS_API_KEY: "local-test-credential",
			NOUS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			NOUS_MODEL: "fixture-model",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	const chatToggle = page.locator("#browser-agent-toggle");
	await chatToggle.waitFor();
	if (await chatToggle.getAttribute("aria-expanded") !== "true") await chatToggle.click();
	await page.locator("#runtime-prompt").waitFor();

	// Auto has only the isolated loopback provider; host credentials are excluded.
	await page.getByRole("textbox", { name: "Message Kestrel" }).fill(task);
	await page
		.locator(".agent-conversation-host")
		.getByRole("button", { name: "Send message", exact: true })
		.click();
	await page.getByText("Completed the requested review checklist", { exact: false }).waitFor();
	const workflow = page.locator(".agent-conversation-host .workflow-memory-action");
	const summary = workflow.locator("summary");
	if (await summary.count()) await summary.press("Enter");
	await workflow.getByText("Create a draft from this request and observed tool calls. Review before installing.", { exact: true }).waitFor();
	if (evidence) await page.screenshot({ path: join(evidence, "workflow-draft.png") });
	await page.getByRole("button", { name: "Save as skill", exact: true }).click();

	const notice = page.locator(".skill-notice");
	await notice.getByRole("status").waitFor();
	const proposalName = (await notice.locator("strong").textContent())?.trim();
	assert.ok(proposalName, "skill success notice did not include the created proposal name");
	const proposalId = await notice.getAttribute("data-skill-proposal-id");
	assert.match(
		proposalId ?? "",
		/^skill-proposal-[a-f0-9-]{36}$/,
		"skill success notice did not identify the created proposal",
	);
	await notice.getByRole("button", { name: "Review skill", exact: true }).click();

	await page.getByRole("heading", { name: "Plugins and publishers", exact: true }).waitFor();
	await selectSettingsSection(page, "extensions", "Plugins");
	const proposalDetails = page.locator(
		`details[data-skill-proposal-id="${proposalId}"]`,
	);
	await proposalDetails.waitFor();
	await page.waitForFunction(
		(id) => {
			const details = [...document.querySelectorAll("details")].find((candidate) =>
				candidate.dataset.skillProposalId === id,
			);
			return details?.open === true && details.querySelector("summary") === document.activeElement;
		},
		proposalId,
	);
	const instructions = await proposalDetails.locator("pre").textContent();
	assert.match(instructions ?? "", /Observed tool sequence \(names only\): tools\.search → tools\.search → tools\.search/);
	assert.doesNotMatch(instructions ?? "", /approved task|successful workflow/);
	assert.match(await proposalDetails.locator("p").textContent() ?? "", /^Draft a workflow from this source request:/);
	await proposalDetails.getByRole("button", { name: "Install learned skill", exact: true }).waitFor();
	if (evidence) await page.screenshot({ path: join(evidence, "workflow-proposal.png") });
	assert.equal(providerErrors.length, 0, providerErrors.join("\n"));
	assert.equal(providerCalls, 4, "The fixture must finish three observed calls and one response");
	assert.deepEqual(runtimeErrors, [], runtimeErrors.join("\n"));
	process.stdout.write("Workflow reuse preserves repeated paired tool calls, draft review, proposal focus, and desktop error smoke passed.\n");
} catch (error) {
	process.stderr.write(`${JSON.stringify({ providerCalls, providerErrors, runtimeErrors })}\n`);
	if (page && evidence) await page.screenshot({ path: join(evidence, "workflow-failure.png") }).catch(() => {});
	throw error;
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
