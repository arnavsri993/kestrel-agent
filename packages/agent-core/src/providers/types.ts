export type JsonSchema = Record<string, unknown>;

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string; source: "base64" | "url" }
  | { type: "audio"; data: string; mediaType: string; source: "base64" | "url" }
  | { type: "video"; data: string; mediaType: string; source: "base64" | "url"; name?: string }
  | { type: "document"; data: string; mediaType: string; source: "base64" | "url"; name?: string };

export interface ModelToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Provider-specific continuation data, currently used by Gemini 3. */
	thoughtSignature?: string | undefined;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelContentPart[];
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier?: "standard" | "priority";
  messages: ModelMessage[];
  tools?: ModelTool[];
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Record<string, string>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "refusal" | "cancelled" | "unknown";

export interface ModelResult {
  providerId: string;
  model: string;
  responseId?: string;
  text: string;
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
  finishReason: ModelFinishReason;
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; callId: string; name?: string; argumentsDelta: string }
  | { type: "provider_progress"; detail: string }
  | { type: "completed"; result: ModelResult };

export interface ModelCallOptions {
  signal?: AbortSignal;
  onEvent?: (event: ModelStreamEvent) => void;
}

export interface ModelProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  images: boolean;
  audio: boolean;
  documents: boolean;
  video?: boolean;
  local: boolean;
}

import type { ModelTier } from "@kestrel/shared-types";

export interface ModelProfileHints {
  displayName?: string;
  tier?: ModelTier;
  capabilities?: Record<string, number>;
  refusalResilience?: number;
  cost?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    fixedRequestCost?: number;
    priorityMultiplier?: number;
  };
  latency?: {
    averageMs?: number;
    p95Ms?: number;
  };
  limits?: {
    contextWindow?: number;
    maxOutputTokens?: number;
    concurrency?: number;
  };
  features?: {
    structuredOutput?: boolean;
    reasoningLevels?: boolean;
    fastMode?: boolean;
  };
}

export interface ModelProvider {
  readonly id: string;
  readonly poolId?: string;
  readonly defaultModel?: string;
  readonly capabilities: ModelProviderCapabilities;
  readonly profileHints?: ModelProfileHints;
  probe?(signal?: AbortSignal): Promise<void>;
  complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResult>;
  close?(): Promise<void>;
}

export type ProviderAvailabilityReason =
  | "capacity"
  | "rate_limit"
  | "transient"
  | "unknown";

import { KestrelError } from "@kestrel/error-handling";

export class ModelProviderError extends KestrelError {
  readonly isRefusal: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    readonly providerId: string,
    retryable: boolean,
    readonly status?: number,
    isRefusal = false,
    retryAfterMs?: number,
  ) {
    super({
      code: isRefusal ? "model_refusal_error" : "model_provider_error",
      message,
      retryable,
      metadata: { providerId, status, isRefusal },
    });
    this.name = "ModelProviderError";
    this.isRefusal = isRefusal || isRefusalErrorMessage(message);
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
      this.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs));
    }
  }
}

export function isRefusalErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("safety") ||
    normalized.includes("content filter") ||
    normalized.includes("content_filter") ||
    normalized.includes("moderation") ||
    normalized.includes("policy violation") ||
    normalized.includes("blocked by") ||
    normalized.includes("refusal") ||
    normalized.includes("safety policy") ||
    normalized.includes("terms of service violation") ||
    normalized.includes("restricted content")
  );
}

export function textContent(value: string): ModelContentPart[] {
  return [{ type: "text", text: value }];
}

export function contentText(parts: ModelContentPart[]): string {
  return parts.filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { _malformed: value };
  }
}
