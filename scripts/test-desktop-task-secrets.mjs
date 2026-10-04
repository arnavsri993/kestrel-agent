import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

assert.equal(process.platform, "darwin", "The real command sandbox smoke requires macOS.");
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const executablePath = packagedExecutable ? resolve(packagedExecutable) : requireFromDesktop("electron");
if (!packagedExecutable) {
	assert.ok(existsSync(resolve("apps/desktop/out/main/index.js")), "Build the desktop app before running the smoke, or set KESTREL_DESKTOP_EXECUTABLE.");
}
assert.ok(existsSync(executablePath), "The selected desktop executable does not exist.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-task-secrets-desktop-")));
const workspace = join(root, "workspace");
mkdirSync(workspace);
const proofPath = join(workspace, "proof.json");
const syntheticKey = `sk-proj-kestrel-smoke-${randomBytes(20).toString("hex")}`;
const encodedKey = Buffer.from(syntheticKey).toString("base64");
const expectedDigest = createHash("sha256").update(syntheticKey).digest("hex");
const screenshotPath = process.env.KESTREL_TASK_SECRETS_SCREENSHOT;
const fixtureModel = "task-secret-fixture";
const completionText = "The isolated fixture command completed. Credential file retention is a separate check.";
const providerErrors = [];
let taskCalls = 0;
let protectedRef;
let sawWithheldOutput = false;
let application;
let page;

function assertNoFixtureDisclosure(value, boundary) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	assert.ok(!text.includes(syntheticKey), `${boundary} disclosed the synthetic credential.`);
	assert.ok(!text.includes(encodedKey), `${boundary} disclosed the encoded synthetic credential.`);
}

// No credential bytes are written to files. The child deliberately attempts
// stdout/stderr disclosure to test the production output-withholding boundary.
const proofProgram = `const fs=require('node:fs');const crypto=require('node:crypto');
const value=process.env.SERVICE_API_KEY;
if(!value)process.exit(9);
const child=require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)']);
fs.writeFileSync('proof.json',JSON.stringify({digest:crypto.createHash('sha256').update(value).digest('hex'),selectedEnvironmentOnly:process.env.KESTREL_SMOKE_UNSELECTED_API_KEY===undefined,descendantDenied:!!child.error,childError:child.error?.code}));
process.stdout.write(value);process.stderr.write(Buffer.from(value).toString('base64'));`;

function sendCompletion(response, text, toolCall) {
	const delta = {
		content: text,
		...(toolCall ? { tool_calls: [{ index: 0, id: "task-secret-smoke-command", type: "function", function: { name: "execution.run-with-secrets", arguments: JSON.stringify(toolCall) } }] } : {}),
	};
	const event = { id: "task-secret-smoke", model: fixtureModel, choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 8, completion_tokens: 8 } };
	response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
	response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}

const server = createServer(async (request, response) => {
	try {
		assert.equal(request.headers.authorization ?? "", "", "Loopback provider must not receive account credentials.");
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: fixtureModel, object: "model" }] }));
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const wire = Buffer.concat(chunks).toString("utf8");
		assertNoFixtureDisclosure(wire, "Provider request");
		const body = JSON.parse(wire);
		const system = String(body.messages?.find(message => message.role === "system")?.content ?? "");
		if (system.includes("one-line welcome shown on Kestrel's New Tab")) {
			sendCompletion(response, "What should we get done?");
			return;
		}
		taskCalls += 1;
		assert.ok(taskCalls <= 2, "The fixture task exceeded its bounded provider turn count.");
		if (taskCalls === 1) {
			const user = body.messages?.find(message => message.role === "user");
			const refs = JSON.stringify(user?.content ?? "").match(/\[TASK_SECRET:(task-secret-[a-f0-9-]{36})\]/g) ?? [];
			assert.equal(refs.length, 2, "Both occurrences must reach the provider as opaque references.");
			assert.equal(new Set(refs).size, 1, "Repeated credential input must share one reference.");
			protectedRef = refs[0].slice("[TASK_SECRET:".length, -1);
			assert.ok(body.tools?.some(tool => tool.function?.name === "execution.run-with-secrets"), `The protected execution tool must be offered. Offered: ${(body.tools ?? []).map(tool => tool.function?.name).join(",")}`);
			sendCompletion(response, "Approve one isolated fixture command. It writes only proof.json in the granted disposable workspace; it does not configure a CLI login.", {
				command: "node", args: ["-e", proofProgram], cwd: ".", timeoutMs: 10_000, secretEnvironment: { SERVICE_API_KEY: protectedRef },
			});
		} else {
			const toolMessage = [...body.messages].reverse().find(message => message.role === "tool");
			assert.ok(toolMessage, "Resume must send the completed tool result to the provider.");
			const result = JSON.parse(toolMessage.content);
			assert.equal(result.output?.outputWithheld, true);
			assert.equal(result.output?.stdout, "");
			assert.equal(result.output?.stderr, "");
			assert.equal(result.output?.exitCode, 0);
			sawWithheldOutput = true;
			sendCompletion(response, completionText);
		}
	} catch (error) {
		// Assertion diffs must never become a second disclosure channel.
		providerErrors.push(String(error.message).replaceAll(syntheticKey, "[REDACTED]").replaceAll(encodedKey, "[REDACTED]"));
		response.writeHead(500, { "content-type": "text/plain" });
		response.end("fixture provider boundary assertion failed");
	}
});

async function request(page, input) {
	const result = await page.evaluate(input => window.kestrel.request(input), input);
	assert.ok(result.ok, `Desktop request ${input.type} failed.`);
	return result;
}

async function sessionEvidence(page, sessionId) {
	const results = await Promise.all([
		request(page, { type: "runtime-list-sessions" }),
		request(page, { type: "runtime-list-messages", sessionId }),
		request(page, { type: "runtime-list-runs", sessionId }),
		request(page, { type: "runtime-list-executions", sessionId }),
		request(page, { type: "runtime-list-action-receipts", sessionId }),
	]);
	assertNoFixtureDisclosure(results, "Persisted session evidence");
	return { session: results[0].sessions?.find(item => item.id === sessionId), messages: results[1].messages ?? [], runs: results[2].runs ?? [], executions: results[3].executions ?? [], receipts: results[4].receipts ?? [] };
}

try {
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const launchEnvironment = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
	application = await electron.launch({
		executablePath,
		args: packagedExecutable ? ["--use-mock-keychain"] : [resolve("apps/desktop"), "--use-mock-keychain"],
		env: { ...launchEnvironment, KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_TEST_USER_DATA: join(root, "user-data"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1", KESTREL_SMOKE_UNSELECTED_API_KEY: "synthetic-ambient-must-not-reach-child" },
	});
	page = await application.firstWindow();
	// CI's smaller macOS display can start below the New Tab control breakpoint.
	// This security flow uses the complete composer; compact Chat has a separate
	// layout audit. Keep the native sandbox and all retention assertions intact.
	await page.setViewportSize({ width: 1440, height: 900 });
	page.setDefaultTimeout(30_000);
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#new-tab-chat-input").waitFor();
	await request(page, { type: "provider-account-create", account: { providerId: "task-secret-fixture", adapter: "openai-compatible", displayName: "Task secret fixture", authTransport: "local", enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: fixtureModel, headers: [] } });
	const providers = await request(page, { type: "runtime-list-providers" });
	const account = providers.providerAccounts?.find(item => item.displayName === "Task secret fixture");
	assert.ok(account, "The local fixture provider account is unavailable.");
	await page.evaluate(account => {
		localStorage.setItem("kestrel:execution-mode", "manual");
		localStorage.setItem("kestrel:provider-id", account.endpointId);
		localStorage.setItem("kestrel:provider-account-id", account.id);
		localStorage.setItem("kestrel:model", "task-secret-fixture");
	}, account);
	await page.reload();
	const input = page.locator("#new-tab-chat-input");
	await input.waitFor();
	// The composer renders before its provider-account request has resolved.
	await page.getByRole("button", { name: `Model: ${fixtureModel}`, exact: true }).waitFor();
	await input.focus();
	await application.evaluate(({ dialog }, destination) => {
		const original = dialog.showOpenDialog;
		let calls = 0;
		const selection = new Promise(resolveSelection => {
			globalThis.__releaseTaskSecretDialog = () => {
				delete globalThis.__releaseTaskSecretDialog;
				resolveSelection({ canceled: false, filePaths: [destination] });
			};
		});
		dialog.showOpenDialog = async (...args) => {
			calls += 1;
			if (calls === 1) return selection;
			dialog.showOpenDialog = original;
			return { canceled: true, filePaths: [] };
		};
	}, workspace);
	await input.fill("Run the local fixture proof.");
	await page.getByRole("button", { name: "Add files", exact: true }).click();
	await expect(page.getByRole("button", { name: /^Send message to / })).toBeDisabled();
	await application.evaluate(() => globalThis.__releaseTaskSecretDialog());
	await expect.poll(async () => (await request(page, { type: "get-workspace-grants" })).projects?.some(project => project.path === workspace), { timeout: 30_000 }).toBe(true);
	await page.getByRole("button", { name: /^Approval policy:/ }).click();
	await page.getByRole("menuitemradio", { name: /^Full access/ }).click();
	await input.fill(`API_KEY=${syntheticKey}; run the local fixture proof with this same value ${syntheticKey}.`);
	await expect(page.getByRole("button", { name: /^Send message to / })).toBeEnabled();
	await page.getByRole("button", { name: /^Send message to / }).click();
	const approval = page.locator(".approval-message");
	await approval.getByRole("button", { name: "Allow once", exact: true }).waitFor();
	assert.equal(await approval.getByRole("button", { name: "Always allow here", exact: true }).count(), 0, "Temporary credential execution cannot have a persistent allow option.");
	assert.equal(taskCalls, 1, "The task must pause before a second provider turn.");
	assert.equal(existsSync(proofPath), false, "The command ran before one-time approval.");
	const sessions = await request(page, { type: "runtime-list-sessions" });
	const session = sessions.sessions?.find(item => item.workspaceRoot === workspace);
	assert.ok(session, "The UI did not create the fixture task.");
	assert.equal(session.approvalPolicy, "full_access");
	assertNoFixtureDisclosure(session.title, "Generated chat title");
	assert.ok(session.title.includes("[REDACTED]"), "The generated chat title must mask the key.");
	const pending = await sessionEvidence(page, session.id);
	assert.equal(pending.runs[0]?.status, "waiting_approval");
	assert.equal(pending.executions.find(item => item.toolName === "execution.run-with-secrets")?.output?.persistentApprovalAllowed, false);
	assert.ok(!pending.messages.some(message => message.content.includes("Temporary credential cleanup verified")), "Cleanup must not be claimed while the credential is retained for approval.");
	assertNoFixtureDisclosure(await page.locator("body").innerText(), "Visible approval and transcript");
	await page.evaluate(() => {
		window.__taskSecretSmokeEvents = [];
		window.kestrel.onRuntimeEvent(event => window.__taskSecretSmokeEvents.push(event));
	});
	await approval.getByRole("button", { name: "Allow once", exact: true }).click();
	await page.getByText(completionText, { exact: true }).waitFor();
	await page.getByText(/Temporary credential cleanup verified: 1 credential\(s\) removed/).waitFor();
	const completed = await sessionEvidence(page, session.id);
	assert.equal(completed.runs[0]?.status, "completed");
	const execution = completed.executions.find(item => item.toolName === "execution.run-with-secrets" && item.status === "verified");
	assert.ok(execution, "The real protected command did not complete.");
	assert.equal(execution.output?.outputWithheld, true);
	assert.equal(execution.output?.stdout, "");
	assert.equal(execution.output?.stderr, "");
	assert.equal(execution.output?.exitCode, 0);
	const proof = JSON.parse(readFileSync(proofPath, "utf8"));
	assert.equal(proof.digest, expectedDigest, "The selected credential was not delivered to the sandbox child.");
	assert.equal(proof.selectedEnvironmentOnly, true);
	assert.equal(proof.descendantDenied, true);
	assert.ok(["EPERM", "EACCES"].includes(proof.childError));
	assertNoFixtureDisclosure(proof, "Workspace proof file");
	const receipt = completed.messages.find(message => message.content.includes("Temporary credential cleanup verified"));
	assert.ok(receipt);
	assert.match(receipt.content, /0 remain/);
	assert.match(receipt.content, /temporary credential store only/);
	assert.match(receipt.content, /does not verify CLI files, other apps, provider retention, backups, or forensic erasure/);
	const events = await page.evaluate(() => window.__taskSecretSmokeEvents);
	assertNoFixtureDisclosure(events, "Renderer runtime events");
	assert.ok(!events.some(event => event.type === "tool.progress" && event.executionId === execution.id), "Protected child output must never stream as progress.");
	assertNoFixtureDisclosure(await page.locator("body").innerText(), "Visible completed transcript");
	assert.equal(taskCalls, 2);
	assert.equal(sawWithheldOutput, true);
	assert.deepEqual(providerErrors, []);
	if (screenshotPath) {
		mkdirSync(dirname(resolve(screenshotPath)), { recursive: true });
		await page.getByText(/Temporary credential cleanup verified: 1 credential\(s\) removed/).scrollIntoViewIfNeeded();
		await page.screenshot({ path: resolve(screenshotPath), fullPage: true, animations: "disabled" });
	}
	// Reload checks durable sanitized history and the visible checked receipt.
	await page.reload();
	await page.getByText(/Temporary credential cleanup verified: 1 credential\(s\) removed/).waitFor();
	await sessionEvidence(page, session.id);
	assertNoFixtureDisclosure(await page.locator("body").innerText(), "Reloaded chat history");
	process.stdout.write(`Task credential desktop smoke passed against ${packagedExecutable ? "the selected packaged/installed app" : "the built desktop app"}: opaque provider input, fresh approval under Full access, real sandbox delivery, withheld output, sanitized history/title, and scoped cleanup receipt.\n`);
} catch (error) {
	const diagnostic = { taskCalls, providerErrors, sawWithheldOutput };
	if (page) {
		try {
			const sessions = (await request(page, { type: "runtime-list-sessions" })).sessions ?? [];
			diagnostic.sessions = await Promise.all(sessions.map(async session => ({
				workspaceMatches: session.workspaceRoot === workspace,
				runs: ((await request(page, { type: "runtime-list-runs", sessionId: session.id })).runs ?? [])
					.map(run => ({ status: run.status, model: run.model, error: run.error })),
			})));
			diagnostic.visibleErrors = await page.locator('[role="alert"], .error-message, .error-banner').allTextContents();
		} catch { diagnostic.evidenceUnavailable = true; }
	}
	console.error(JSON.stringify(diagnostic).replaceAll(syntheticKey, "[REDACTED]").replaceAll(encodedKey, "[REDACTED]"));
	throw error;
} finally {
	await application?.close();
	await new Promise(resolveClose => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
