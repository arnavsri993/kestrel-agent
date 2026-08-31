import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-workflow-reuse-"));
const userData = join(root, "user-data");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];

let providerCalls = 0;
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
		providerCalls += 1;
		const userMessage = [...(body.messages ?? [])]
			.reverse()
			.find((message) => message.role === "user");
		assert.ok(userMessage, "fixture request did not include the task");
		const event = {
			id: `workflow-reuse-fixture-${providerCalls}`,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					delta: {
						content:
							"Completed the requested review checklist with a concise, repeatable sequence.",
					},
					finish_reason: "stop",
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
const runtimeErrors = [];
try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			NOUS_API_KEY: "local-test-credential",
			NOUS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			NOUS_MODEL: "fixture-model",
		},
	});
	const page = await application.firstWindow();
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
	await page.locator("#runtime-prompt").waitFor();

	await page.getByRole("button", { name: /^Model:/ }).click();
	const modelMenu = page.getByRole("dialog", {
		name: "Choose provider, model, and thinking level",
	});
	await modelMenu.getByRole("button", { name: /^Nous/ }).click();
	await modelMenu.getByLabel("Custom model ID").fill("fixture-model");
	await modelMenu.getByLabel("Custom model ID").press("Enter");
	await modelMenu.waitFor({ state: "detached" });

	const task = "Create a concise checklist for reviewing pull requests.";
	await page.getByRole("textbox", { name: "Message Kestrel" }).fill(task);
	await page
		.locator(".agent-conversation-host")
		.getByRole("button", { name: "Send message", exact: true })
		.click();
	await page.getByText("Completed the requested review checklist", { exact: false }).waitFor();
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

	await page.getByRole("heading", { name: "Memory and learning", exact: true }).waitFor();
	await selectSettingsSection(page, "intelligence", "Memory");
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
	assert.equal(providerErrors.length, 0, providerErrors.join("\n"));
	assert.ok(providerCalls >= 1, "fixture provider did not complete the task");
	assert.deepEqual(runtimeErrors, [], runtimeErrors.join("\n"));
	process.stdout.write("Workflow reuse save, review navigation, proposal focus, and desktop error smoke passed.\n");
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
