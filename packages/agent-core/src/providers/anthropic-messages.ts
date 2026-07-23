import { providerFetch, readServerSentEvents } from "./http";
import {
  ModelProviderError,
  contentText,
  safeJsonObject,
  type ModelCallOptions,
  type ModelContentPart,
  type ModelFinishReason,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall
} from "./types";

export interface AnthropicMessagesProviderOptions {
  apiKey: string;
  id?: string;
  poolId?: string;
  defaultModel?: string;
  baseUrl?: string;
  version?: string;
}

function contentPart(part: ModelContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "audio") throw new Error("Anthropic Messages does not support audio input in this adapter.");
  if (part.type === "video") throw new Error("Anthropic Messages does not support video input in this adapter.");
  const source = part.source === "url"
    ? { type: "url", url: part.data }
    : { type: "base64", media_type: part.mediaType, data: part.data };
  return part.type === "image" ? { type: "image", source } : { type: "document", source, ...(part.name ? { title: part.name } : {}) };
}

function anthropicMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("Anthropic tool results require toolCallId.");
      output.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: contentText(message.content) }]
      });
      continue;
    }
    output.push({
      role: message.role,
      content: [
        ...message.content.map(contentPart),
        ...(message.toolCalls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments }))
      ]
    });
  }
  return output;
}

function mapStopReason(value: unknown, hasTools: boolean): ModelFinishReason {
  if (hasTools || value === "tool_use") return "tool_calls";
  if (value === "end_turn" || value === "stop_sequence" || value === "pause_turn") return "stop";
  if (value === "max_tokens") return "length";
  if (value === "refusal") return "refusal";
  return "unknown";
}

export class AnthropicMessagesProvider implements ModelProvider {
  readonly id: string;
  readonly poolId?: string;
  readonly defaultModel?: string;
  readonly capabilities = { streaming: true, tools: true, images: true, audio: false, documents: true, local: false } as const;
  private readonly baseUrl: string;

  constructor(private readonly options: AnthropicMessagesProviderOptions) {
    if (!options.apiKey) throw new Error("Anthropic API key is required.");
    this.id = options.id ?? "anthropic";
    if (options.poolId) this.poolId = options.poolId;
    if (options.defaultModel) this.defaultModel = options.defaultModel;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await providerFetch(this.id, `${this.baseUrl}/v1/models?limit=1`, { method: "GET", headers: { "x-api-key": this.options.apiKey, "anthropic-version": this.options.version ?? "2023-06-01" }, ...(signal ? { signal } : {}) });
    await response.body?.cancel();
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResult> {
    const system = request.messages.filter((message) => message.role === "system")
      .map((message) => contentText(message.content)).filter(Boolean).join("\n\n");
    const response = await providerFetch(this.id, `${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.options.apiKey,
        "anthropic-version": this.options.version ?? "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 8_192,
        messages: anthropicMessages(request.messages),
        stream: true,
        ...(system ? { system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
        } : {}),
        ...(request.metadata?.user_id ? { metadata: { user_id: request.metadata.user_id } } : {})
      }),
      ...(options.signal ? { signal: options.signal } : {})
    });

    let text = "";
    let responseId: string | undefined;
    let responseModel = request.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let stopReason: unknown;
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    await readServerSentEvents(response, this.id, ({ data }) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new ModelProviderError("Anthropic returned malformed streaming JSON.", this.id, false);
      }
      if (event.type === "message_start") {
        const message = (event.message as Record<string, unknown> | undefined) ?? {};
        if (typeof message.id === "string") responseId = message.id;
        if (typeof message.model === "string") responseModel = message.model;
        const usage = (message.usage as Record<string, unknown> | undefined) ?? {};
        inputTokens = Number(usage.input_tokens ?? 0);
        cachedInputTokens = Number(usage.cache_read_input_tokens ?? 0);
      }
      if (event.type === "content_block_start") {
        const block = (event.content_block as Record<string, unknown> | undefined) ?? {};
        if (block.type === "tool_use" && typeof event.index === "number") {
          blocks.set(event.index, { id: String(block.id), name: String(block.name), json: "" });
        }
      }
      if (event.type === "content_block_delta") {
        const delta = (event.delta as Record<string, unknown> | undefined) ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          options.onEvent?.({ type: "text_delta", delta: delta.text });
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof event.index === "number") {
          const block = blocks.get(event.index);
          if (block) {
            block.json += delta.partial_json;
            options.onEvent?.({ type: "tool_call_delta", callId: block.id, name: block.name, argumentsDelta: delta.partial_json });
          }
        }
      }
      if (event.type === "message_delta") {
        const delta = (event.delta as Record<string, unknown> | undefined) ?? {};
        const usage = (event.usage as Record<string, unknown> | undefined) ?? {};
        stopReason = delta.stop_reason;
        outputTokens = Number(usage.output_tokens ?? outputTokens);
      }
      if (event.type === "error") {
        const error = (event.error as Record<string, unknown> | undefined) ?? {};
        const retryable = error.type === "overloaded_error" || error.type === "api_error";
        throw new ModelProviderError(`Anthropic stream error: ${String(error.message ?? "unknown error")}`, this.id, retryable);
      }
    });
    const toolCalls: ModelToolCall[] = [...blocks.values()].map((block) => ({
      id: block.id,
      name: block.name,
      arguments: safeJsonObject(block.json || "{}")
    }));
    const result: ModelResult = {
      providerId: this.id,
      model: responseModel,
      ...(responseId ? { responseId } : {}),
      text,
      toolCalls,
      usage: { inputTokens, outputTokens, cachedInputTokens },
      finishReason: mapStopReason(stopReason, toolCalls.length > 0)
    };
    options.onEvent?.({ type: "completed", result });
    return result;
  }
}
