export type JsonSchema = Record<string, unknown>;

export type ModelContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mediaType: string; source: "base64" | "url" }
	| { type: "audio"; data: string; mediaType: string; source: "base64" | "url" }
	| {
			type: "video";
			data: string;
			mediaType: string;
			source: "base64" | "url";
			name?: string;
	  }
	| {
			type: "document";
			data: string;
			mediaType: string;
			source: "base64" | "url";
			name?: string;
	  };

export interface ModelToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
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

export type ModelFinishReason =
	| "stop"
	| "tool_calls"
	| "length"
	| "refusal"
	| "cancelled"
	| "unknown";

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
	| {
			type: "tool_call_delta";
			callId: string;
			name?: string;
			argumentsDelta: string;
	  }
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

export interface ModelProfileHints {
	displayName?: string;
	capabilities?: Record<string, number>;
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
	complete(
		request: ModelRequest,
		options?: ModelCallOptions,
	): Promise<ModelResult>;
	close?(): Promise<void>;
}

export class ModelProviderError extends Error {
	constructor(
		message: string,
		readonly providerId: string,
		readonly retryable: boolean,
		readonly status?: number,
	) {
		super(message);
		this.name = "ModelProviderError";
	}
}

export function textContent(value: string): ModelContentPart[] {
	return [{ type: "text", text: value }];
}

export function contentText(parts: ModelContentPart[]): string {
	return parts
		.filter(
			(part): part is Extract<ModelContentPart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("\n");
}

export function safeJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: { value: parsed };
	} catch {
		return { _malformed: value };
	}
}
