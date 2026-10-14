import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { AgentCore, BrowserController, installBrowserTools } from "../packages/agent-core/src/index.ts";
import { KestrelDatabase } from "../packages/database/src/index.ts";
import {
	CredentialBroker,
	PlaintextSecretProtection,
} from "../apps/desktop/src/main/credential-broker.ts";

// This is a deterministic useful-work fixture. It uses a disposable encrypted
// Kestrel profile, loopback-only synthetic sources, the real desktop browser
// port, real AgentCore tools, and real renderer persistence. No preload or
// runtime response is stubbed, and no person's profile or credentials are read.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-real-work-")));
const userData = join(root, "profile");
const workspace = join(root, "workspace");
for (const name of ["profile", "workspace", "home", "codex", "tmp"])
	mkdirSync(join(root, name));
writeFileSync(
	join(userData, "workspace-grants.json"),
	JSON.stringify([
		{
			id: "real-work-project",
			path: workspace,
			name: "Real work fixture",
			order: 0,
			createdAt: "2026-10-13T15:00:00.000Z",
			updatedAt: "2026-10-13T15:00:00.000Z",
		},
	]),
);

const evidenceDirectory = process.env.KESTREL_REAL_WORK_EVIDENCE_DIR;
if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const artifactPath = "orion-4.2-release-brief.md";
const title = "Orion 4.2 research brief";
const originalTask = [
	"Research Orion 4.2 for a release engineering lead and create a Markdown brief under 250 words.",
	"Use exactly two sources, cite both exact URLs, state two concrete recommendations, include a 24-hour rollback fallback, and label synthetic fixture evidence clearly.",
	`Save the result as ${artifactPath}, read it back, and keep these requirements through any browser recovery and independent review.`,
].join(" ");
const synthesisRequest =
	"Use the completed two-source browser research to write and read back the requested artifact. Preserve every original constraint and return the final factual recommendation with its artifact path.";

const artifact = `# Orion 4.2 release brief

**Synthetic fixture evidence — not a production benchmark.**

Orion 4.2 was released on October 10, 2026. In the controlled fixture benchmark, both sources report an 18% cold-start latency reduction. The operations source adds a deployment constraint: retain Orion 4.1 for 24 hours so the rollout can be reversed.

## Recommendations

1. Roll out Orion 4.2 to a measured canary and compare cold-start latency with the documented 18% fixture result before expanding.
2. Keep Orion 4.1 deployable for the first 24 hours and roll back if the measured result regresses or operational checks fail.

## Sources

- [Orion 4.2 release notes](SOURCE_A_URL)
- [Orion 4.2 operations note](SOURCE_B_URL)
`;

const listen = async (server) => {
	await new Promise((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	assert(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
};

let targetRequests = 0;
const sourceB = createServer((request, response) => {
	targetRequests += 1;
	response.writeHead(200, {
		"content-type": "text/html",
		"cache-control": "no-store",
	});
	response.end(`<!doctype html><title>Orion operations note</title>
		<h1>Orion 4.2 operations note</h1>
		<p>Synthetic fixture evidence. Operators must retain Orion 4.1 for 24 hours as the rollback fallback.</p>
		<p>The controlled fixture validation reproduced an 18 percent cold-start latency reduction.</p>`);
});
const sourceBOrigin = await listen(sourceB);
const redirectPath = "private-redirect-path-sentinel";
const redirectQuery = "private-redirect-query-sentinel";
const sourceA = createServer((request, response) => {
	if (request.url === "/handoff") {
		response.writeHead(302, {
			location: `${sourceBOrigin}/${redirectPath}?token=${redirectQuery}#private-fragment-sentinel`,
		});
		response.end();
		return;
	}
	response.writeHead(200, {
		"content-type": "text/html",
		"cache-control": "no-store",
	});
	response.end(`<!doctype html><title>Orion release notes</title>
		<h1>Orion 4.2 release notes</h1>
		<p>Synthetic fixture evidence. Orion 4.2 was released on October 10, 2026.</p>
		<p>A controlled fixture benchmark measured an 18 percent cold-start latency reduction.</p>`);
});
const sourceAOrigin = await listen(sourceA);
const sourceAUrl = `${sourceAOrigin}/release-notes`;
const sourceBUrl = `${sourceBOrigin}/operations`;
const expectedArtifact = artifact
	.replace("SOURCE_A_URL", sourceAUrl)
	.replace("SOURCE_B_URL", sourceBUrl);

let browserProviderCall = 0;
const browserProviderErrors = [];
const browserSessionIds = [];
const browserApprovalExecutionIds = [];
const responseChunk = (response, value) => {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-store",
	});
	response.end(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`);
};
const toolOutput = (body) => {
	const message = [...(body.messages ?? [])]
		.reverse()
		.find((candidate) => candidate.role === "tool");
	if (!message) return {};
	try {
		return JSON.parse(typeof message.content === "string" ? message.content : "{}");
	} catch {
		return {};
	}
};
const browserProvider = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/v1/models") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ data: [{ id: "real-work-browser-fixture", object: "model" }] }),
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
	browserProviderCall += 1;
	const context = JSON.stringify(body.messages ?? []);
	if (!context.includes("under 250 words") || !context.includes("24-hour rollback"))
		browserProviderErrors.push(`call ${browserProviderCall} lost the original task constraints`);
	const latest = toolOutput(body);
	const latestBrowserSessionId = latest.output?.browserSessionId;
	if (latestBrowserSessionId) browserSessionIds.push(latestBrowserSessionId);
	const active = browserSessionIds.at(-1);
	const first = browserSessionIds[0];
	const calls = {
		1: ["browser.create", { allowedOrigins: [sourceAOrigin] }],
		2: ["browser.navigate", { browserSessionId: active, url: sourceAUrl }],
		3: ["browser.snapshot", { browserSessionId: active }],
		4: ["browser.navigate", { browserSessionId: active, url: `${sourceAOrigin}/handoff` }],
		5: ["browser.create", { allowedOrigins: [sourceBOrigin] }],
		6: ["browser.navigate", { browserSessionId: active, url: sourceBUrl }],
		7: ["browser.snapshot", { browserSessionId: active }],
		8: ["browser.close", { browserSessionId: active }],
		9: ["browser.close", { browserSessionId: first }],
	};
	const next = calls[browserProviderCall];
	if (next) {
		const [name, argumentsValue] = next;
		if (Object.values(argumentsValue).some((value) => value === undefined))
			browserProviderErrors.push(`call ${browserProviderCall} lacked a browser session`);
		responseChunk(response, {
			id: `browser-fixture-${browserProviderCall}`,
			model: "real-work-browser-fixture",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: `browser-call-${browserProviderCall}`,
								type: "function",
								function: { name, arguments: JSON.stringify(argumentsValue) },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 20, completion_tokens: 8 },
		});
		return;
	}
	if (
		!context.includes("October 10, 2026") ||
		!context.includes("18 percent") ||
		!context.includes("retain Orion 4.1 for 24 hours")
	)
		browserProviderErrors.push("final browser synthesis lacked independently expected source facts");
	responseChunk(response, {
		id: "browser-fixture-final",
		model: "real-work-browser-fixture",
		choices: [
			{
				index: 0,
				delta: {
					content:
						"Synthetic fixture research collected from two exact cited origins: Orion 4.2 was released October 10, 2026; both sources report an 18 percent cold-start reduction; the operations note requires retaining Orion 4.1 for 24 hours. The cross-origin redirect was denied, then a fresh browser session scoped only to the second origin reached that direct source.",
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 40, completion_tokens: 25 },
	});
});
const providerOrigin = await listen(browserProvider);

const allowedEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]]],
	),
);
const childEnvironment = {
	...allowedEnvironment,
	HOME: join(root, "home"),
	CODEX_HOME: join(root, "codex"),
	TMPDIR: join(root, "tmp"),
	USER: "real-work-fixture",
	LOGNAME: "real-work-fixture",
	KESTREL_TEST_USER_DATA: userData,
	KESTREL_REAL_USER_PROFILE: "1",
	KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
	KESTREL_DISABLE_UPDATES: "1",
	KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
	KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
	NOUS_API_KEY: "local-fixture-credential",
	NOUS_BASE_URL: `${providerOrigin}/v1`,
	NOUS_MODEL: "real-work-browser-fixture",
};
// AgentCore in the parent process must share the same disposable discovery and
// credential boundary as the child desktop, including constructor discovery.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, childEnvironment);

const requireDesktop = createRequire(resolve("apps/desktop/package.json"));
let application;
let page;
let core;
let sessionId;
const pageErrors = [];
const reviewCalls = [];
let reviewerSawBoundedContext = false;
let correctionSawPreservedState = false;
let terminalReviewSawCorrection = false;
let closedBrowserBackendCalls = 0;

async function launchDesktop() {
	application = await electron.launch({
		executablePath: executable ? resolve(executable) : requireDesktop("electron"),
		args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
		env: childEnvironment,
		timeout: 30_000,
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("petOverlay=1"),
		);
		window.setSize(1600, 1000);
	});
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "expanded");
		localStorage.setItem("kestrel:agent-panel-width", "560");
	});
	return page;
}

async function request(input) {
	const response = await page.evaluate(
		(requestInput) => window.kestrel.request(requestInput),
		input,
	);
	assert(response.ok, response.error);
	return response;
}

async function closeDesktop() {
	await application?.close();
	application = undefined;
	page = undefined;
}

async function capture(name) {
	if (!evidenceDirectory || !page || !application) return;
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	});
	await page.screenshot();
	const png = await application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("petOverlay=1"),
		);
		return (await window.webContents.capturePage()).toPNG().toString("base64");
	});
	writeFileSync(join(evidenceDirectory, name), Buffer.from(png, "base64"));
}

const modelText = (request) =>
	request.messages
		.map((message) =>
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		)
		.join("\n");
const initialAnswer =
	`Initial answer: Orion 4.2 was released October 10, 2026, and the two synthetic fixture sources report an 18% cold-start reduction. The verified artifact is ${artifactPath}.`;
const correctedAnswer =
	`Corrected answer: Orion 4.2 was released October 10, 2026, and both synthetic fixture sources report an 18% cold-start reduction. Roll out to a measured canary, keep Orion 4.1 deployable for the required 24-hour rollback fallback, and stop or roll back if measured latency or operational checks regress. The two-source brief was saved and read back at ${artifactPath}; it cites ${sourceAUrl} and ${sourceBUrl}.`;

const provider = (id, capabilities, canUseTools) => ({
	id,
	defaultModel: `${id}-model`,
	capabilities: {
		streaming: false,
		tools: canUseTools,
		images: false,
		audio: false,
		documents: false,
		local: true,
	},
	profileHints: {
		capabilities,
		features: { reasoningLevels: true },
		limits: { contextWindow: 128_000, maxOutputTokens: 8_192 },
	},
	probe: async () => undefined,
	complete: async (modelRequest) => {
		const context = modelText(modelRequest);
		const isReview = context.includes("Review the completed agent result below");
		if (isReview) {
			const terminal = context.includes("one terminal re-review after a correction");
			reviewCalls.push({ id, phase: terminal ? "terminal-review" : "initial-review" });
			if (terminal)
				terminalReviewSawCorrection = context.includes(correctedAnswer) && context.includes(originalTask);
			if (
				context.includes("TRUSTED USER REQUIREMENTS") &&
				context.includes(originalTask) &&
				context.includes(synthesisRequest) &&
				context.includes("workspace.write") &&
				context.includes("workspace.read") &&
				!context.includes(expectedArtifact)
			)
				reviewerSawBoundedContext = true;
			return {
				providerId: id,
				model: modelRequest.model,
				text: terminal
					? "VERDICT: PASS\nThe corrected answer states both verified facts, both exact sources, the artifact readback, and the 24-hour rollback fallback."
					: "VERDICT: FAIL\nThe response omits the required 24-hour rollback fallback even though the verified artifact evidence exists.",
				toolCalls: [],
				usage: { inputTokens: 20, outputTokens: 8 },
				finishReason: "stop",
			};
		}
		const correction = context.includes("Independent verification found a concrete issue");
		if (correction) {
			correctionSawPreservedState =
				context.includes(initialAnswer) &&
				context.includes("24-hour rollback fallback") &&
				context.includes(originalTask);
			reviewCalls.push({ id, phase: "correction" });
			return {
				providerId: id,
				model: modelRequest.model,
				text: correctedAnswer,
				toolCalls: [],
				usage: { inputTokens: 24, outputTokens: 18 },
				finishReason: "stop",
			};
		}
		const toolNames = modelRequest.messages
			.filter((message) => message.role === "tool")
			.map((message) => message.toolName);
		if (!toolNames.includes("workspace.write")) {
			reviewCalls.push({ id, phase: "write" });
			return {
				providerId: id,
				model: modelRequest.model,
				text: "",
				toolCalls: [
					{
						id: "write-release-brief",
						name: "workspace.write",
						arguments: { path: artifactPath, content: expectedArtifact },
					},
				],
				usage: { inputTokens: 18, outputTokens: 5 },
				finishReason: "tool_calls",
			};
		}
		if (!toolNames.includes("workspace.read")) {
			reviewCalls.push({ id, phase: "readback" });
			return {
				providerId: id,
				model: modelRequest.model,
				text: "",
				toolCalls: [
					{
						id: "read-release-brief",
						name: "workspace.read",
						arguments: { path: artifactPath },
					},
				],
				usage: { inputTokens: 20, outputTokens: 4 },
				finishReason: "tool_calls",
			};
		}
		reviewCalls.push({ id, phase: "initial-answer" });
		return {
			providerId: id,
			model: modelRequest.model,
			text: initialAnswer,
			toolCalls: [],
			usage: { inputTokens: 30, outputTokens: 14 },
			finishReason: "stop",
		};
	},
});

let proof;
try {
	await launchDesktop();
	const created = await request({
		type: "runtime-create-session",
		kind: "conversation",
		title,
		workspaceRoot: workspace,
		approvalPolicy: "auto",
	});
	sessionId = created.session.id;
	let browserRun = await request({
		type: "runtime-run-agent",
		sessionId,
		message: originalTask,
		model: "real-work-browser-fixture",
		providerIds: ["nous"],
		maximumTurns: 20,
		approvalStatus: "approved",
	});
	assert.equal(browserRun.run.status, "waiting_approval");
	let pending = await request({ type: "runtime-list-pending-tool-approvals" });
	assert.equal(pending.executions.length, 1);
	assert.equal(pending.executions[0].toolName, "browser.create");
	assert.deepEqual(pending.executions[0].input.allowedOrigins, [sourceAOrigin]);
	assert.equal(pending.executions[0].status, "blocked");
	assert.equal(pending.executions[0].output.persistentApprovalAllowed, false);
	browserApprovalExecutionIds.push(pending.executions[0].id);
	browserRun = await request({
		type: "runtime-resume-agent",
		runId: browserRun.run.id,
		approvalDecision: "approved",
		maximumTurns: 20,
	});
	assert.equal(browserRun.run.status, "waiting_approval");
	pending = await request({ type: "runtime-list-pending-tool-approvals" });
	assert.equal(pending.executions.length, 1);
	assert.equal(pending.executions[0].toolName, "browser.create");
	assert.deepEqual(pending.executions[0].input.allowedOrigins, [sourceBOrigin]);
	assert.equal(pending.executions[0].status, "blocked");
	assert.equal(pending.executions[0].output.persistentApprovalAllowed, false);
	browserApprovalExecutionIds.push(pending.executions[0].id);
	browserRun = await request({
		type: "runtime-resume-agent",
		runId: browserRun.run.id,
		approvalDecision: "approved",
		maximumTurns: 20,
	});
	assert.equal(browserRun.run.status, "completed", JSON.stringify({
		pendingTool: browserRun.run.pendingToolName,
		providerCalls: browserProviderCall,
		execution: browserRun.execution,
	}));
	assert.deepEqual(browserProviderErrors, []);
	assert.equal(browserProviderCall, 10);
	assert.equal(targetRequests, 1, "Only the approved direct Source B navigation may reach its origin");
	const browserExecutions = (
		await request({ type: "runtime-list-executions", sessionId })
	).executions;
	const createExecutions = browserExecutions.filter(
		(execution) => execution.toolName === "browser.create",
	);
	assert.equal(createExecutions.length, 4, "Only two pending grants and their two approved creations may exist");
	assert.equal(browserExecutions.filter((execution) =>
		(execution.toolName === "browser.navigate" || execution.toolName === "browser.close") &&
		(execution.status === "blocked" || execution.output?.approvalRequired === true),
	).length, 0, "Anonymous scoped navigation and owned cleanup must not request extra approvals");
	assert.equal(browserExecutions.filter((execution) =>
		execution.toolName === "browser.close" && execution.status === "verified",
	).length, 2, "Both owned research sessions must close successfully");
	assert.equal(
		createExecutions.filter((execution) =>
			browserApprovalExecutionIds.includes(execution.id) &&
			execution.status === "cancelled" &&
			execution.error === "The approved one-time grant was consumed.",
		).length,
		2,
		"Each protected browser session must first record a fresh approval boundary",
	);
	assert.equal(
		createExecutions.filter((execution) => execution.status === "verified").length,
		2,
		"Each exact-origin grant must execute only after its one-time approval",
	);
	const deniedRedirect = browserExecutions.find(
		(execution) =>
			execution.toolName === "browser.navigate" && execution.status === "failed",
	);
	assert(deniedRedirect?.error?.includes(sourceBOrigin));
	assert.match(deniedRedirect.error, /(?:redirect|navigation).*origin allowlist/i);
	for (const sentinel of [redirectPath, redirectQuery, "private-fragment-sentinel"])
		assert(!deniedRedirect.error.includes(sentinel));
	const snapshots = browserExecutions.filter(
		(execution) => execution.toolName === "browser.snapshot" && execution.status === "verified",
	);
	assert.equal(snapshots.length, 2);
	assert.match(JSON.stringify(snapshots[0].output), /October 10, 2026/);
	assert.match(JSON.stringify(snapshots[0].output), /18 percent cold-start latency reduction/);
	assert.match(JSON.stringify(snapshots[1].output), /retain Orion 4\.1 for 24 hours/);
	assert.match(JSON.stringify(snapshots[1].output), /18 percent cold-start latency reduction/);
	await closeDesktop();

	const key = await new CredentialBroker(
		userData,
		new PlaintextSecretProtection(),
	).getDatabaseKey();
	const databasePath = join(userData, "database", "kestrel.sqlite");
	assert(existsSync(databasePath));
	// Kestrel encrypts protected records inside SQLite, not the SQLite container.
	assert(!readFileSync(databasePath).includes(Buffer.from(originalTask)),
		"The saved user brief must not occur as plaintext in the database");
	const database = new KestrelDatabase(databasePath, key);
	core = new AgentCore({
		database,
		workspaceRoots: [workspace],
		configuredWorkspaceRoots: [workspace],
		projects: [
			{
				id: "real-work-project",
				path: workspace,
				name: "Real work fixture",
				order: 0,
				createdAt: "2026-10-13T15:00:00.000Z",
				updatedAt: "2026-10-13T15:00:00.000Z",
			},
		],
		learnedSkillRoot: join(root, "learned-skills"),
		now: () => "2026-10-13T15:00:00.000Z",
		modelProviders: [
			provider(
				"primary",
				{
					research: 0.99,
					technical_writing: 0.99,
					complex_reasoning: 0.99,
					instruction_following: 0.99,
					tool_use: 0.99,
					reliability: 0.99,
					code_review: 0.4,
				},
				true,
			),
			provider(
				"reviewer",
				{ code_review: 0.99, reliability: 0.99, instruction_following: 0.96 },
				false,
			),
			provider(
				"repair",
				{
					research: 0.96,
					technical_writing: 0.96,
					complex_reasoning: 0.96,
					instruction_following: 0.97,
					tool_use: 0.96,
					reliability: 0.96,
					code_review: 0.45,
				},
				true,
			),
		],
	});
	// Reopening the same conversation requires its tool adapters to remain
	// registered for prior-context authorization. The real desktop research
	// sessions are closed; this fresh controller denies any new browser I/O.
	// It produces no observations and may not be used by synthesis or review.
	const closedBrowserBackend = new Proxy({}, {
		get: () => async () => {
			closedBrowserBackendCalls += 1;
			throw new Error("The research browser is closed; a fresh desktop session is required.");
		},
	});
	installBrowserTools(core.runtime, new BrowserController(closedBrowserBackend), sessionId);
	const synthesis = await core.handle({
		type: "runtime-run-agent",
		sessionId,
		message: synthesisRequest,
		model: "auto",
		providerIds: ["auto"],
		maximumTurns: 8,
		approvalStatus: "approved",
	});
	assert(synthesis.ok, JSON.stringify(synthesis));
	assert.equal(synthesis.run?.status, "completed");
	assert.equal(synthesis.messages?.[0]?.content, correctedAnswer);
	assert.equal(closedBrowserBackendCalls, 0, "Synthesis must use persisted real observations without fresh browser I/O");
	assert(reviewerSawBoundedContext, "The independent reviewer must receive bounded requirements and tool metadata");
	assert(correctionSawPreservedState, "The correction must retain the original task, draft, and reviewer finding");
	assert(terminalReviewSawCorrection, "Terminal re-review must inspect the corrected answer against the original task");
	assert.deepEqual(
		reviewCalls.map((call) => call.phase),
		["write", "readback", "initial-answer", "initial-review", "correction", "terminal-review"],
	);
	assert.notEqual(
		reviewCalls.find((call) => call.phase === "initial-answer")?.id,
		reviewCalls.find((call) => call.phase === "initial-review")?.id,
		"The reviewer must be independent from the executor",
	);
	const messages = core.runtime.listMessages(sessionId);
	const initial = messages.find((message) => message.content === initialAnswer);
	const corrected = messages.find((message) => message.content === correctedAnswer);
	assert(initial && corrected);
	assert.equal(corrected.supersedesMessageId, initial.id);
	assert.equal(
		messages.filter((message) => message.supersedesMessageId === initial.id).length,
		1,
		"Exactly one current correction must supersede the draft",
	);
	assert(!messages.some((message) => message.content.includes("VERDICT:")));
	const readback = await core.runtime.callTool(sessionId, "workspace.read", {
		path: artifactPath,
	});
	assert.equal(readback.status, "verified");
	assert.equal(readback.output?.content, expectedArtifact);
	assert.equal(readFileSync(join(workspace, artifactPath), "utf8"), expectedArtifact);
	assert(expectedArtifact.trim().split(/\s+/).length < 250);
	assert.equal((expectedArtifact.match(/\]\(http:/g) ?? []).length, 2);
	for (const expected of [
		"October 10, 2026",
		"18% cold-start latency reduction",
		"retain Orion 4.1 for 24 hours",
		sourceAUrl,
		sourceBUrl,
		"Synthetic fixture evidence",
	])
		assert(expectedArtifact.includes(expected));
	await core.close();
	core = undefined;
	for (const protectedText of [originalTask, initialAnswer, correctedAnswer])
		assert(!readFileSync(databasePath).includes(Buffer.from(protectedText)),
			"Persisted message content must remain encrypted inside SQLite");

	await launchDesktop();
	await page.reload();
	const toggle = page.locator("#browser-agent-toggle");
	await toggle.waitFor();
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	const openChat = async () => {
		const project = page.locator(".kestrel-sidebar-project-open").filter({ hasText: "Real work fixture" });
		await project.waitFor();
		if ((await project.getAttribute("aria-expanded")) !== "true") await project.click();
		await page.locator(".kestrel-sidebar").getByRole("button", { name: title, exact: true }).click();
	};
	await openChat();
	const host = page.locator(".agent-conversation-host");
	await expect(host.getByText("Response finished", { exact: true })).toBeVisible();
	await expect(host.getByText(correctedAnswer, { exact: true })).toBeVisible();
	await expect(host.getByText(initialAnswer, { exact: true })).not.toBeVisible();
	await expect(host.locator("details.reviewed-answer-earlier")).toHaveCount(1);
	await expect(host.locator("details.reviewed-answer-earlier")).not.toHaveAttribute("open");
	assert.equal(await host.locator(`[data-runtime-message-id]`).filter({ hasText: correctedAnswer }).count(), 1);
	let persistedRead = await request({
		type: "runtime-call-tool",
		sessionId,
		toolName: "workspace.read",
		input: { path: artifactPath },
	});
	assert.equal(persistedRead.execution.status, "verified");
	assert.equal(persistedRead.execution.output?.content, expectedArtifact);
	await host.getByText(correctedAnswer, { exact: true }).scrollIntoViewIfNeeded();
	await expect(host.getByText(correctedAnswer, { exact: true })).toBeInViewport();
	await host.getByText("Response finished", { exact: true }).scrollIntoViewIfNeeded();
	await expect(host.getByText("Response finished", { exact: true })).toBeInViewport();
	await capture("real-work-finished.png");
	await closeDesktop();

	await launchDesktop();
	await page.reload();
	const restartedToggle = page.locator("#browser-agent-toggle");
	await restartedToggle.waitFor();
	if ((await restartedToggle.getAttribute("aria-expanded")) !== "true")
		await restartedToggle.click();
	await openChat();
	const restartedHost = page.locator(".agent-conversation-host");
	await expect(restartedHost.getByText("Response finished", { exact: true })).toBeVisible();
	await expect(restartedHost.getByText(correctedAnswer, { exact: true })).toBeVisible();
	await expect(restartedHost.getByText(initialAnswer, { exact: true })).not.toBeVisible();
	await expect(restartedHost.locator("details.reviewed-answer-earlier")).toHaveCount(1);
	await expect(restartedHost.locator("details.reviewed-answer-earlier")).not.toHaveAttribute("open");
	const persistedMessages = await request({ type: "runtime-list-messages", sessionId });
	assert.equal(
		persistedMessages.messages.find((message) => message.content === correctedAnswer)
			?.supersedesMessageId,
		initial.id,
	);
	persistedRead = await request({
		type: "runtime-call-tool",
		sessionId,
		toolName: "workspace.read",
		input: { path: artifactPath },
	});
	assert.equal(persistedRead.execution.output?.content, expectedArtifact);
	assert.deepEqual(pageErrors, []);
	await restartedHost.getByText(correctedAnswer, { exact: true }).scrollIntoViewIfNeeded();
	await expect(restartedHost.getByText(correctedAnswer, { exact: true })).toBeInViewport();
	await restartedHost.getByText("Response finished", { exact: true }).scrollIntoViewIfNeeded();
	await expect(restartedHost.getByText("Response finished", { exact: true })).toBeInViewport();
	await capture("real-work-restarted.png");
	proof = {
		fixtureEvidence: "synthetic loopback sources and deterministic providers",
		liveProviderTaskVerified: false,
		realUserProfileVerified: false,
		canonicalInstalledAppVerified: false,
		disposableEncryptedProfile: true,
		realDesktopBrowserPort: true,
		browserCreateApprovalBoundaries: 2,
		browserNavigationOrCleanupApprovals: 0,
		blockedCrossOriginRedirect: true,
		narrowReplacementOrigins: [sourceBOrigin],
		twoSourceFactsIndependentlyAsserted: true,
		artifactPath,
		artifactReadBack: true,
		independentReview: true,
		terminalRereview: true,
		terminalReviewSawCorrection,
		browserApprovalExecutionIds,
		reviewCalls,
		sourceUrls: [sourceAUrl, sourceBUrl],
		artifactWordCount: expectedArtifact.trim().split(/\s+/).length,
		oneCurrentCorrectedAnswer: true,
		responseFinishedVisible: true,
		restartPersistence: true,
		executable: executable ?? "source Electron",
	};
	if (evidenceDirectory) {
		writeFileSync(join(evidenceDirectory, artifactPath), persistedRead.execution.output.content);
		writeFileSync(join(evidenceDirectory, "proof.json"), JSON.stringify(proof, null, 2));
	}
	console.log(
		"Real-work desktop regression passed: two-source fixture research, denied cross-origin redirect, two exact one-time browser approvals, retained constraints, verified Markdown readback, independent correction and terminal re-review, one current answer, Response finished, and restart persistence.",
	);
} catch (error) {
	await capture("failure.png").catch(() => {});
	throw error;
} finally {
	await application?.close().catch(() => {});
	await core?.close().catch(() => {});
	for (const server of [browserProvider, sourceA, sourceB]) {
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
	rmSync(root, { recursive: true, force: true });
}
