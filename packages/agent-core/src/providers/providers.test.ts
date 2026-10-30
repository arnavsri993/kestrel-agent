import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider } from "./anthropic-messages";
import { createEnvironmentModelProviders } from "./environment";
import { GeminiGenerateContentProvider } from "./gemini-generate-content";
import { OllamaChatProvider } from "./ollama-chat";
import { OpenAIChatCompletionsProvider } from "./openai-chat-completions";
import { OpenAIResponsesProvider } from "./openai-responses";
import { ProviderPool } from "./provider-pool";
import { type ModelProvider, ModelProviderError, textContent } from "./types";

const servers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Mock server did not expose a port.");
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});

describe("model provider adapters", () => {
	it("creates logical credential pools from protected primary and backup environments", () => {
		const providers = createEnvironmentModelProviders({
			OPENAI_API_KEY: "primary",
			OPENAI_API_KEY_SECONDARY: "backup",
			ANTHROPIC_API_KEY: "primary-a",
			ANTHROPIC_API_KEY_SECONDARY: "backup-a",
			GEMINI_API_KEY: "gemini-key",
		});
		expect(
			providers.map((provider) => ({
				id: provider.id,
				poolId: provider.poolId,
			})),
		).toEqual([
			{ id: "openai-key-1", poolId: "openai" },
			{ id: "openai-key-2", poolId: "openai" },
			{ id: "anthropic-key-1", poolId: "anthropic" },
			{ id: "anthropic-key-2", poolId: "anthropic" },
			{ id: "gemini", poolId: undefined },
		]);
	});

	it("enables vendor-owned subscription authentication without accepting OAuth tokens", () => {
		const providers = createEnvironmentModelProviders({
			KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1",
			KESTREL_CODEX_PATH: "/opt/codex",
			KESTREL_CODEX_SUBSCRIPTION_MODEL: "gpt-subscription",
			KESTREL_ENABLE_CLAUDE_SUBSCRIPTION: "1",
			KESTREL_CLAUDE_PATH: "/opt/claude",
			KESTREL_CLAUDE_SUBSCRIPTION_MODEL: "opus",
			KESTREL_ENABLE_OPENCODE_SUBSCRIPTION: "1",
			KESTREL_OPENCODE_PATH: "/opt/opencode",
			KESTREL_OPENCODE_SUBSCRIPTION_MODEL: "opencode-claude",
			KESTREL_ENABLE_CURSOR_SUBSCRIPTION: "1",
			KESTREL_CURSOR_PATH: "/opt/cursor",
			KESTREL_CURSOR_SUBSCRIPTION_MODEL: "cursor-auto",
		});
		expect(
			providers.map((provider) => ({
				id: provider.id,
				model: provider.defaultModel,
				tools: provider.capabilities.tools,
			})),
		).toEqual([
			{ id: "codex-subscription", model: "gpt-subscription", tools: false },
			{ id: "claude-subscription", model: "opus", tools: false },
			{ id: "opencode-subscription", model: "opencode-claude", tools: false },
			{ id: "cursor-subscription", model: "cursor-auto", tools: false },
		]);
	});

	it("defaults the Codex app-server route to gpt-5.6-sol", () => {
		expect(
			createEnvironmentModelProviders({
				KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1",
			}).map((provider) => [provider.id, provider.defaultModel]),
		).toEqual([["codex-subscription", "gpt-5.6-sol"]]);
	});

	it("registers configured OpenAI-compatible providers, including free routes", () => {
		const providers = createEnvironmentModelProviders({
			NOUS_API_KEY: "nous-key",
			GROQ_API_KEY: "groq-key",
			MISTRAL_API_KEY: "mistral-key",
			OPENROUTER_API_KEY: "openrouter-key",
			CLOUDFLARE_API_KEY: "cloudflare-key",
			CLOUDFLARE_ACCOUNT_ID: "account",
			COHERE_API_KEY: "cohere-key",
			TOKENROUTER_API_KEY: "tokenrouter-key",
			BAI_API_KEY: "bai-key",
			INFERX_API_KEY: "inferx-key",
			ZENMUX_API_KEY: "zenmux-key",
			OPENCODE_API_KEY: "opencode-key",
			SENSENOVA_API_KEY: "sensenova-key",
			GMICLOUD_API_KEY: "gmicloud-key",
			TOKENHARBOR_API_KEY: "tokenharbor-key",
			CLINE_API_KEY: "cline-key",
			COMMAND_CODE_API_KEY: "command-code-key",
			KILO_API_KEY: "kilo-key",
			ORCAROUTER_API_KEY: "orcarouter-key",
			AIHUBMIX_API_KEY: "aihubmix-key",
		});
		expect(
			providers.map((provider) => [provider.id, provider.defaultModel]),
		).toEqual([
			["nous", "stepfun/step-3.7-flash:free"],
			["groq", "openai/gpt-oss-20b"],
			["mistral", "mistral-small-latest"],
			["openrouter", "openrouter/free"],
			["cohere", "command-a-plus-05-2026"],
			["tokenrouter", "qwen/qwen3.8-max-free"],
			["bai", "deepseek-v4-flash"],
			["inferx", "deepseek-v4-flash"],
			["zenmux", "z-ai/glm-4.7-flash-free"],
			["opencode-zen", "mimo-v2.5-free"],
			["sensenova", "deepseek-v4-flash"],
			["gmicloud", "deepseek-ai/DeepSeek-V4-Pro"],
			["tokenharbor", "deepseek-v4-flash:free"],
			["cline", "poolside/laguna-s-2.1:free"],
			["command-code", "poolside/laguna-s-2.1-free"],
			["kilo", "kilo-auto/free"],
			["orcarouter", "orcarouter/free"],
			["aihubmix", "xiaomi-mimo-v2.5-free"],
			["cloudflare", "@cf/openai/gpt-oss-20b"],
		]);
	});

	it("maps OpenAI-compatible chat streaming text, tool calls, and usage", async () => {
		let body: Record<string, unknown> = {};
		const baseUrl = await serve((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
					string,
					unknown
				>;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					[
						`data: ${JSON.stringify({ id: "chat-1", model: "free-model", choices: [{ delta: { content: "Free " } }] })}\n\n`,
						`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "workspace.read", arguments: '{"path":' } }] } }] })}\n\n`,
						`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: "tool_calls" }] })}\n\n`,
						`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } })}\n\n`,
						"data: [DONE]\n\n",
					].join(""),
				);
			});
		});
		const provider = new OpenAIChatCompletionsProvider({
			id: "free",
			apiKey: "secret",
			defaultModel: "free-model",
			baseUrl,
		});
		const result = await provider.complete({
			model: "free-model",
			messages: [{ role: "user", content: textContent("Read") }],
			tools: [
				{
					name: "workspace.read",
					description: "Read",
					inputSchema: { type: "object" },
				},
			],
		});
		expect(body).toMatchObject({
			model: "free-model",
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(result).toMatchObject({
			providerId: "free",
			responseId: "chat-1",
			text: "Free ",
			finishReason: "tool_calls",
			toolCalls: [
				{
					id: "call-1",
					name: "workspace.read",
					arguments: { path: "README.md" },
				},
			],
			usage: { inputTokens: 8, outputTokens: 3 },
		});
	});

	it("normalizes malformed OpenAI-compatible usage metadata", async () => {
		const baseUrl = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: "not-a-number", completion_tokens: -4 } })}\n\ndata: [DONE]\n\n`,
			);
		});
		const provider = new OpenAIChatCompletionsProvider({
			id: "free",
			apiKey: "secret",
			defaultModel: "free-model",
			baseUrl,
		});
		const result = await provider.complete({
			model: "free-model",
			messages: [{ role: "user", content: textContent("hello") }],
		});
		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("uses a configured loopback compatible runtime without an authorization header", async () => {
		let authorization: string | undefined;
		const baseUrl = await serve((request, response) => {
			authorization = request.headers.authorization;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({ id: "local-1", choices: [{ delta: { content: "local result" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		const provider = new OpenAIChatCompletionsProvider({
			id: "local-compatible",
			local: true,
			defaultModel: "local-model",
			baseUrl,
		});

		const result = await provider.complete({
			model: "local-model",
			messages: [{ role: "user", content: textContent("hello") }],
		});
		expect(authorization).toBeUndefined();
		expect(provider.capabilities.local).toBe(true);
		expect(result.text).toBe("local result");
	});

	it("verifies live provider credentials without sending a model prompt", async () => {
		let method = "";
		let authorization = "";
		const baseUrl = await serve((request, response) => {
			method = request.method ?? "";
			authorization = String(request.headers.authorization ?? "");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [] }));
		});
		const pool = new ProviderPool([
			new OpenAIResponsesProvider({ apiKey: "probe-secret", baseUrl }),
		]);
		expect(await pool.verify("openai")).toMatchObject([
			{ providerId: "openai", ok: true, latencyMs: expect.any(Number) },
		]);
		expect(method).toBe("GET");
		expect(authorization).toBe("Bearer probe-secret");
	});

	it("uses HTTP Retry-After to remember provider capacity availability", async () => {
		const baseUrl = await serve((_request, response) => {
			response.writeHead(429, {
				"content-type": "application/json",
				"retry-after": "12",
			});
			response.end(JSON.stringify({ error: { message: "capacity exhausted" } }));
		});
		let nowMs = Date.parse("2026-07-29T12:00:00.000Z");
		const pool = new ProviderPool(
			[
				new OpenAIResponsesProvider({
					apiKey: "probe-secret",
					baseUrl,
				}),
			],
			() => new Date(nowMs),
		);

		await expect(
			pool.complete({
				model: "test",
				messages: [{ role: "user", content: textContent("hello") }],
			}),
		).rejects.toBeInstanceOf(Error);
		expect(pool.health()[0]).toMatchObject({
			unhealthyUntil: "2026-07-29T12:00:12.000Z",
			unhealthyReason: "rate_limit",
		});
		nowMs += 11_000;
		await expect(
			pool.complete({
				model: "test",
				messages: [{ role: "user", content: textContent("hello") }],
			}),
		).rejects.toMatchObject({ attempts: [] });
	});

	it("reports in-flight endpoint requests for account-aware routing", async () => {
		let reportStarted: () => void = () => undefined;
		let release: () => void = () => undefined;
		const started = new Promise<void>((resolvePromise) => {
			reportStarted = resolvePromise;
		});
		const gate = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const provider: ModelProvider = {
			id: "busy-account",
			capabilities: {
				streaming: false,
				tools: false,
				images: false,
				audio: false,
				documents: false,
				local: true,
			},
			complete: async (request) => {
				reportStarted();
				await gate;
				return {
					providerId: "busy-account",
					model: request.model,
					text: "completed",
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					finishReason: "stop",
				};
			},
		};
		const pool = new ProviderPool([provider]);
		const pending = pool.complete({
			model: "fixture",
			messages: [{ role: "user", content: textContent("hello") }],
		});
		await started;
		expect(pool.health()).toMatchObject([
			{ providerId: "busy-account", activeRequests: 1 },
		]);
		release();
		await pending;
		expect(pool.health()).toMatchObject([
			{ providerId: "busy-account", activeRequests: 0 },
		]);
	});

	it("stops provider verification when cancellation wins", async () => {
		const capabilities = {
			streaming: false,
			tools: false,
			images: false,
			audio: false,
			documents: false,
			local: true,
		} as const;
		const controller = new AbortController();
		const calls: string[] = [];
		const provider = (
			id: string,
			probe: (signal?: AbortSignal) => Promise<void>,
		): ModelProvider => ({
			id,
			capabilities,
			probe,
			complete: async () => {
				throw new Error("not used");
			},
		});
		const pool = new ProviderPool([
			provider("first", async () => {
				calls.push("first");
				controller.abort(new Error("verification cancelled"));
			}),
			provider("second", async () => {
				calls.push("second");
			}),
		]);

		await expect(pool.verify("auto", controller.signal)).rejects.toThrow(
			"verification cancelled",
		);
		expect(calls).toEqual(["first"]);

		const before = new AbortController();
		before.abort(new Error("verification cancelled before start"));
		await expect(pool.verify("auto", before.signal)).rejects.toThrow(
			"verification cancelled before start",
		);
		expect(calls).toEqual(["first"]);
	});

	it("maps OpenAI Responses streaming text, multimodal input, tool calls, and usage", async () => {
		let requestBody: Record<string, unknown> = {};
		let authorization = "";
		const baseUrl = await serve((request, response) => {
			authorization = String(request.headers.authorization ?? "");
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requestBody = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					[
						`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Checking " })}\n\n`,
						`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "workspace.read", arguments: '{"path":"README.md"}' } })}\n\n`,
						`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-1", status: "completed", model: "test-openai", usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } })}\n\n`,
					].join(""),
				);
			});
		});
		const provider = new OpenAIResponsesProvider({
			apiKey: "not-a-real-key",
			baseUrl,
		});
		const deltas: string[] = [];
		const result = await provider.complete(
			{
				model: "test-openai",
				reasoningEffort: "high",
				serviceTier: "priority",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Inspect this" },
							{
								type: "image",
								source: "base64",
								mediaType: "image/png",
								data: "aW1hZ2U=",
							},
						],
					},
				],
				tools: [
					{
						name: "workspace.read",
						description: "Read a file",
						inputSchema: {
							type: "object",
							properties: { path: { type: "string" } },
							required: ["path"],
							additionalProperties: false,
						},
					},
				],
			},
			{
				onEvent: (event) => {
					if (event.type === "text_delta") deltas.push(event.delta);
				},
			},
		);
		expect(authorization).toBe("Bearer not-a-real-key");
		expect(requestBody).toMatchObject({
			model: "test-openai",
			stream: true,
			store: false,
			reasoning: { effort: "high" },
			service_tier: "priority",
		});
		expect(JSON.stringify(requestBody)).toContain(
			"data:image/png;base64,aW1hZ2U=",
		);
		expect(result).toMatchObject({
			text: "Checking ",
			finishReason: "tool_calls",
			toolCalls: [
				{
					id: "call-1",
					name: "workspace.read",
					arguments: { path: "README.md" },
				},
			],
			usage: {
				inputTokens: 12,
				outputTokens: 4,
				cachedInputTokens: 2,
				reasoningTokens: 1,
			},
		});
		expect(deltas).toEqual(["Checking "]);
	});

	it("bounds malformed OpenAI Responses usage counts", async () => {
		const baseUrl = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: "not-a-number", output_tokens: -2, input_tokens_details: { cached_tokens: "Infinity" }, output_tokens_details: { reasoning_tokens: 3.9 } } } })}\n\n`,
			);
		});
		const provider = new OpenAIResponsesProvider({
			apiKey: "not-a-real-key",
			baseUrl,
		});

		const result = await provider.complete({
			model: "test-openai",
			messages: [{ role: "user", content: textContent("Count this") }],
		});

		expect(result.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningTokens: 3,
		});
	});

	it("maps Anthropic Messages streaming tool input and usage", async () => {
		let apiVersion = "";
		const baseUrl = await serve((request, response) => {
			apiVersion = String(request.headers["anthropic-version"] ?? "");
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					[
						`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", model: "test-claude", usage: { input_tokens: 9, cache_read_input_tokens: 3 } } })}\n\n`,
						`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-1", name: "workspace.list" } })}\n\n`,
						`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"."}' } })}\n\n`,
						`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } })}\n\n`,
						`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
					].join(""),
				);
			});
		});
		const provider = new AnthropicMessagesProvider({ apiKey: "test", baseUrl });
		const result = await provider.complete({
			model: "test-claude",
			messages: [{ role: "user", content: textContent("List files") }],
		});
		expect(apiVersion).toBe("2023-06-01");
		expect(result).toMatchObject({
			responseId: "msg-1",
			finishReason: "tool_calls",
			toolCalls: [
				{ id: "toolu-1", name: "workspace.list", arguments: { path: "." } },
			],
			usage: { inputTokens: 9, outputTokens: 5, cachedInputTokens: 3 },
		});
	});

	it("bounds malformed Anthropic Messages usage counts", async () => {
		const baseUrl = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				[
					`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: "not-a-number", cache_read_input_tokens: -2 } } })}\n\n`,
					`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: "Infinity" } })}\n\n`,
					'event: message_stop\ndata: {"type":"message_stop"}\n\n',
				].join(""),
			);
		});
		const provider = new AnthropicMessagesProvider({ apiKey: "test", baseUrl });

		const result = await provider.complete({
			model: "test-claude",
			messages: [{ role: "user", content: textContent("Count this") }],
		});

		expect(result.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
		});
	});

	it("discovers confirmed Ollama capabilities without retaining private show fields", async () => {
		const showRequests: string[] = [];
		const baseUrl = await serve((request, response) => {
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models: [{ name: "smollm2:135m" }, { name: "huihui_ai/qwen3.5-abliterated:9b" }, { name: "oversized-context" }] }));
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
				showRequests.push(String(body.model));
				const qwen = body.model === "huihui_ai/qwen3.5-abliterated:9b";
				const oversized = body.model === "oversized-context";
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					modelfile: "PRIVATE_MODEL_FILE /private/path",
					license: "PRIVATE_LICENSE_TEXT",
				template: "PRIVATE_TEMPLATE_TEXT",
				system: "PRIVATE_SYSTEM_TEXT",
				capabilities: qwen ? ["completion", "tools", "vision", "thinking"] : ["completion"],
					model_info: qwen ? { "general.architecture": "qwen3", "qwen3.context_length": 8_192 } : oversized ? { "general.architecture": "llama", "llama.context_length": 1_000_000 } : { "general.architecture": "smollm" },
				}));
			});
		});
		const models = await new OllamaChatProvider({ baseUrl }).discoverModels();
		const completionOnly = models.find((model) => model.id === "smollm2:135m")!;
		const toolModel = models.find((model) => model.id === "huihui_ai/qwen3.5-abliterated:9b")!;
		const oversizedContext = models.find((model) => model.id === "oversized-context")!;
		expect(completionOnly.capabilities).toMatchObject({
			capabilityProvenance: "confirmed",
			tools: false,
			images: false,
			reasoningEfforts: [],
			contextWindow: 32_768,
		});
		expect(toolModel.capabilities).toMatchObject({
			capabilityProvenance: "confirmed",
			tools: true,
			images: true,
			reasoningEfforts: ["none", "medium"],
			contextWindow: 8_192,
		});
		expect(toolModel.capabilities).not.toHaveProperty("structuredOutput");
		expect(oversizedContext.capabilities?.contextWindow).toBe(131_072);
		expect(showRequests.sort()).toEqual(["huihui_ai/qwen3.5-abliterated:9b", "oversized-context", "smollm2:135m"]);
		expect(JSON.stringify(models)).not.toMatch(/PRIVATE_(?:MODEL_FILE|LICENSE_TEXT|TEMPLATE_TEXT|SYSTEM_TEXT)/);
	});

	it("keeps Ollama capabilities unknown when show fails or returns an unrecognized capability", async () => {
		const baseUrl = await serve((request, response) => {
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models: [{ name: "show-fails" }, { name: "show-is-invalid" }] }));
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
				if (body.model === "show-fails") {
					response.writeHead(503);
					response.end("PRIVATE_UPSTREAM_BODY");
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ capabilities: ["completion", "future-capability"] }));
			});
		});
		const models = await new OllamaChatProvider({ baseUrl }).discoverModels();
		expect(models).toHaveLength(2);
		for (const model of models)
			expect(model.capabilities).toMatchObject({ capabilityProvenance: "unknown", contextWindow: 32_768 });
		expect(JSON.stringify(models)).not.toContain("PRIVATE_UPSTREAM_BODY");
	});

	it("limits Ollama show lookups to 64 models and four concurrent requests", async () => {
		let showRequests = 0;
		let activeShows = 0;
		let maximumActiveShows = 0;
		const models = Array.from({ length: 70 }, (_, index) => ({ name: `model-${index}` }));
		const baseUrl = await serve((request, response) => {
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models }));
				return;
			}
			showRequests++;
			activeShows++;
			maximumActiveShows = Math.max(maximumActiveShows, activeShows);
			request.resume();
			request.on("end", () => setTimeout(() => {
				activeShows--;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ capabilities: ["completion"] }));
			}, 5));
		});
		const discovered = await new OllamaChatProvider({ baseUrl }).discoverModels();
		expect(discovered).toHaveLength(64);
		expect(showRequests).toBe(64);
		expect(maximumActiveShows).toBeLessThanOrEqual(4);
	});

	it("propagates caller cancellation from an Ollama show request", async () => {
		let showStarted!: () => void;
		const started = new Promise<void>((resolve) => { showStarted = resolve; });
		const baseUrl = await serve((request, response) => {
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models: [{ name: "slow-show" }] }));
				return;
			}
			request.resume();
			request.on("end", () => showStarted());
		});
		const controller = new AbortController();
		const pending = new OllamaChatProvider({ baseUrl }).discoverModels(controller.signal);
		await started;
		controller.abort(new Error("Canary cancellation"));
		await expect(pending).rejects.toThrow("Canary cancellation");
	});

	it("bounds each Ollama show lookup to one second", async () => {
		let showStarted!: () => void;
		const started = new Promise<void>((resolve) => { showStarted = resolve; });
		const baseUrl = await serve((request, response) => {
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models: [{ name: "timeout-show" }] }));
				return;
			}
			request.resume();
			request.on("end", () => showStarted());
		});
		const provider = new OllamaChatProvider({ baseUrl });
		const startedAt = Date.now();
		const pending = provider.discoverModels();
		await started;
		const models = await pending;
		expect(Date.now() - startedAt).toBeLessThan(1_800);
		expect(models[0]?.capabilities?.capabilityProvenance).toBe("unknown");
	});


	it("maps Ollama NDJSON streaming responses and local tool calls", async () => {
		let requestBody: Record<string, unknown> = {};
		const baseUrl = await serve((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requestBody = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "application/x-ndjson" });
				response.end(
					[
						JSON.stringify({
							message: { role: "assistant", content: "Local ", tool_calls: [] },
							done: false,
						}),
						JSON.stringify({
							message: {
								role: "assistant",
								content: "answer",
								tool_calls: [
									{
										function: {
											name: "workspace.search",
											arguments: { query: "Kestrel" },
										},
									},
								],
							},
							done: false,
						}),
						JSON.stringify({
							message: { role: "assistant", content: "" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 7,
							eval_count: 3,
						}),
					].join("\n"),
				);
			});
		});
		const provider = new OllamaChatProvider({ baseUrl });
		const result = await provider.complete({
			model: "local-test",
			messages: [{ role: "user", content: textContent("Search") }],
		});
		expect(result).toMatchObject({
			providerId: "ollama",
			text: "Local answer",
			finishReason: "tool_calls",
			toolCalls: [
				{ name: "workspace.search", arguments: { query: "Kestrel" } },
			],
			usage: { inputTokens: 7, outputTokens: 3 },
		});
		expect(requestBody.options).toMatchObject({ num_ctx: 32_768 });
		expect(requestBody.think).toBe(false);
	});

	it("allows Ollama chat headers after 20 seconds within the fixed 120 second adapter grace", async () => {
		vi.useFakeTimers();
		const originalFetch = globalThis.fetch;
		let requestSignal: AbortSignal | undefined;
		globalThis.fetch = async (_input, init) =>
			new Promise((resolve, reject) => {
				requestSignal = init?.signal ?? undefined;
				const timer = setTimeout(
					() => resolve(new Response(`${JSON.stringify({ message: { role: "assistant", content: "ready" }, done: true })}\n`)),
					21_000,
				);
				requestSignal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(requestSignal?.reason ?? new DOMException("Aborted", "AbortError"));
				}, { once: true });
			});
		try {
			const pending = new OllamaChatProvider().complete({
				model: "local-test",
				messages: [{ role: "user", content: textContent("ready") }],
			});
			const settled = expect(pending).resolves.toMatchObject({
				text: "ready",
				finishReason: "stop",
			});
			await vi.advanceTimersByTimeAsync(20_500);
			expect(requestSignal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(500);
			await settled;
		} finally {
			globalThis.fetch = originalFetch;
			vi.useRealTimers();
		}
	});

	it("honors caller abort before the Ollama chat connect grace expires", async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		const abortError = new DOMException("Caller stopped local chat", "AbortError");
		globalThis.fetch = async (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		try {
			const pending = new OllamaChatProvider().complete(
				{
					model: "local-test",
					messages: [{ role: "user", content: textContent("ready") }],
				},
				{ signal: controller.signal },
			);
			const rejected = expect(pending).rejects.toBe(abortError);
			controller.abort(abortError);
			await rejected;
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("maps the supported Ollama thinking effort to the chat request", async () => {
		let requestBody: Record<string, unknown> = {};
		const baseUrl = await serve((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "application/x-ndjson" });
				response.end(`${JSON.stringify({ message: { role: "assistant", content: "reasoned" }, done: true })}\n`);
			});
		});
		await new OllamaChatProvider({ baseUrl }).complete({
			model: "thinking-model",
			reasoningEffort: "medium",
			messages: [{ role: "user", content: textContent("Explain briefly") }],
		});
		expect(requestBody.think).toBe(true);
	});

	it("normalizes malformed Ollama usage metadata", async () => {
		const baseUrl = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "application/x-ndjson" });
			response.end(
				`${JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: "not-a-number", eval_count: -4 })}\n`,
			);
		});
		const provider = new OllamaChatProvider({ baseUrl });
		const result = await provider.complete({
			model: "local-test",
			messages: [{ role: "user", content: textContent("hello") }],
		});
		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("maps Gemini video input, tools, and measured usage through the production REST contract", async () => {
		let requestBody: Record<string, unknown> = {};
		let apiKey = "";
		const baseUrl = await serve((request, response) => {
			apiKey = String(request.headers["x-goog-api-key"] ?? "");
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requestBody = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						responseId: "gemini-response",
						candidates: [
							{
								finishReason: "STOP",
								content: {
									role: "model",
									parts: [
										{ text: "At 00:02, " },
										{
											functionCall: {
												name: "workspace.read",
												args: { path: "notes.md" },
											},
											thoughtSignature: "signature-1",
										},
									],
								},
							},
						],
						usageMetadata: {
							promptTokenCount: 44,
							candidatesTokenCount: 7,
							cachedContentTokenCount: 3,
							thoughtsTokenCount: 2,
						},
					}),
				);
			});
		});
		const provider = new GeminiGenerateContentProvider({
			apiKey: "gemini-secret",
			baseUrl,
		});
		const result = await provider.complete({
			model: "gemini-video-test",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this clip" },
						{
							type: "video",
							source: "base64",
							mediaType: "video/mp4",
							data: "AAAAIGZ0eXA=",
						},
					],
				},
			],
			tools: [
				{
					name: "workspace.read",
					description: "Read notes",
					inputSchema: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
		});
		expect(apiKey).toBe("gemini-secret");
		expect(JSON.stringify(requestBody)).toContain('"mimeType":"video/mp4"');
		expect(JSON.stringify(requestBody)).toContain('"functionDeclarations"');
		expect(result).toMatchObject({
			providerId: "gemini",
			responseId: "gemini-response",
			text: "At 00:02, ",
			finishReason: "tool_calls",
			toolCalls: [
				{
					name: "workspace.read",
					arguments: { path: "notes.md" },
					thoughtSignature: "signature-1",
				},
			],
			usage: {
				inputTokens: 44,
				outputTokens: 7,
				cachedInputTokens: 3,
				reasoningTokens: 2,
			},
		});
	});

	it("preserves Gemini thought signatures across tool continuations", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const baseUrl = await serve((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requestBodies.push(
					JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
						string,
						unknown
					>,
				);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						candidates: [
							{
								finishReason: "STOP",
								content: {
									role: "model",
									parts: [
										{
											functionCall: {
												name: "workspace.read",
												args: { path: "notes.md" },
											},
											thoughtSignature: "signature-2",
										},
									],
								},
							},
						],
					}),
				);
			});
		});
		const provider = new GeminiGenerateContentProvider({
			apiKey: "gemini-secret",
			baseUrl,
		});
		const tools = [
			{
				name: "workspace.read",
				description: "Read notes",
				inputSchema: { type: "object" },
			},
		];
		const first = await provider.complete({
			model: "gemini-test",
			messages: [{ role: "user", content: textContent("Read notes") }],
			tools,
		});
		const call = first.toolCalls[0]!;
		await provider.complete({
			model: "gemini-test",
			messages: [
				{ role: "user", content: textContent("Read notes") },
				{ role: "assistant", content: [], toolCalls: [call] },
				{
					role: "tool",
					content: textContent('{"ok":true}'),
					toolCallId: call.id,
					toolName: call.name,
				},
			],
			tools,
		});
		const contents = requestBodies[1]?.contents as Array<Record<string, unknown>>;
		const modelParts = (contents[1]?.parts ?? []) as Array<Record<string, unknown>>;
		expect(modelParts[0]).toMatchObject({
			functionCall: { name: "workspace.read", args: { path: "notes.md" } },
			thoughtSignature: "signature-2",
		});
	});

	it("normalizes malformed Gemini usage metadata", async () => {
		const baseUrl = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					candidates: [
						{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } },
					],
					usageMetadata: {
						promptTokenCount: "not-a-number",
						candidatesTokenCount: -4,
						cachedContentTokenCount: "Infinity",
						thoughtsTokenCount: "2.9",
					},
				}),
			);
		});
		const provider = new GeminiGenerateContentProvider({
			apiKey: "gemini-secret",
			baseUrl,
		});
		const result = await provider.complete({
			model: "gemini-test",
			messages: [{ role: "user", content: textContent("hello") }],
		});
		expect(result.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningTokens: 2,
		});
	});

	it("escalates to a different endpoint after a failed strategy and records both attempts", async () => {
		const failing: ModelProvider = {
			id: "failing",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async () => {
				throw new ModelProviderError(
					"unsupported model strategy",
					"failing",
					false,
					400,
				);
			},
		};
		const succeeding: ModelProvider = {
			id: "succeeding",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: true,
			},
			complete: async (request) => ({
				providerId: "succeeding",
				model: request.model,
				text: "ok",
				toolCalls: [],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			}),
		};
		const pool = new ProviderPool([failing, succeeding]);
		const output = await pool.complete({
			model: "test",
			messages: [{ role: "user", content: textContent("hello") }],
		});
		expect(output.result.text).toBe("ok");
		expect(
			output.attempts.map((attempt) => [attempt.providerId, attempt.status]),
		).toEqual([
			["failing", "failed"],
			["succeeding", "completed"],
		]);
	});

	it("keeps only normalized endpoint quota observations for account-aware routing", async () => {
		let exposesQuota = true;
		const provider: ModelProvider = {
			id: "account-endpoint",
			poolId: "logical-provider",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async (request) => ({
				providerId: "account-endpoint",
				model: request.model,
				text: "ok",
				toolCalls: [],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
				...(exposesQuota
					? {
						quota: {
							confidence: "exact" as const,
							remainingFraction: 0.2,
							resetAt: "2026-09-08T12:00:00.000Z",
						},
					}
					: {}),
			}),
		};
		const pool = new ProviderPool([provider], () =>
			new Date("2026-09-07T12:00:00.000Z"),
		);
		await pool.complete({
			model: "test",
			messages: [{ role: "user", content: textContent("hello") }],
		});

		expect(pool.accountQuotaSnapshots()).toEqual([
			{
				endpointId: "account-endpoint",
				providerId: "account-endpoint",
				poolId: "logical-provider",
				confidence: "exact",
				remainingFraction: 0.2,
				resetAt: "2026-09-08T12:00:00.000Z",
			},
		]);
		exposesQuota = false;
		await pool.complete({
			model: "test",
			messages: [{ role: "user", content: textContent("hello again") }],
		});
		expect(pool.accountQuotaSnapshots()).toEqual([]);
	});

	it("rotates nonretryable credential failures inside one logical provider pool", async () => {
		const invalid: ModelProvider = {
			id: "openai-key-1",
			poolId: "openai",
			capabilities: {
				streaming: true,
				tools: true,
				images: true,
				audio: true,
				documents: true,
				local: false,
			},
			complete: async () => {
				throw new ModelProviderError(
					"invalid credential",
					"openai-key-1",
					false,
					401,
				);
			},
		};
		const valid: ModelProvider = {
			id: "openai-key-2",
			poolId: "openai",
			capabilities: invalid.capabilities,
			complete: async (request) => ({
				providerId: "openai-key-2",
				model: request.model,
				text: "pooled",
				toolCalls: [],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			}),
		};
		const pool = new ProviderPool([invalid, valid]);
		const output = await pool.complete(
			{
				model: "test",
				messages: [{ role: "user", content: textContent("hello") }],
			},
			{ providerIds: ["openai"], automaticRouting: true },
		);
		expect(output.result.providerId).toBe("openai-key-2");
		expect(output.attempts.map((attempt) => attempt.providerId)).toEqual([
			"openai-key-1",
			"openai-key-2",
		]);
		expect(pool.health()).toMatchObject([
			{
				providerId: "openai-key-1",
				poolId: "openai",
				failures: 1,
				consecutiveFailures: 1,
			},
			{
				providerId: "openai-key-2",
				poolId: "openai",
				successes: 1,
				consecutiveFailures: 0,
			},
		]);
	});

	it("does not expand a manually selected provider label across multiple accounts", async () => {
		const calls: string[] = [];
		const account = (id: string): ModelProvider => ({
			id,
			poolId: "openai",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async (request) => {
				calls.push(id);
				return {
					providerId: id,
					model: request.model,
					text: "unexpected",
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					finishReason: "stop",
				};
			},
		});
		const pool = new ProviderPool([account("personal"), account("work")]);

		await expect(
			pool.complete(
				{
					model: "gpt-account-scoped",
					messages: [{ role: "user", content: textContent("hello") }],
				},
				{ providerIds: ["openai"] },
			),
		).rejects.toThrow("Select a specific account endpoint");
		expect(calls).toEqual([]);
	});

	it("gives an exact account endpoint precedence over a matching provider alias", async () => {
		const calls: string[] = [];
		const provider = (id: string, poolId?: string): ModelProvider => ({
			id,
			...(poolId ? { poolId } : {}),
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async (request) => {
				calls.push(id);
				return {
					providerId: id,
					model: request.model,
					text: id,
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					finishReason: "stop",
				};
			},
		});
		const pool = new ProviderPool([
			provider("account-personal"),
			provider("other-account", "account-personal"),
		]);

		const result = await pool.complete(
			{
				model: "exact-model",
				messages: [{ role: "user", content: textContent("hello") }],
			},
			{ providerIds: ["account-personal"] },
		);
		expect(result.result.providerId).toBe("account-personal");
		expect(calls).toEqual(["account-personal"]);
	});

	it("automatically ranks eligible providers by measured cost and stops budget-blocked retries", async () => {
		const calls: string[] = [];
		const provider = (id: string, retryable = false): ModelProvider => ({
			id,
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async (request) => {
				calls.push(id);
				if (retryable) throw new ModelProviderError("temporary", id, true, 503);
				return {
					providerId: id,
					model: request.model,
					text: id,
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					finishReason: "stop",
				};
			},
		});
		const routed = new ProviderPool([provider("expensive"), provider("cheap")]);
		const result = await routed.complete(
			{
				model: "test",
				messages: [{ role: "user", content: textContent("route") }],
			},
			{
				automaticRouting: true,
				costScore: (id) => (id === "cheap" ? 0.001 : 1),
			},
		);
		expect(result.result.providerId).toBe("cheap");
		expect(calls).toEqual(["cheap"]);

		const budgeted = new ProviderPool([
			provider("first", true),
			provider("second"),
		]);
		await expect(
			budgeted.complete(
				{
					model: "test",
					messages: [{ role: "user", content: textContent("route") }],
				},
				{ canAttempt: (_id, _model, attempt) => attempt === 0 },
			),
		).rejects.toMatchObject({
			attempts: [
				{ providerId: "first", status: "failed" },
				{
					providerId: "second",
					error: "Budget policy blocked this provider attempt.",
				},
			],
		});
	});

	it("backs off a final failing provider instead of retrying it immediately", async () => {
		let nowMs = Date.parse("2026-07-29T12:00:00.000Z");
		let calls = 0;
		const provider: ModelProvider = {
			id: "only",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async () => {
				calls += 1;
				throw new ModelProviderError("temporary", "only", true, 503);
			},
		};
		const pool = new ProviderPool([provider], () => new Date(nowMs));
		const request = {
			model: "test",
			messages: [{ role: "user" as const, content: textContent("retry") }],
		};
		await expect(pool.complete(request)).rejects.toMatchObject({
			attempts: [{ providerId: "only", status: "failed" }],
		});
		expect(pool.health()[0]).toMatchObject({
			providerId: "only",
			failures: 1,
			unhealthyUntil: "2026-07-29T12:00:30.000Z",
			unhealthyReason: "transient",
		});
		await expect(pool.complete(request)).rejects.toMatchObject({
			attempts: [],
		});
		expect(calls).toBe(1);
		nowMs += 30_001;
		await expect(pool.complete(request)).rejects.toMatchObject({
			attempts: [{ providerId: "only", status: "failed" }],
		});
		expect(calls).toBe(2);
	});

	it("uses exponential availability backoff after repeated transient failures", async () => {
		let nowMs = Date.parse("2026-07-29T12:00:00.000Z");
		let calls = 0;
		const provider: ModelProvider = {
			id: "only",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async () => {
				calls += 1;
				throw new ModelProviderError("temporary", "only", true, 503);
			},
		};
		const pool = new ProviderPool([provider], () => new Date(nowMs));
		const request = {
			model: "test",
			messages: [{ role: "user" as const, content: textContent("retry") }],
		};

		await expect(pool.complete(request, { healthBackoffMs: 1_000 })).rejects.toThrow();
		nowMs += 1_001;
		await expect(pool.complete(request, { healthBackoffMs: 1_000 })).rejects.toThrow();
		expect(pool.health()[0]).toMatchObject({
			failures: 2,
			unhealthyUntil: "2026-07-29T12:00:03.001Z",
		});
		expect(calls).toBe(2);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"normalizes malformed provider health backoffs: %s",
		async (healthBackoffMs) => {
			const provider: ModelProvider = {
				id: "only",
				capabilities: {
					streaming: true,
					tools: true,
					images: false,
					audio: false,
					documents: false,
					local: false,
				},
				complete: async () => {
					throw new ModelProviderError("temporary", "only", true, 503);
				},
			};
			const pool = new ProviderPool(
				[provider],
				() => new Date("2026-07-29T12:00:00.000Z"),
			);

			await expect(
				pool.complete(
					{
						model: "test",
						messages: [{ role: "user", content: textContent("retry") }],
					},
					{ healthBackoffMs },
				),
			).rejects.toBeInstanceOf(Error);
			expect(pool.health()[0]).toMatchObject({
				unhealthyUntil: "2026-07-29T12:00:30.000Z",
			});
		},
	);

	it("routes multimodal automatic requests only to capable providers", async () => {
		const incapable: ModelProvider = {
			id: "text-only",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			complete: async () => {
				throw new Error("must not run");
			},
		};
		const capable: ModelProvider = {
			id: "vision",
			capabilities: { ...incapable.capabilities, images: true },
			complete: async (request) => ({
				providerId: "vision",
				model: request.model,
				text: "seen",
				toolCalls: [],
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			}),
		};
		const output = await new ProviderPool([incapable, capable]).complete(
			{
				model: "vision-model",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								source: "base64",
								mediaType: "image/png",
								data: "aW1hZ2U=",
							},
						],
					},
				],
			},
			{ automaticRouting: true },
		);
		expect(output.result.providerId).toBe("vision");
		expect(output.attempts).toMatchObject([
			{
				providerId: "text-only",
				error: "Provider capabilities do not support this request.",
			},
			{ providerId: "vision", status: "completed" },
		]);
	});
});
