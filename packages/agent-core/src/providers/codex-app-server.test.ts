import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerProvider } from "./codex-app-server";
import { ProviderPool } from "./provider-pool";
import { textContent } from "./types";

const roots: string[] = [];
const executeFile = promisify(execFileCallback);

async function fakeAppServer(): Promise<{
	executable: string;
	capture: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "kestrel-codex-app-server-test-"));
	roots.push(root);
	const executable = join(root, "codex");
	const capture = `${executable}.capture.jsonl`;
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const capture = process.argv[1] + ".capture.jsonl";
let turn = 0;
const turnOutput = new Map();
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function record(value) {
  const row = { pid: process.pid, value };
  if (value.method === "initialize") {
    row.env = {
      CODEX_HOME: process.env.CODEX_HOME ?? null,
      KESTREL_CODEX_MCP_TOKEN: process.env.KESTREL_CODEX_MCP_TOKEN ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    };
  }
  fs.appendFileSync(capture, JSON.stringify(row) + "\\n");
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" } });
  if (message.method === "initialized") return;
  if (message.method === "account/read") return send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  if (message.method === "account/rateLimits/read") {
    return send({
      id: message.id,
      result: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1900000000 },
          secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1900500000 },
          planType: "plus",
        },
      },
    });
  }
  if (message.method === "model/list") {
    if (message.params && message.params.cursor === "page-2") {
      return send({ id: message.id, result: { data: [{ id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden model", supportedReasoningEfforts: [{ reasoningEffort: "minimal" }], hidden: true }], nextCursor: null } });
    }
    return send({ id: message.id, result: { data: [{ id: "gpt-catalog", model: "gpt-catalog", displayName: "Catalog model", inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "minimal" }, { reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: "page-2" } });
  }
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" }, model: message.params.model } });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    const inputText = (message.params.input || []).map(part => part.text || "").join("\\n");
    if (message.params.outputSchema) {
      let output = {
        text: "",
        toolCalls: [{ name: "workspace.write", argumentsJson: JSON.stringify({ path: "notes.txt", content: "ok" }) }],
      };
      if (inputText.includes("Tool result (workspace.write)")) output = { text: "Mutation completed", toolCalls: [] };
      if (inputText.includes("malformed-decision")) output = "{not-json";
      if (inputText.includes("unknown-tool-decision")) output = { text: "", toolCalls: [{ name: "workspace.unknown", argumentsJson: "{}" }] };
      if (inputText.includes("malformed-arguments")) output = { text: "", toolCalls: [{ name: "workspace.write", argumentsJson: "[1,2,3]" }] };
      if (inputText.includes("empty-decision")) output = { text: "", toolCalls: [] };
      turnOutput.set(turn, typeof output === "string" ? output : JSON.stringify(output));
    }
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ id: 800 + turn, method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId, itemId: "perm-" + turn, permissions: { network: { enabled: true } } } });
    send({ id: 700 + turn, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId, serverName: "kestrel_browser", mode: "form", message: "confirm" } });
    send({ id: 900 + turn, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId, itemId: "cmd-" + turn, command: "touch forbidden" } });
    return;
  }
  if (typeof message.id === "number" && message.id >= 901) {
    const current = message.id - 900;
    const turnId = "turn-" + current;
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "answer-" + current, delta: turnOutput.get(current) || ("Persistent answer " + current) } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: current > 1 ? 5 : 0, reasoningOutputTokens: 1 } } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
  }
});
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	return { executable, capture };
}

async function retryableFakeAppServer(): Promise<{ executable: string }> {
	const root = await mkdtemp(
		join(tmpdir(), "kestrel-codex-app-server-retry-test-"),
	);
	roots.push(root);
	const executable = join(root, "codex");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const attemptsPath = process.argv[1] + ".initialize-attempts";
let initialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function attempts() {
  const current = Number(fs.existsSync(attemptsPath) ? fs.readFileSync(attemptsPath, "utf8") : "0") + 1;
  fs.writeFileSync(attemptsPath, String(current));
  return current;
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (attempts() === 1) {
      return send({ id: message.id, error: { code: -32000, message: "fake initialize failed" } });
    }
    initialized = true;
    return send({ id: message.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "account/read" && initialized) {
    return send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  }
});
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	return { executable };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

type CaptureRecord = {
	pid: number;
	env?: {
		CODEX_HOME: string | null;
		KESTREL_CODEX_MCP_TOKEN: string | null;
		OPENAI_API_KEY: string | null;
	};
	value: Record<string, unknown> & {
		params?: Record<string, unknown>;
		result?: Record<string, unknown>;
	};
};

async function readCapture(path: string): Promise<CaptureRecord[]> {
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as CaptureRecord);
}

describe("persistent Codex app-server provider", () => {
	it("discovers the signed-in account's stable app-server model catalog", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			requestTimeoutMs: 10_000,
		});

		await expect(provider.discoverModels()).resolves.toEqual([
			{
				id: "gpt-catalog",
				displayName: "Catalog model",
				availability: "available",
				source: "protocol",
				capabilities: {
					capabilityProvenance: "confirmed",
					streaming: true,
					tools: true,
					images: true,
					audio: false,
					documents: false,
					video: false,
					structuredOutput: true,
					reasoningEfforts: ["low", "high"],
				},
			},
		]);
		await provider.close();

		const records = await readCapture(fake.capture);
		const modelListRequests = records.filter(
			(record) => record.value.method === "model/list",
		);
		expect(modelListRequests).toHaveLength(2);
		expect(modelListRequests[0]?.value.params).toMatchObject({
			limit: 100,
			includeHidden: false,
		});
		expect(modelListRequests[1]?.value.params).toMatchObject({
			cursor: "page-2",
		});
	});

	it("proposes bounded Kestrel tool calls through the provider pool and receives the verified result on the next turn", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			requestTimeoutMs: 10_000,
			turnTimeoutMs: 2_000,
		});
		const pool = new ProviderPool([provider]);
		const tools = [
			{
				name: "workspace.write",
				description: "Write a bounded workspace file after Kestrel approval.",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					required: ["path", "content"],
					properties: {
						path: { type: "string" },
						content: { type: "string" },
					},
				},
			},
		];
		const first = await pool.complete(
			{
				model: "gpt-test",
				metadata: { session_id: "session-tools" },
				messages: [{ role: "user", content: textContent("Write my note") }],
				tools,
			},
			{ providerIds: [provider.id] },
		);
		expect(first.result).toMatchObject({
			text: "",
			finishReason: "tool_calls",
			toolCalls: [
				{
					id: "codex-turn-1-1",
					name: "workspace.write",
					arguments: { path: "notes.txt", content: "ok" },
				},
			],
		});
		const call = first.result.toolCalls[0]!;
		const second = await pool.complete(
			{
				model: "gpt-test",
				metadata: { session_id: "session-tools" },
				messages: [
					{ role: "user", content: textContent("Write my note") },
					{ role: "assistant", content: textContent(""), toolCalls: [call] },
					{
						role: "tool",
						content: textContent(
							'{"status":"verified","output":{"written":true}}',
						),
						toolCallId: call.id,
						toolName: call.name,
					},
					{
						role: "user",
						content: [
							...textContent("Current visual observation"),
							{
								type: "image",
								data: "aW1hZ2U=",
								mediaType: "image/png",
								source: "base64",
							},
						],
					},
				],
				tools,
			},
			{ providerIds: [provider.id] },
		);
		expect(second.result).toMatchObject({
			text: "Mutation completed",
			finishReason: "stop",
			toolCalls: [],
		});
		await provider.close();

		const records = await readCapture(fake.capture);
		const thread = records.find(
			(record) => record.value.method === "thread/start",
		)?.value.params as { baseInstructions?: string };
		expect(thread.baseInstructions).toContain("approval-controlled agent loop");
		expect(thread.baseInstructions).toContain("Do not execute commands");
		const turns = records.filter(
			(record) => record.value.method === "turn/start",
		);
		const firstParams = turns[0]!.value.params!;
		expect(firstParams.outputSchema).toMatchObject({
			type: "object",
			additionalProperties: false,
			properties: {
				toolCalls: {
					items: {
						properties: { name: { enum: ["workspace.write"] } },
					},
				},
			},
		});
		const followUpText = (
			turns[1]!.value.params!.input as Array<{ text?: string }>
		)[0]!.text!;
		expect(followUpText).toContain("Tool result (workspace.write)");
		expect(followUpText).toContain('"status":"verified"');
		expect(followUpText).toContain("Current visual observation");
		expect(followUpText).not.toContain("Write my note");
		expect(turns[1]!.value.params!.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					url: "data:image/png;base64,aW1hZ2U=",
				}),
			]),
		);
	});

	it.each([
			["malformed-decision", /malformed structured tool output/i],
			["unknown-tool-decision", /unavailable or invalid Kestrel tool call/i],
			["malformed-arguments", /tool arguments must be a JSON object/i],
			["empty-decision", /empty structured tool decision/i],
		])(
			"fails closed for invalid structured tool output: %s",
			async (prompt, error) => {
				const fake = await fakeAppServer();
				const provider = new CodexAppServerProvider({
					executable: fake.executable,
					requestTimeoutMs: 10_000,
					turnTimeoutMs: 2_000,
				});
				await expect(
					provider.complete({
						model: "gpt-test",
						metadata: { session_id: `session-${prompt}` },
						messages: [{ role: "user", content: textContent(prompt) }],
						tools: [
							{
								name: "workspace.write",
								description: "Write",
								inputSchema: { type: "object" },
							},
						],
					}),
				).rejects.toThrow(error);
				await provider.close();
			},
		);

	it("restarts after initialization failure instead of reusing an uninitialized process", async () => {
		const fake = await retryableFakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
			},
			requestTimeoutMs: 2_000,
		});

		await expect(provider.probe()).rejects.toThrow("fake initialize failed");
		await expect(provider.probe()).resolves.toBeUndefined();
		await provider.close();
	});

	it("initializes once, preserves a durable thread, streams turns, and declines vendor-side execution", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				OPENAI_API_KEY: "must-not-leak",
			},
			// Vitest starts many fake providers in parallel; allow the child Node
			// process to start without weakening the provider's production default.
			requestTimeoutMs: 10_000,
			turnTimeoutMs: 2_000,
		});
		await provider.probe();
		const write = (
			provider as unknown as { write(message: Record<string, unknown>): void }
		).write.bind(provider);
		expect(() =>
			write({
				method: "turn/start",
				params: { prompt: "x".repeat(8 * 1024 * 1024) },
			}),
		).toThrow("outbound message exceeded the safety limit");
		const deltas: string[] = [];
		const first = await provider.complete(
			{
				model: "gpt-test",
				metadata: { session_id: "session-1", workspace_root: process.cwd() },
				messages: [
					{ role: "system", content: textContent("Private system context") },
					{
						role: "user",
						content: [
							...textContent("First prompt"),
							{
								type: "image",
								data: "aW1hZ2U=",
								mediaType: "image/png",
								source: "base64",
							},
						],
					},
				],
			},
			{
				onEvent: (event) => {
					if (event.type === "text_delta") deltas.push(event.delta);
				},
			},
		);
		const second = await provider.complete({
			model: "gpt-test",
			metadata: { session_id: "session-1", workspace_root: process.cwd() },
			messages: [
				{ role: "system", content: textContent("Private system context") },
				{ role: "user", content: textContent("First prompt") },
				{ role: "assistant", content: textContent("Persistent answer 1") },
				{ role: "user", content: textContent("Second prompt") },
			],
		});
		await provider.close();

		expect(first).toMatchObject({
			responseId: "turn-1",
			text: "Persistent answer 1",
			usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 1 },
		});
		expect(second).toMatchObject({
			responseId: "turn-2",
			text: "Persistent answer 2",
			usage: { cachedInputTokens: 5 },
		});
		expect(deltas.join("")).toBe("Persistent answer 1");

		const records = await readCapture(fake.capture);
		expect(
			records.find((record) => record.value.method === "initialize")?.env,
		).toMatchObject({
			CODEX_HOME: null,
			KESTREL_CODEX_MCP_TOKEN: null,
			OPENAI_API_KEY: null,
		});
		expect(
			(
				records.find((record) => record.value.method === "thread/start")?.value
					.params as { baseInstructions?: string }
			).baseInstructions,
		).toContain("invoke MCP");
		expect(new Set(records.map((record) => record.pid))).toHaveLength(1);
		expect(
			records.filter((record) => record.value.method === "initialize"),
		).toHaveLength(1);
		expect(
			records.filter((record) => record.value.method === "thread/start"),
		).toHaveLength(1);
		const turns = records.filter(
			(record) => record.value.method === "turn/start",
		);
		expect(turns).toHaveLength(2);
		expect(turns[0]!.value.params!.outputSchema).toBeUndefined();
		expect(turns[1]!.value.params!.outputSchema).toBeUndefined();
		expect(
			(turns[0]!.value.params!.input as Array<{ text: string }>)[0]!.text,
		).toContain("Private system context");
		expect(turns[0]!.value.params!.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					url: "data:image/png;base64,aW1hZ2U=",
				}),
			]),
		);
		expect(
			(turns[1]!.value.params!.input as Array<{ text: string }>)[0]!.text,
		).toBe("Second prompt");
		expect(
			records.filter(
				(record) =>
					record.value.result && record.value.result.decision === "decline",
			),
		).toHaveLength(2);
		expect(
			records.some((record) =>
				JSON.stringify(record.value).includes("must-not-leak"),
			),
		).toBe(false);
	});

	it("rejects remote image URLs before starting a Codex turn", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			requestTimeoutMs: 10_000,
		});
		await expect(
			provider.complete({
				model: "gpt-test",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								data: "https://example.com/not-forwarded.png",
								mediaType: "image/png",
								source: "url",
							},
						],
					},
				],
			}),
		).rejects.toThrow("remote image URLs");
		await provider.close();

		const records = await readCapture(fake.capture);
		expect(
			records.filter((record) => record.value.method === "turn/start"),
		).toHaveLength(0);
	});

	if (process.platform === "darwin")
		it("converts HEIC images locally before starting a Codex turn", async () => {
			const fake = await fakeAppServer();
			const root = await mkdtemp(join(tmpdir(), "kestrel-codex-heic-test-"));
			roots.push(root);
			const png = join(root, "fixture.png");
			const heic = join(root, "fixture.heic");
			await sharp({
				create: {
					width: 2,
					height: 2,
					channels: 3,
					background: { r: 10, g: 20, b: 30 },
				},
			})
				.png()
				.toFile(png);
			await executeFile("/usr/bin/sips", [
				"-s",
				"format",
				"heic",
				png,
				"--out",
				heic,
			]);
			const provider = new CodexAppServerProvider({
				executable: fake.executable,
				requestTimeoutMs: 10_000,
			});
			await provider.complete({
				model: "gpt-test",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								data: (await readFile(heic)).toString("base64"),
								mediaType: "image/heic",
								source: "base64",
							},
						],
					},
				],
			});
			await provider.close();

			const turn = (await readCapture(fake.capture)).find(
				(record) => record.value.method === "turn/start",
			)?.value.params as { input?: Array<{ type?: string; url?: string }> };
			expect(turn.input).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "image",
						url: expect.stringMatching(/^data:image\/jpeg;base64,/),
					}),
				]),
			);
		});

	it("attaches a loopback browser MCP through overlay CODEX_HOME", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				OPENAI_API_KEY: "must-not-leak",
			},
			requestTimeoutMs: 10_000,
			turnTimeoutMs: 2_000,
		});
		expect(() =>
			provider.attachBrowserMcp({
				url: "https://example.com/mcp",
				token: "tok",
			}),
		).toThrow("loopback HTTP URL");
		provider.attachBrowserMcp({
			url: "http://127.0.0.1:9/mcp",
			token: "tok",
		});
		await provider.probe();
		await provider.complete({
			model: "gpt-test",
			metadata: { session_id: "session-browser", workspace_root: process.cwd() },
			messages: [{ role: "user", content: textContent("Use the browser") }],
		});

		const records = await readCapture(fake.capture);
		const initialize = records.find(
			(record) => record.value.method === "initialize",
		);
		expect(initialize?.env?.CODEX_HOME).toMatch(/kestrel-codex-app-server/);
		expect(initialize?.env?.KESTREL_CODEX_MCP_TOKEN).toBe("tok");
		expect(initialize?.env?.OPENAI_API_KEY).toBeNull();
		const overlayConfig = await readFile(
			join(initialize!.env!.CODEX_HOME!, "config.toml"),
			"utf8",
		);
		expect(overlayConfig).toContain("[mcp_servers.kestrel_browser]");
		expect(overlayConfig).toContain('url = "http://127.0.0.1:9/mcp"');
		expect(overlayConfig).toContain(
			'bearer_token_env_var = "KESTREL_CODEX_MCP_TOKEN"',
		);
		const instructions = (
			records.find((record) => record.value.method === "thread/start")?.value
				.params as { baseInstructions?: string }
		).baseInstructions;
		expect(instructions).toContain("kestrel_browser");
		expect(instructions).not.toContain("invoke MCP");
		const turn = records.find((record) => record.value.method === "turn/start")
			?.value.params as {
			sandboxPolicy?: { type?: string; networkAccess?: boolean };
		};
		expect(turn.sandboxPolicy).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
		expect(
			records.filter(
				(record) =>
					record.value.result && record.value.result.decision === "decline",
			),
		).toHaveLength(1);
		expect(
			records.some(
				(record) =>
					record.value.result &&
					JSON.stringify(record.value.result.permissions) === "{}",
			),
		).toBe(true);
		expect(
			records.some(
				(record) =>
					record.value.result &&
					record.value.result.action === "decline" &&
					record.value.result.content === null,
			),
		).toBe(true);
		await provider.close();
	});

	it("reads Codex rate-limit windows without inventing meters", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
		});
		const snapshot = await provider.readRateLimits();
		expect(snapshot).toMatchObject({
			ordinaryUsageAllowed: true,
			plan: "plus",
			rateLimitReached: false,
			primary: {
				usedPercent: 55,
				windowDurationMins: 300,
			},
			secondary: {
				usedPercent: 12,
				windowDurationMins: 10_080,
			},
		});
		expect(snapshot.primary?.resetsAt).toMatch(/^\d{4}-/);
		const records = (await readFile(fake.capture, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { value: { method?: string; params?: Record<string, unknown> } });
		expect(
			records.some(
				(record) =>
					record.value.method === "account/rateLimits/read" &&
					record.value.params?.excludeResetCreditDetails === true,
			),
		).toBe(true);
		await provider.close();
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"normalizes malformed request and turn timeouts: %s",
		async (timeoutMs) => {
			const fake = await fakeAppServer();
			const provider = new CodexAppServerProvider({
				executable: fake.executable,
				requestTimeoutMs: timeoutMs,
				turnTimeoutMs: timeoutMs,
			});
			try {
				await provider.probe();
				await expect(
					provider.complete({
						model: "gpt-test",
						messages: [{ role: "user", content: textContent("First prompt") }],
					}),
				).resolves.toMatchObject({
					providerId: "codex-subscription",
					text: "Persistent answer 1",
				});
			} finally {
				await provider.close();
			}
		},
	);
});
