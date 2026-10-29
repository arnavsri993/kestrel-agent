import { providerFetch, readNdjson } from "./http";
import { readBoundedResponseBytes } from "../bounded-http";
import {
	contentText,
	type DiscoveredModel,
	type ModelCallOptions,
	type ModelMessage,
	type ModelProvider,
	type ModelRequest,
	type ModelResult,
	type ModelToolCall,
} from "./types";

const MAX_OLLAMA_TAGS_BYTES = 1024 * 1024;
const MAX_OLLAMA_SHOW_BYTES = 256 * 1024;
const MAX_OLLAMA_MODELS = 64;
const OLLAMA_SHOW_CONCURRENCY = 4;
const OLLAMA_SHOW_TIMEOUT_MS = 1_000;
const OLLAMA_MODEL_CAPABILITIES = new Set([
	"completion",
	"tools",
	"insert",
	"vision",
	"embedding",
	"thinking",
]);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function modelContextWindow(
	modelInfo: Record<string, unknown> | undefined,
	fallback: number,
): number {
	const architecture = modelInfo?.["general.architecture"];
	if (
		!modelInfo ||
		typeof architecture !== "string" ||
		!/^[a-zA-Z0-9_-]{1,64}$/.test(architecture)
	)
		return fallback;
	const contextLength = modelInfo[`${architecture}.context_length`];
	return typeof contextLength === "number" &&
		Number.isSafeInteger(contextLength) &&
		contextLength > 0
		? Math.min(contextLength, 131_072)
		: fallback;
}

function parsedOllamaCapabilities(value: unknown): Set<string> | undefined {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > OLLAMA_MODEL_CAPABILITIES.size ||
		value.some(
			(item) =>
				typeof item !== "string" ||
				!OLLAMA_MODEL_CAPABILITIES.has(item),
		)
	)
		return undefined;
	const capabilities = new Set(value as string[]);
	return capabilities.size === value.length ? capabilities : undefined;
}

function unknownModel(
	name: string,
	contextWindow: number,
	availability: "available" | "unsupported" = "available",
): DiscoveredModel {
	return {
		id: name,
		displayName: name,
		availability,
		source: "provider_api",
		capabilities: {
			capabilityProvenance: "unknown",
			contextWindow,
		},
	};
}

function modelFromShow(
	name: string,
	show: Record<string, unknown> | undefined,
	fallbackContextWindow: number,
): DiscoveredModel {
	const modelInfo = objectRecord(show?.model_info);
	const contextWindow = modelContextWindow(modelInfo, fallbackContextWindow);
	const capabilities = parsedOllamaCapabilities(show?.capabilities);
	if (!capabilities) return unknownModel(name, contextWindow);
	if (!capabilities.has("completion"))
		return unknownModel(name, contextWindow, "unsupported");
	return {
		id: name,
		displayName: name,
		availability: "available",
		source: "provider_api",
		capabilities: {
			capabilityProvenance: "confirmed",
			streaming: true,
			tools: capabilities.has("tools"),
			images: capabilities.has("vision"),
			reasoningEfforts: capabilities.has("thinking")
				? ["none", "medium"]
				: [],
			contextWindow,
		},
	};
}

async function discoverOllamaModel(
	providerId: string,
	baseUrl: string,
	headers: Record<string, string>,
	name: string,
	signal: AbortSignal | undefined,
	fallbackContextWindow: number,
): Promise<DiscoveredModel> {
	let show: Record<string, unknown> | undefined;
	const timeout = AbortSignal.timeout(OLLAMA_SHOW_TIMEOUT_MS);
	const showSignal = signal
		? AbortSignal.any([signal, timeout])
		: timeout;
	try {
		const response = await providerFetch(
			providerId,
			`${baseUrl}/api/show`,
			{
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify({ model: name }),
				signal: showSignal,
			},
		);
		const bytes = await readBoundedResponseBytes(
			response,
			MAX_OLLAMA_SHOW_BYTES,
			"Ollama model descriptor exceeded the size limit.",
		);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		show = objectRecord(parsed);
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		// Model details are optional: keep the installed tag visible, but do not
		// infer or persist any capabilities from its name or failed descriptor.
	}
	if (signal?.aborted) throw signal.reason;
	return modelFromShow(name, show, fallbackContextWindow);
}

export interface OllamaChatProviderOptions {
	id?: string;
	poolId?: string;
	defaultModel?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	contextWindow?: number;
	thinking?: boolean;
}

function ollamaMessages(
	messages: ModelMessage[],
): Array<Record<string, unknown>> {
	return messages.map((message) => {
		const images = message.content
			.filter(
				(part): part is Extract<typeof part, { type: "image" }> =>
					part.type === "image" && part.source === "base64",
			)
			.map((part) => part.data);
		return {
			role: message.role,
			content: contentText(message.content),
			...(images.length ? { images } : {}),
			...(message.toolName ? { tool_name: message.toolName } : {}),
			...(message.toolCalls?.length
				? {
						tool_calls: message.toolCalls.map((call) => ({
							function: { name: call.name, arguments: call.arguments },
						})),
					}
				: {}),
		};
	});
}

function usageCount(value: unknown): number {
	const count = Number(value);
	return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export class OllamaChatProvider implements ModelProvider {
	readonly id: string;
	readonly poolId?: string;
	readonly defaultModel?: string;
	readonly capabilities = {
		streaming: true,
		tools: true,
		images: true,
		audio: false,
		documents: false,
		local: true,
	} as const;
	private readonly baseUrl: string;
	private readonly contextWindow: number;

	constructor(private readonly options: OllamaChatProviderOptions = {}) {
		this.id = options.id ?? "ollama";
		if (options.poolId) this.poolId = options.poolId;
		if (options.defaultModel) this.defaultModel = options.defaultModel;
		this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(
			/\/$/,
			"",
		);
		this.contextWindow = Math.max(
			16_384,
			Math.min(131_072, Math.floor(options.contextWindow ?? 32_768)),
		);
	}

	async probe(signal?: AbortSignal): Promise<void> {
		const response = await providerFetch(this.id, `${this.baseUrl}/api/tags`, {
			method: "GET",
			headers: this.options.headers ?? {},
			...(signal ? { signal } : {}),
		});
		await response.body?.cancel();
	}

	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		const response = await providerFetch(this.id, `${this.baseUrl}/api/tags`, {
			method: "GET",
			headers: this.options.headers ?? {},
			...(signal ? { signal } : {}),
		});
		const bytes = await readBoundedResponseBytes(
			response,
			MAX_OLLAMA_TAGS_BYTES,
			"Ollama model list exceeded the size limit.",
		);
		let payload: Record<string, unknown> | undefined;
		try {
			payload = objectRecord(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			throw new Error("Ollama returned malformed model discovery JSON.");
		}
		if (!payload || !Array.isArray(payload.models))
			throw new Error("Ollama returned malformed model discovery JSON.");
		const names = [
			...new Set(
				payload.models.flatMap((raw) => {
					const name = objectRecord(raw)?.name;
					return typeof name === "string" &&
						name.trim() === name &&
						name.length > 0 &&
						name.length <= 200 &&
						!hasControlCharacters(name)
						? [name]
						: [];
				}),
			),
		].slice(0, MAX_OLLAMA_MODELS);
		const discovered = new Array<DiscoveredModel>(names.length);
		let next = 0;
		const workers = Array.from(
			{ length: Math.min(OLLAMA_SHOW_CONCURRENCY, names.length) },
			async () => {
				while (true) {
					signal?.throwIfAborted();
					const index = next++;
					const name = names[index];
					if (name === undefined) return;
					discovered[index] = await discoverOllamaModel(
						this.id,
						this.baseUrl,
						this.options.headers ?? {},
						name,
						signal,
						this.contextWindow,
					);
				}
			},
		);
		await Promise.all(workers);
		return discovered;
	}

	async complete(
		request: ModelRequest,
		options: ModelCallOptions = {},
	): Promise<ModelResult> {
		const response = await providerFetch(this.id, `${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.options.headers },
			body: JSON.stringify({
				model: request.model,
				messages: ollamaMessages(request.messages),
				stream: true,
				think:
					request.reasoningEffort === "medium"
						? true
						: request.reasoningEffort === "none"
							? false
							: this.options.thinking ?? false,
				...(request.tools?.length
					? {
							tools: request.tools.map((tool) => ({
								type: "function",
								function: {
									name: tool.name,
									description: tool.description,
									parameters: tool.inputSchema,
								},
							})),
						}
					: {}),
				...(request.temperature !== undefined || request.maxOutputTokens
					? {
							options: {
								num_ctx: this.contextWindow,
								...(request.temperature !== undefined
									? { temperature: request.temperature }
									: {}),
								...(request.maxOutputTokens
									? { num_predict: request.maxOutputTokens }
									: {}),
							},
						}
					: { options: { num_ctx: this.contextWindow } }),
			}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		let text = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let doneReason = "";
		const toolCalls: ModelToolCall[] = [];
		await readNdjson(response, this.id, (raw) => {
			const chunk = raw as Record<string, unknown>;
			const message =
				(chunk.message as Record<string, unknown> | undefined) ?? {};
			if (typeof message.content === "string" && message.content) {
				text += message.content;
				options.onEvent?.({ type: "text_delta", delta: message.content });
			}
			const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			for (const [index, rawCall] of calls.entries()) {
				const fn =
					((rawCall as Record<string, unknown>).function as
						| Record<string, unknown>
						| undefined) ?? {};
				const call: ModelToolCall = {
					id: `ollama-call-${toolCalls.length + index + 1}`,
					name: String(fn.name ?? "unknown_tool"),
					arguments:
						fn.arguments !== null && typeof fn.arguments === "object"
							? (fn.arguments as Record<string, unknown>)
							: {},
				};
				toolCalls.push(call);
				options.onEvent?.({
					type: "tool_call_delta",
					callId: call.id,
					name: call.name,
					argumentsDelta: JSON.stringify(call.arguments),
				});
			}
			if (chunk.done === true) {
				inputTokens = usageCount(chunk.prompt_eval_count);
				outputTokens = usageCount(chunk.eval_count);
				doneReason = String(chunk.done_reason ?? "stop");
			}
		});
		const result: ModelResult = {
			providerId: this.id,
			model: request.model,
			text,
			toolCalls,
			usage: { inputTokens, outputTokens },
			finishReason: toolCalls.length
				? "tool_calls"
				: doneReason === "length"
					? "length"
					: "stop",
		};
		options.onEvent?.({ type: "completed", result });
		return result;
	}
}
