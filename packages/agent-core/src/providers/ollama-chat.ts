import { providerFetch, readNdjson } from "./http";
import {
  contentText,
  type ModelCallOptions,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall
} from "./types";

export interface OllamaChatProviderOptions {
  id?: string;
  poolId?: string;
  defaultModel?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

function ollamaMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const images = message.content
      .filter((part): part is Extract<typeof part, { type: "image" }> => part.type === "image" && part.source === "base64")
      .map((part) => part.data);
    return {
      role: message.role,
      content: contentText(message.content),
      ...(images.length ? { images } : {}),
      ...(message.toolName ? { tool_name: message.toolName } : {}),
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
      } : {})
    };
  });
}

export class OllamaChatProvider implements ModelProvider {
  readonly id: string;
  readonly poolId?: string;
  readonly defaultModel?: string;
  readonly capabilities = { streaming: true, tools: true, images: true, audio: false, documents: false, local: true } as const;
  private readonly baseUrl: string;

  constructor(private readonly options: OllamaChatProviderOptions = {}) {
    this.id = options.id ?? "ollama";
    if (options.poolId) this.poolId = options.poolId;
    if (options.defaultModel) this.defaultModel = options.defaultModel;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await providerFetch(this.id, `${this.baseUrl}/api/tags`, { method: "GET", headers: this.options.headers ?? {}, ...(signal ? { signal } : {}) });
    await response.body?.cancel();
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResult> {
    const response = await providerFetch(this.id, `${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.options.headers },
      body: JSON.stringify({
        model: request.model,
        messages: ollamaMessages(request.messages),
        stream: true,
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
          }))
        } : {}),
        ...((request.temperature !== undefined || request.maxOutputTokens) ? {
          options: {
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {})
          }
        } : {})
      }),
      ...(options.signal ? { signal: options.signal } : {})
    });
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let doneReason = "";
    const toolCalls: ModelToolCall[] = [];
    await readNdjson(response, this.id, (raw) => {
      const chunk = raw as Record<string, unknown>;
      const message = (chunk.message as Record<string, unknown> | undefined) ?? {};
      if (typeof message.content === "string" && message.content) {
        text += message.content;
        options.onEvent?.({ type: "text_delta", delta: message.content });
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const [index, rawCall] of calls.entries()) {
        const fn = ((rawCall as Record<string, unknown>).function as Record<string, unknown> | undefined) ?? {};
        const call: ModelToolCall = {
          id: `ollama-call-${toolCalls.length + index + 1}`,
          name: String(fn.name ?? "unknown_tool"),
          arguments: fn.arguments !== null && typeof fn.arguments === "object" ? fn.arguments as Record<string, unknown> : {}
        };
        toolCalls.push(call);
        options.onEvent?.({ type: "tool_call_delta", callId: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) });
      }
      if (chunk.done === true) {
        inputTokens = Number(chunk.prompt_eval_count ?? 0);
        outputTokens = Number(chunk.eval_count ?? 0);
        doneReason = String(chunk.done_reason ?? "stop");
      }
    });
    const result: ModelResult = {
      providerId: this.id,
      model: request.model,
      text,
      toolCalls,
      usage: { inputTokens, outputTokens },
      finishReason: toolCalls.length ? "tool_calls" : doneReason === "length" ? "length" : "stop"
    };
    options.onEvent?.({ type: "completed", result });
    return result;
  }
}
