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

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  id?: string;
  poolId?: string;
  defaultModel?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
}

function inputPart(part: ModelContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "image") return {
    type: "input_image",
    image_url: part.source === "url" ? part.data : `data:${part.mediaType};base64,${part.data}`
  };
  if (part.type === "audio") {
    if (part.source === "url") throw new Error("OpenAI audio input requires base64 data in this adapter.");
    const format = part.mediaType.includes("wav") ? "wav" : "mp3";
    return { type: "input_audio", input_audio: { data: part.data, format } };
  }
  if (part.type === "video") throw new Error("OpenAI Responses does not support direct video input in this adapter.");
  return part.source === "url"
    ? { type: "input_file", file_url: part.data }
    : { type: "input_file", file_data: `data:${part.mediaType};base64,${part.data}`, filename: part.name ?? "attachment" };
}

function inputItems(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("OpenAI tool results require toolCallId.");
      items.push({ type: "function_call_output", call_id: message.toolCallId, output: contentText(message.content) });
      continue;
    }
    const content = message.content.map(inputPart);
    items.push({ type: "message", role: message.role, content });
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments)
      });
    }
  }
  return items;
}

function finishReason(response: Record<string, unknown>, toolCalls: ModelToolCall[]): ModelFinishReason {
  if (toolCalls.length > 0) return "tool_calls";
  if (response.status === "incomplete") return "length";
  if (response.status === "cancelled") return "cancelled";
  if (response.status === "completed") return "stop";
  return "unknown";
}

function usageCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly poolId?: string;
  readonly defaultModel?: string;
  readonly capabilities = { streaming: true, tools: true, images: true, audio: true, documents: true, local: false } as const;
  readonly profileHints = {
    features: { structuredOutput: true, reasoningLevels: true, fastMode: true },
  } as const;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAI API key is required.");
    this.id = options.id ?? "openai";
    if (options.poolId) this.poolId = options.poolId;
    this.defaultModel = options.defaultModel ?? "gpt-5.6-terra";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await providerFetch(this.id, `${this.baseUrl}/models`, { method: "GET", headers: { authorization: `Bearer ${this.options.apiKey}`, ...(this.options.organization ? { "openai-organization": this.options.organization } : {}), ...(this.options.project ? { "openai-project": this.options.project } : {}) }, ...(signal ? { signal } : {}) });
    await response.body?.cancel();
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResult> {
    const instructions = request.messages.filter((message) => message.role === "system")
      .map((message) => contentText(message.content)).filter(Boolean).join("\n\n");
    const body = {
      model: request.model,
      ...(request.reasoningEffort && request.reasoningEffort !== "none" ? { reasoning: { effort: request.reasoningEffort } } : {}),
      ...(request.serviceTier === "priority" ? { service_tier: "priority" } : {}),
      input: inputItems(request.messages),
      stream: true,
      store: false,
      ...(instructions ? { instructions } : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined
        && (!request.reasoningEffort || request.reasoningEffort === "none")
        ? { temperature: request.temperature }
        : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      ...(request.tools?.length ? {
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true
        })),
        tool_choice: "auto"
      } : {})
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json"
    };
    if (this.options.organization) headers["openai-organization"] = this.options.organization;
    if (this.options.project) headers["openai-project"] = this.options.project;
    const response = await providerFetch(this.id, `${this.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {})
    });

    let text = "";
    let completed: Record<string, unknown> = {};
    const toolCalls = new Map<string, ModelToolCall>();
    await readServerSentEvents(response, this.id, ({ data }) => {
      if (data === "[DONE]") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new ModelProviderError("OpenAI returned malformed streaming JSON.", this.id, false);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new ModelProviderError("OpenAI returned invalid streaming JSON.", this.id, false);
      const event = parsed as Record<string, unknown>;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
        options.onEvent?.({ type: "text_delta", delta: event.delta });
      }
      if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const callId = typeof event.call_id === "string" ? event.call_id : typeof event.item_id === "string" ? event.item_id : "pending";
        options.onEvent?.({ type: "tool_call_delta", callId, argumentsDelta: event.delta });
      }
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
          toolCalls.set(item.call_id, { id: item.call_id, name: item.name, arguments: safeJsonObject(String(item.arguments ?? "{}")) });
        }
      }
      if (event.type === "response.completed") completed = (event.response as Record<string, unknown> | undefined) ?? {};
      if (event.type === "error") {
        const error = event.error as Record<string, unknown> | undefined;
        throw new ModelProviderError(`OpenAI stream error: ${String(error?.message ?? "unknown error")}`, this.id, true);
      }
    });
    const usage = (completed.usage as Record<string, unknown> | undefined) ?? {};
    const inputDetails = (usage.input_tokens_details as Record<string, unknown> | undefined) ?? {};
    const outputDetails = (usage.output_tokens_details as Record<string, unknown> | undefined) ?? {};
    const calls = [...toolCalls.values()];
    const result: ModelResult = {
      providerId: this.id,
      model: typeof completed.model === "string" ? completed.model : request.model,
      ...(typeof completed.id === "string" ? { responseId: completed.id } : {}),
      text,
      toolCalls: calls,
      usage: {
        inputTokens: usageCount(usage.input_tokens),
        outputTokens: usageCount(usage.output_tokens),
        cachedInputTokens: usageCount(inputDetails.cached_tokens),
        reasoningTokens: usageCount(outputDetails.reasoning_tokens)
      },
      finishReason: finishReason(completed, calls)
    };
    options.onEvent?.({ type: "completed", result });
    return result;
  }
}
