import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "./anthropic-messages";
import { OllamaChatProvider } from "./ollama-chat";
import { OpenAIResponsesProvider } from "./openai-responses";
import { GeminiGenerateContentProvider } from "./gemini-generate-content";
import { ProviderPool } from "./provider-pool";
import { createEnvironmentModelProviders } from "./environment";
import { ModelProviderError, textContent, type ModelProvider } from "./types";
import { OpenAIChatCompletionsProvider } from "./openai-chat-completions";

const servers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not expose a port.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("model provider adapters", () => {
  it("creates logical credential pools from protected primary and backup environments", () => {
    const providers = createEnvironmentModelProviders({ OPENAI_API_KEY: "primary", OPENAI_API_KEY_SECONDARY: "backup", ANTHROPIC_API_KEY: "primary-a", ANTHROPIC_API_KEY_SECONDARY: "backup-a", GEMINI_API_KEY: "gemini-key" });
    expect(providers.map((provider) => ({ id: provider.id, poolId: provider.poolId }))).toEqual([
      { id: "openai-key-1", poolId: "openai" }, { id: "openai-key-2", poolId: "openai" },
      { id: "anthropic-key-1", poolId: "anthropic" }, { id: "anthropic-key-2", poolId: "anthropic" },
      { id: "gemini", poolId: undefined }
    ]);
  });

  it("enables vendor-owned subscription authentication without accepting OAuth tokens", () => {
    const providers = createEnvironmentModelProviders({
      KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1", KESTREL_CODEX_PATH: "/opt/codex", KESTREL_CODEX_SUBSCRIPTION_MODEL: "gpt-subscription",
      KESTREL_ENABLE_CLAUDE_SUBSCRIPTION: "1", KESTREL_CLAUDE_PATH: "/opt/claude", KESTREL_CLAUDE_SUBSCRIPTION_MODEL: "opus"
    });
    expect(providers.map((provider) => ({ id: provider.id, model: provider.defaultModel, tools: provider.capabilities.tools }))).toEqual([
      { id: "codex-subscription", model: "gpt-subscription", tools: false },
      { id: "claude-subscription", model: "opus", tools: false }
    ]);
  });

  it("registers free-tier OpenAI-compatible providers for automatic routing", () => {
    const providers = createEnvironmentModelProviders({
      NOUS_API_KEY: "nous-key", GROQ_API_KEY: "groq-key", MISTRAL_API_KEY: "mistral-key",
      OPENROUTER_API_KEY: "openrouter-key", CLOUDFLARE_API_KEY: "cloudflare-key", CLOUDFLARE_ACCOUNT_ID: "account", COHERE_API_KEY: "cohere-key"
    });
    expect(providers.map((provider) => [provider.id, provider.defaultModel])).toEqual([
      ["nous", "stepfun/step-3.7-flash:free"],
      ["groq", "openai/gpt-oss-20b"],
      ["mistral", "mistral-small-latest"],
      ["openrouter", "openrouter/free"],
      ["cohere", "command-a-plus-05-2026"],
      ["cloudflare", "@cf/openai/gpt-oss-20b"]
    ]);
  });

  it("maps OpenAI-compatible chat streaming text, tool calls, and usage", async () => {
    let body: Record<string, unknown> = {};
    const baseUrl = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ id: "chat-1", model: "free-model", choices: [{ delta: { content: "Free " } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "workspace.read", arguments: "{\"path\":" } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } })}\n\n`,
          "data: [DONE]\n\n"
        ].join(""));
      });
    });
    const provider = new OpenAIChatCompletionsProvider({ id: "free", apiKey: "secret", defaultModel: "free-model", baseUrl });
    const result = await provider.complete({
      model: "free-model",
      messages: [{ role: "user", content: textContent("Read") }],
      tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }]
    });
    expect(body).toMatchObject({ model: "free-model", stream: true, stream_options: { include_usage: true } });
    expect(result).toMatchObject({
      providerId: "free", responseId: "chat-1", text: "Free ", finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "workspace.read", arguments: { path: "README.md" } }],
      usage: { inputTokens: 8, outputTokens: 3 }
    });
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
    const pool = new ProviderPool([new OpenAIResponsesProvider({ apiKey: "probe-secret", baseUrl })]);
    expect(await pool.verify("openai")).toMatchObject([{ providerId: "openai", ok: true, latencyMs: expect.any(Number) }]);
    expect(method).toBe("GET");
    expect(authorization).toBe("Bearer probe-secret");
  });


  it("maps OpenAI Responses streaming text, multimodal input, tool calls, and usage", async () => {
    let requestBody: Record<string, unknown> = {};
    let authorization = "";
    const baseUrl = await serve((request, response) => {
      authorization = String(request.headers.authorization ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Checking " })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "workspace.read", arguments: "{\"path\":\"README.md\"}" } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-1", status: "completed", model: "test-openai", usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } })}\n\n`
        ].join(""));
      });
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "not-a-real-key", baseUrl });
    const deltas: string[] = [];
    const result = await provider.complete({
      model: "test-openai",
      reasoningEffort: "high",
      serviceTier: "priority",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          { type: "image", source: "base64", mediaType: "image/png", data: "aW1hZ2U=" }
        ]
      }],
      tools: [{ name: "workspace.read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }]
    }, { onEvent: (event) => { if (event.type === "text_delta") deltas.push(event.delta); } });
    expect(authorization).toBe("Bearer not-a-real-key");
    expect(requestBody).toMatchObject({ model: "test-openai", stream: true, store: false, reasoning: { effort: "high" }, service_tier: "priority" });
    expect(JSON.stringify(requestBody)).toContain("data:image/png;base64,aW1hZ2U=");
    expect(result).toMatchObject({
      text: "Checking ",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "workspace.read", arguments: { path: "README.md" } }],
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2, reasoningTokens: 1 }
    });
    expect(deltas).toEqual(["Checking "]);
  });

  it("maps Anthropic Messages streaming tool input and usage", async () => {
    let apiVersion = "";
    const baseUrl = await serve((request, response) => {
      apiVersion = String(request.headers["anthropic-version"] ?? "");
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", model: "test-claude", usage: { input_tokens: 9, cache_read_input_tokens: 3 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-1", name: "workspace.list" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\".\"}" } })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
        ].join(""));
      });
    });
    const provider = new AnthropicMessagesProvider({ apiKey: "test", baseUrl });
    const result = await provider.complete({ model: "test-claude", messages: [{ role: "user", content: textContent("List files") }] });
    expect(apiVersion).toBe("2023-06-01");
    expect(result).toMatchObject({
      responseId: "msg-1",
      finishReason: "tool_calls",
      toolCalls: [{ id: "toolu-1", name: "workspace.list", arguments: { path: "." } }],
      usage: { inputTokens: 9, outputTokens: 5, cachedInputTokens: 3 }
    });
  });

  it("maps Ollama NDJSON streaming responses and local tool calls", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end([
          JSON.stringify({ message: { role: "assistant", content: "Local ", tool_calls: [] }, done: false }),
          JSON.stringify({ message: { role: "assistant", content: "answer", tool_calls: [{ function: { name: "workspace.search", arguments: { query: "Kestrel" } } }] }, done: false }),
          JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 3 })
        ].join("\n"));
      });
    });
    const provider = new OllamaChatProvider({ baseUrl });
    const result = await provider.complete({ model: "local-test", messages: [{ role: "user", content: textContent("Search") }] });
    expect(result).toMatchObject({
      providerId: "ollama",
      text: "Local answer",
      finishReason: "tool_calls",
      toolCalls: [{ name: "workspace.search", arguments: { query: "Kestrel" } }],
      usage: { inputTokens: 7, outputTokens: 3 }
    });
    expect(requestBody.options).toMatchObject({ num_ctx: 32_768 });
    expect(requestBody.think).toBe(false);
  });

  it("normalizes a non-finite Ollama context window before sending it", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      });
    });
    const provider = new OllamaChatProvider({ baseUrl, contextWindow: Number.NaN });
    await provider.complete({ model: "local-test", messages: [{ role: "user", content: textContent("Check") }] });
    expect(requestBody.options).toMatchObject({ num_ctx: 32_768 });
  });

  it("maps Gemini video input, tools, and measured usage through the production REST contract", async () => {
    let requestBody: Record<string, unknown> = {};
    let apiKey = "";
    const baseUrl = await serve((request, response) => {
      apiKey = String(request.headers["x-goog-api-key"] ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ responseId: "gemini-response", candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "At 00:02, " }, { functionCall: { name: "workspace.read", args: { path: "notes.md" } } }] } }], usageMetadata: { promptTokenCount: 44, candidatesTokenCount: 7, cachedContentTokenCount: 3, thoughtsTokenCount: 2 } }));
      });
    });
    const provider = new GeminiGenerateContentProvider({ apiKey: "gemini-secret", baseUrl });
    const result = await provider.complete({ model: "gemini-video-test", messages: [{ role: "user", content: [{ type: "text", text: "Describe this clip" }, { type: "video", source: "base64", mediaType: "video/mp4", data: "AAAAIGZ0eXA=" }] }], tools: [{ name: "workspace.read", description: "Read notes", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] });
    expect(apiKey).toBe("gemini-secret");
    expect(JSON.stringify(requestBody)).toContain('"mimeType":"video/mp4"');
    expect(JSON.stringify(requestBody)).toContain('"functionDeclarations"');
    expect(result).toMatchObject({ providerId: "gemini", responseId: "gemini-response", text: "At 00:02, ", finishReason: "tool_calls", toolCalls: [{ name: "workspace.read", arguments: { path: "notes.md" } }], usage: { inputTokens: 44, outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 2 } });
  });

  it("escalates to a different endpoint after a failed strategy and records both attempts", async () => {
    const failing: ModelProvider = {
      id: "failing",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false },
      complete: async () => { throw new ModelProviderError("unsupported model strategy", "failing", false, 400); }
    };
    const succeeding: ModelProvider = {
      id: "succeeding",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true },
      complete: async (request) => ({ providerId: "succeeding", model: request.model, text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" })
    };
    const pool = new ProviderPool([failing, succeeding]);
    const output = await pool.complete({ model: "test", messages: [{ role: "user", content: textContent("hello") }] });
    expect(output.result.text).toBe("ok");
    expect(output.attempts.map((attempt) => [attempt.providerId, attempt.status])).toEqual([
      ["failing", "failed"],
      ["succeeding", "completed"]
    ]);
  });

  it("rotates nonretryable credential failures inside one logical provider pool", async () => {
    const invalid: ModelProvider = {
      id: "openai-key-1", poolId: "openai",
      capabilities: { streaming: true, tools: true, images: true, audio: true, documents: true, local: false },
      complete: async () => { throw new ModelProviderError("invalid credential", "openai-key-1", false, 401); }
    };
    const valid: ModelProvider = {
      id: "openai-key-2", poolId: "openai",
      capabilities: invalid.capabilities,
      complete: async (request) => ({ providerId: "openai-key-2", model: request.model, text: "pooled", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" })
    };
    const pool = new ProviderPool([invalid, valid]);
    const output = await pool.complete({ model: "test", messages: [{ role: "user", content: textContent("hello") }] }, { providerIds: ["openai"] });
    expect(output.result.providerId).toBe("openai-key-2");
    expect(output.attempts.map((attempt) => attempt.providerId)).toEqual(["openai-key-1", "openai-key-2"]);
    expect(pool.health()).toMatchObject([
      { providerId: "openai-key-1", poolId: "openai", failures: 1, consecutiveFailures: 1 },
      { providerId: "openai-key-2", poolId: "openai", successes: 1, consecutiveFailures: 0 }
    ]);
  });

  it("automatically ranks eligible providers by measured cost and stops budget-blocked retries", async () => {
    const calls: string[] = [];
    const provider = (id: string, retryable = false): ModelProvider => ({
      id,
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false },
      complete: async (request) => {
        calls.push(id);
        if (retryable) throw new ModelProviderError("temporary", id, true, 503);
        return { providerId: id, model: request.model, text: id, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
      }
    });
    const routed = new ProviderPool([provider("expensive"), provider("cheap")]);
    const result = await routed.complete({ model: "test", messages: [{ role: "user", content: textContent("route") }] }, { automaticRouting: true, costScore: (id) => id === "cheap" ? 0.001 : 1 });
    expect(result.result.providerId).toBe("cheap");
    expect(calls).toEqual(["cheap"]);

    const budgeted = new ProviderPool([provider("first", true), provider("second")]);
    await expect(budgeted.complete({ model: "test", messages: [{ role: "user", content: textContent("route") }] }, { canAttempt: (_id, _model, attempt) => attempt === 0 })).rejects.toMatchObject({ attempts: [{ providerId: "first", status: "failed" }, { providerId: "second", error: "Budget policy blocked this provider attempt." }] });
  });

  it("backs off a final failing provider instead of retrying it immediately", async () => {
    let nowMs = Date.parse("2026-07-29T12:00:00.000Z");
    let calls = 0;
    const provider: ModelProvider = {
      id: "only",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false },
      complete: async () => {
        calls += 1;
        throw new ModelProviderError("temporary", "only", true, 503);
      },
    };
    const pool = new ProviderPool([provider], () => new Date(nowMs));
    const request = { model: "test", messages: [{ role: "user" as const, content: textContent("retry") }] };
    await expect(pool.complete(request)).rejects.toMatchObject({ attempts: [{ providerId: "only", status: "failed" }] });
    expect(pool.health()[0]).toMatchObject({
      providerId: "only",
      failures: 1,
      unhealthyUntil: "2026-07-29T12:00:30.000Z",
    });
    await expect(pool.complete(request)).rejects.toMatchObject({ attempts: [] });
    expect(calls).toBe(1);
    nowMs += 30_001;
    await expect(pool.complete(request)).rejects.toMatchObject({ attempts: [{ providerId: "only", status: "failed" }] });
    expect(calls).toBe(2);
  });

  it("routes multimodal automatic requests only to capable providers", async () => {
    const incapable: ModelProvider = { id: "text-only", capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false }, complete: async () => { throw new Error("must not run"); } };
    const capable: ModelProvider = { id: "vision", capabilities: { ...incapable.capabilities, images: true }, complete: async (request) => ({ providerId: "vision", model: request.model, text: "seen", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };
    const output = await new ProviderPool([incapable, capable]).complete({ model: "vision-model", messages: [{ role: "user", content: [{ type: "image", source: "base64", mediaType: "image/png", data: "aW1hZ2U=" }] }] }, { automaticRouting: true });
    expect(output.result.providerId).toBe("vision");
    expect(output.attempts).toMatchObject([{ providerId: "text-only", error: "Provider capabilities do not support this request." }, { providerId: "vision", status: "completed" }]);
  });
});
