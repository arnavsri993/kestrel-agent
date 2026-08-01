import { randomUUID } from "node:crypto";
import { readBoundedResponseBytes } from "../bounded-http";
import { providerFetch } from "./http";
import { ModelProviderError, contentText, type ModelCallOptions, type ModelContentPart, type ModelFinishReason, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResult, type ModelToolCall } from "./types";

const MAX_GEMINI_RESPONSE_BYTES = 16_000_000;

export interface GeminiGenerateContentProviderOptions {
  apiKey: string;
  id?: string;
  defaultModel?: string;
  baseUrl?: string;
}

function part(input: ModelContentPart): Record<string, unknown> {
  if (input.type === "text") return { text: input.text };
  if (input.source === "url") return { fileData: { fileUri: input.data, mimeType: input.mediaType } };
  return { inlineData: { mimeType: input.mediaType, data: input.data } };
}

function content(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolName) throw new Error("Gemini tool results require toolName.");
    return { role: "user", parts: [{ functionResponse: { name: message.toolName, response: { output: contentText(message.content) } } }] };
  }
  const parts = message.content.map(part);
  for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.arguments } });
  return { role: message.role === "assistant" ? "model" : "user", parts };
}

function finishReason(value: unknown, calls: ModelToolCall[]): ModelFinishReason {
  if (calls.length) return "tool_calls";
  if (value === "STOP") return "stop";
  if (value === "MAX_TOKENS") return "length";
  if (value === "SAFETY" || value === "RECITATION" || value === "BLOCKLIST") return "refusal";
  return "unknown";
}

export class GeminiGenerateContentProvider implements ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly capabilities = { streaming: false, tools: true, images: true, audio: true, documents: true, video: true, local: false } as const;
  private readonly baseUrl: string;

  constructor(private readonly options: GeminiGenerateContentProviderOptions) {
    if (!options.apiKey) throw new Error("Gemini API key is required.");
    this.id = options.id ?? "gemini";
    this.defaultModel = options.defaultModel ?? "gemini-3.6-flash";
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await providerFetch(this.id, `${this.baseUrl}/models?pageSize=1`, { method: "GET", headers: { "x-goog-api-key": this.options.apiKey }, ...(signal ? { signal } : {}) });
    await response.body?.cancel();
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResult> {
    const system = request.messages.filter((message) => message.role === "system").map((message) => contentText(message.content)).filter(Boolean).join("\n\n");
    const body = {
      contents: request.messages.filter((message) => message.role !== "system").map(content),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] } : {}),
      ...((request.maxOutputTokens || request.temperature !== undefined) ? { generationConfig: { ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) } } : {})
    };
    const model = encodeURIComponent(request.model || this.defaultModel);
    const response = await providerFetch(this.id, `${this.baseUrl}/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": this.options.apiKey, "content-type": "application/json" }, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) });
    let payload: Record<string, unknown>;
    try {
      const bytes = await readBoundedResponseBytes(response, MAX_GEMINI_RESPONSE_BYTES, "Gemini response exceeds 16 MB.");
      payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === "Gemini response exceeds 16 MB.")
        throw new ModelProviderError(error.message, this.id, false, response.status);
      throw new ModelProviderError("Gemini returned malformed JSON.", this.id, false);
    }
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] as Record<string, unknown> | undefined : undefined;
    const candidateContent = candidate?.content as Record<string, unknown> | undefined;
    const responseParts = Array.isArray(candidateContent?.parts) ? candidateContent.parts as Array<Record<string, unknown>> : [];
    const text = responseParts.filter((item) => typeof item.text === "string").map((item) => String(item.text)).join("");
    const toolCalls = responseParts.flatMap((item) => {
      const call = item.functionCall as Record<string, unknown> | undefined;
      if (!call || typeof call.name !== "string") return [];
      return [{ id: `gemini-${randomUUID()}`, name: call.name, arguments: call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {} }];
    });
    const usage = (payload.usageMetadata as Record<string, unknown> | undefined) ?? {};
    const result: ModelResult = {
      providerId: this.id,
      model: request.model || this.defaultModel,
      ...(typeof payload.responseId === "string" ? { responseId: payload.responseId } : {}),
      text,
      toolCalls,
      usage: { inputTokens: Number(usage.promptTokenCount ?? 0), outputTokens: Number(usage.candidatesTokenCount ?? 0), cachedInputTokens: Number(usage.cachedContentTokenCount ?? 0), reasoningTokens: Number(usage.thoughtsTokenCount ?? 0) },
      finishReason: finishReason(candidate?.finishReason, toolCalls)
    };
    if (text) options.onEvent?.({ type: "text_delta", delta: text });
    options.onEvent?.({ type: "completed", result });
    return result;
  }
}
