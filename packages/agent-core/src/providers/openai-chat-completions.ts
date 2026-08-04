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

export interface OpenAIChatCompletionsProviderOptions {
  apiKey: string;
  id: string;
  defaultModel: string;
  baseUrl: string;
  headers?: Record<string, string>;
  images?: boolean;
}

function content(part: ModelContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") return {
    type: "image_url",
    image_url: { url: part.source === "url" ? part.data : `data:${part.mediaType};base64,${part.data}` }
  };
  throw new Error(`OpenAI-compatible chat provider does not support ${part.type} input.`);
}

function messages(input: ModelMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of input) {
    if (message.role === "tool") {
      output.push({ role: "tool", tool_call_id: message.toolCallId, content: contentText(message.content) });
      continue;
    }
    output.push({
      role: message.role,
      content: message.content.length === 1 && message.content[0]?.type === "text"
        ? message.content[0].text
        : message.content.map(content),
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      } : {})
    });
  }
  return output;
}

function finishReason(value: unknown, calls: ModelToolCall[]): ModelFinishReason {
  if (calls.length || value === "tool_calls") return "tool_calls";
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "content_filter") return "refusal";
  return "unknown";
}

function usageCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export class OpenAIChatCompletionsProvider implements ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly capabilities;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIChatCompletionsProviderOptions) {
    if (!options.apiKey) throw new Error(`${options.id} API key is required.`);
    this.id = options.id;
    this.defaultModel = options.defaultModel;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.capabilities = { streaming: true, tools: true, images: options.images ?? false, audio: false, documents: false, local: false } as const;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", ...this.options.headers };
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await providerFetch(this.id, `${this.baseUrl}/models`, {
      method: "GET",
      headers: this.headers(),
      ...(signal ? { signal } : {})
    });
    await response.body?.cancel();
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResult> {
    const response = await providerFetch(this.id, `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        messages: messages(request.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
          tool_choice: "auto"
        } : {})
      }),
      ...(options.signal ? { signal: options.signal } : {})
    });

    let text = "";
    let responseId: string | undefined;
    let model = request.model;
    let stopped: unknown;
    let usage: Record<string, unknown> = {};
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    await readServerSentEvents(response, this.id, ({ data }) => {
      if (data === "[DONE]") return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); }
      catch { throw new ModelProviderError(`${this.id} returned malformed streaming JSON.`, this.id, false); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new ModelProviderError(`${this.id} returned invalid streaming JSON.`, this.id, false);
      const event = parsed as Record<string, unknown>;
      if (typeof event.id === "string") responseId = event.id;
      if (typeof event.model === "string") model = event.model;
      if (event.usage && typeof event.usage === "object") usage = event.usage as Record<string, unknown>;
      const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> | undefined : undefined;
      if (!choice) return;
      stopped = choice.finish_reason ?? stopped;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string") {
        text += delta.content;
        options.onEvent?.({ type: "text_delta", delta: delta.content });
      }
      for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : []) {
        const index = Number(raw.index ?? 0);
        const fn = raw.function as Record<string, unknown> | undefined;
        const existing = calls.get(index) ?? { id: String(raw.id ?? `call-${index}`), name: "", arguments: "" };
        if (typeof raw.id === "string") existing.id = raw.id;
        if (typeof fn?.name === "string") existing.name += fn.name;
        if (typeof fn?.arguments === "string") {
          existing.arguments += fn.arguments;
          options.onEvent?.({ type: "tool_call_delta", callId: existing.id, ...(existing.name ? { name: existing.name } : {}), argumentsDelta: fn.arguments });
        }
        calls.set(index, existing);
      }
    });
    const toolCalls = [...calls.values()].map((call) => ({ id: call.id, name: call.name, arguments: safeJsonObject(call.arguments || "{}") }));
    return {
      providerId: this.id,
      model,
      ...(responseId ? { responseId } : {}),
      text,
      toolCalls,
      usage: { inputTokens: usageCount(usage.prompt_tokens), outputTokens: usageCount(usage.completion_tokens) },
      finishReason: finishReason(stopped, toolCalls)
    };
  }
}
