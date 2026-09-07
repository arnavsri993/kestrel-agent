import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contentText,
	type DiscoveredModel,
	type ModelCallOptions,
	type ModelMessage,
	type ModelProvider,
	ModelProviderError,
	type ModelRequest,
	type ModelResult,
	type ModelUsage,
} from "./types";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;

interface CliRunResult {
	stdout: string;
	stderr: string;
}

export interface SubscriptionCliOptions {
	id?: string;
	poolId?: string;
	executable?: string;
	defaultModel?: string;
	environment?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

function killChildProcess(child: ChildProcess): void {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	}, 1_000).unref();
}

function safeEnvironment(
	source: NodeJS.ProcessEnv,
	additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const allowed = [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"LANG",
		"LC_ALL",
		"TERM",
		"TMPDIR",
		"CODEX_HOME",
		"CLAUDE_CONFIG_DIR",
		"OPENCODE_CONFIG",
		"OPENCODE_HOME",
	] as const;
	const environment: NodeJS.ProcessEnv = {};
	for (const key of allowed) if (source[key]) environment[key] = source[key];
	return { ...environment, ...additions };
}

function runCli(
	executable: string,
	args: string[],
	input: string,
	options: {
		cwd: string;
		environment: NodeJS.ProcessEnv;
		signal: AbortSignal | undefined;
		timeoutMs: number;
		onLine?: (line: string) => void;
	},
): Promise<CliRunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(
				options.signal.reason instanceof Error
					? options.signal.reason
					: new Error("Provider request was cancelled."),
			);
			return;
		}
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.environment,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let settled = false;
		const finish = (error?: Error, result?: CliRunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(result!);
		};
		const stop = (reason: Error) => {
			killChildProcess(child);
			finish(reason);
		};
		const abort = () =>
			stop(
				options.signal?.reason instanceof Error
					? options.signal.reason
					: new Error("Provider request was cancelled."),
			);
		const timer = setTimeout(
			() => stop(new Error("Provider CLI timed out.")),
			options.timeoutMs,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) return abort();
		child.once("error", (error) => finish(error));
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES)
				return stop(
					new Error("Provider CLI output exceeded the safety limit."),
				);
			lineBuffer += chunk.toString("utf8");
			while (lineBuffer.includes("\n")) {
				const index = lineBuffer.indexOf("\n");
				const line = lineBuffer.slice(0, index).trim();
				lineBuffer = lineBuffer.slice(index + 1);
				if (line) options.onLine?.(line);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES)
				return stop(
					new Error("Provider CLI error output exceeded the safety limit."),
				);
		});
		child.once("close", (code, signal) => {
			const trailing = lineBuffer.trim();
			if (trailing) options.onLine?.(trailing);
			if (code === 0) finish(undefined, { stdout, stderr });
			else
				finish(
					new Error(
						`Provider CLI exited ${signal ? `on ${signal}` : `with code ${code ?? "unknown"}`}: ${stderr.trim().slice(0, 1_000) || "no diagnostic output"}`,
					),
				);
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(input);
	});
}

function messageLabel(message: ModelMessage): string {
	if (message.role === "tool")
		return `Tool result${message.toolName ? ` (${message.toolName})` : ""}`;
	return message.role[0]!.toUpperCase() + message.role.slice(1);
}

function promptFor(request: ModelRequest): string {
	const transcript = request.messages
		.map((message) => {
			const text = contentText(message.content);
			const unsupported = message.content
				.filter((part) => part.type !== "text")
				.map((part) => `[${part.type} content omitted]`)
				.join("\n");
			return `${messageLabel(message)}:\n${[text, unsupported].filter(Boolean).join("\n")}`;
		})
		.join("\n\n");
	return `${transcript}\n\nRespond to the final user message as plain text. Do not inspect files, run commands, browse, or call tools.`;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0;
}

function boundedTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.max(1, Math.min(MAX_TIMER_MS, Math.trunc(value)));
}

function usageFrom(value: unknown): ModelUsage {
	const usage =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	return {
		inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
		outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
		...(numberValue(usage.cache_read_input_tokens ?? usage.cached_input_tokens)
			? {
					cachedInputTokens: numberValue(
						usage.cache_read_input_tokens ?? usage.cached_input_tokens,
					),
				}
			: {}),
	};
}

function parseObject(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function withoutAnsi(value: string): string {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * `opencode models --verbose` prints one pretty JSON record after optional
 * progress lines. Parse balanced objects rather than assuming line-delimited
 * JSON so the supported CLI output remains usable across formatting changes.
 */
function jsonObjectsFromOutput(value: string): Record<string, unknown>[] {
	const output = withoutAnsi(value);
	const records: Record<string, unknown>[] = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < output.length; index += 1) {
		const character = output[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (character !== "}" || depth === 0) continue;
		depth -= 1;
		if (depth !== 0 || start < 0) continue;
		try {
			const parsed: unknown = JSON.parse(output.slice(start, index + 1));
			const record = asObject(parsed);
			if (record) records.push(record);
		} catch {
			// Ignore a progress record that happens to resemble JSON; discovery
			// still returns every fully parseable model record.
		}
		start = -1;
	}
	return records;
}

function openCodeModelsFromOutput(value: string): DiscoveredModel[] {
	const knownLevels = new Set([
		"none",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	const models = new Map<string, DiscoveredModel>();
	for (const record of jsonObjectsFromOutput(value)) {
		const rawId = typeof record.id === "string" ? record.id.trim() : "";
		const providerId =
			typeof record.providerID === "string" ? record.providerID.trim() : "";
		if (!rawId) continue;
		const id =
			providerId && !rawId.startsWith(`${providerId}/`)
				? `${providerId}/${rawId}`
				: rawId;
		const capabilities = asObject(record.capabilities) ?? {};
		const inputs = asObject(capabilities.input) ?? {};
		const limits = asObject(record.limit) ?? {};
		const variants = asObject(record.variants) ?? {};
		const reasoningEfforts = Object.keys(variants).filter((level) =>
			knownLevels.has(level),
		) as Array<"none" | "low" | "medium" | "high" | "xhigh" | "max">;
		const contextWindow = Number(limits.context);
		const maxOutputTokens = Number(limits.output);
		models.set(id, {
			id,
			displayName:
				typeof record.name === "string" && record.name.trim()
					? record.name
					: id,
			// The CLI advertises models, but does not expose an entitlement API.
			// Keep this truthful: an explicit selection is allowed, while the
			// automatic router prefers models with a confirmed API result.
			availability: "unknown",
			source: "cli",
			capabilities: {
				capabilityProvenance: "confirmed",
				streaming: true,
				tools: capabilities.toolcall === true,
				images: inputs.image === true,
				audio: inputs.audio === true,
				documents: inputs.pdf === true,
				video: inputs.video === true,
				structuredOutput: capabilities.toolcall === true,
				...(reasoningEfforts.length ? { reasoningEfforts } : {}),
				...(Number.isFinite(contextWindow) && contextWindow > 0
					? { contextWindow: Math.floor(contextWindow) }
					: {}),
				...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
					? { maxOutputTokens: Math.floor(maxOutputTokens) }
					: {}),
			},
		});
	}
	return [...models.values()];
}

export class ClaudeSubscriptionProvider implements ModelProvider {
	readonly id: string;
	readonly poolId: string;
	readonly defaultModel: string;
	readonly capabilities = {
		streaming: true,
		tools: false,
		images: false,
		audio: false,
		documents: false,
		video: false,
		local: false,
	} as const;
	private readonly executable: string;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly timeoutMs: number;

	constructor(options: SubscriptionCliOptions = {}) {
		this.id = options.id ?? "claude-subscription";
		this.poolId = options.poolId ?? "claude-subscription";
		this.executable = options.executable ?? "claude";
		this.defaultModel = options.defaultModel ?? "sonnet";
		this.environment = safeEnvironment(options.environment ?? process.env, {
			CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
		});
		this.timeoutMs = boundedTimeout(options.timeoutMs);
	}

	async probe(signal?: AbortSignal): Promise<void> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-claude-probe-"));
		try {
			await runCli(this.executable, ["auth", "status"], "", {
				cwd: root,
				environment: this.environment,
				signal,
				timeoutMs: 15_000,
			});
		} catch (error) {
			throw new ModelProviderError(
				error instanceof Error
					? error.message
					: "Claude subscription authentication failed.",
				this.id,
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	async complete(
		request: ModelRequest,
		options: ModelCallOptions = {},
	): Promise<ModelResult> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-claude-subscription-"));
		let text = "";
		let streamedText = "";
		let responseId: string | undefined;
		let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
		try {
			await runCli(
				this.executable,
				[
					"-p",
					"--output-format",
					"stream-json",
					"--verbose",
					"--include-partial-messages",
					"--no-session-persistence",
					"--permission-mode",
					"plan",
					"--max-turns",
					"1",
					"--model",
					request.model,
					"--no-chrome",
					"--safe-mode",
					"--tools",
					"",
					"--strict-mcp-config",
					"--disable-slash-commands",
				],
				promptFor(request),
				{
					cwd: root,
					environment: this.environment,
					signal: options.signal,
					timeoutMs: this.timeoutMs,
					onLine: (line) => {
						const event = parseObject(line);
						if (!event) return;
						if (typeof event.session_id === "string")
							responseId = event.session_id;
						if (event.type === "stream_event") {
							const inner =
								event.event && typeof event.event === "object"
									? (event.event as Record<string, unknown>)
									: {};
							const delta =
								inner.delta && typeof inner.delta === "object"
									? (inner.delta as Record<string, unknown>)
									: {};
							if (
								delta.type === "text_delta" &&
								typeof delta.text === "string"
							) {
								streamedText += delta.text;
								options.onEvent?.({ type: "text_delta", delta: delta.text });
							}
						}
						if (event.type === "result") {
							if (typeof event.result === "string") text = event.result;
							usage = usageFrom(event.usage);
						}
					},
				},
			);
			text ||= streamedText;
			if (!streamedText && text)
				options.onEvent?.({ type: "text_delta", delta: text });
			return {
				providerId: this.id,
				model: request.model,
				...(responseId ? { responseId } : {}),
				text,
				toolCalls: [],
				usage,
				finishReason: "stop",
			};
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new ModelProviderError(
				error instanceof Error
					? error.message
					: "Claude subscription request failed.",
				this.id,
				true,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}

export class OpenCodeSubscriptionProvider implements ModelProvider {
	readonly id: string;
	readonly poolId: string;
	readonly defaultModel: string;
	readonly capabilities = {
		streaming: true,
		tools: false,
		images: false,
		audio: false,
		documents: false,
		video: false,
		// OpenCode can front local or hosted providers; its catalog does not
		// declare that distinction per model, so it must never imply privacy.
		local: false,
	} as const;
	private readonly executable: string;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly timeoutMs: number;

	constructor(options: SubscriptionCliOptions = {}) {
		this.id = options.id ?? "opencode-subscription";
		this.poolId = options.poolId ?? "opencode-subscription";
		this.executable = options.executable ?? "opencode";
		this.defaultModel = options.defaultModel ?? "opencode";
		this.environment = safeEnvironment(options.environment ?? process.env);
		this.timeoutMs = boundedTimeout(options.timeoutMs);
	}

	async probe(signal?: AbortSignal): Promise<void> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-opencode-probe-"));
		try {
			await runCli(this.executable, ["auth", "list"], "", {
				cwd: root,
				environment: this.environment,
				signal,
				timeoutMs: 15_000,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			// A runnable binary only proves CLI availability. It is not evidence
			// that its existing provider-owned account is authenticated.
			throw new ModelProviderError(
				"OpenCode CLI authentication could not be verified.",
				this.id,
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-opencode-models-"));
		try {
			const result = await runCli(
				this.executable,
				["models", "--pure", "--verbose", "--refresh"],
				"",
				{
					cwd: root,
					environment: this.environment,
					signal,
					timeoutMs: Math.min(this.timeoutMs, 60_000),
				},
			);
			return openCodeModelsFromOutput(result.stdout);
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ModelProviderError(
				error instanceof Error
					? error.message
					: "OpenCode model discovery failed.",
				this.id,
				true,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	async complete(
		request: ModelRequest,
		options: ModelCallOptions = {},
	): Promise<ModelResult> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-opencode-subscription-"));
		let text = "";
		let streamedText = "";
		let responseId: string | undefined;
		let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
		const prompt = promptFor(request);
		const args = ["run", "--format", "json"];
		if (
			request.model &&
			request.model !== "opencode" &&
			request.model !== "default"
		) {
			args.push("-m", request.model);
		}
		args.push(prompt);

		try {
			await runCli(this.executable, args, "", {
				cwd: root,
				environment: this.environment,
				signal: options.signal,
				timeoutMs: this.timeoutMs,
				onLine: (line) => {
					const event = parseObject(line);
					if (!event) return;
					if (
						typeof event.sessionID === "string" ||
						typeof event.session_id === "string"
					) {
						responseId = (event.sessionID ?? event.session_id) as string;
					}
					const part =
						event.part && typeof event.part === "object"
							? (event.part as Record<string, unknown>)
							: {};
					if (event.type === "text" || typeof event.text === "string") {
						const deltaText =
							typeof event.text === "string"
								? event.text
								: typeof part.text === "string"
									? part.text
									: "";
						if (deltaText) {
							streamedText += deltaText;
							options.onEvent?.({ type: "text_delta", delta: deltaText });
						}
					} else if (
						event.type === "step_start" ||
						event.type === "step_finish" ||
						event.type === "result"
					) {
						if (typeof event.result === "string") {
							text = event.result;
						}
						if (typeof part.result === "string") {
							text = part.result;
						}
						if (event.usage) {
							usage = usageFrom(event.usage);
						}
					}
				},
			});
			text ||= streamedText;
			if (!streamedText && text)
				options.onEvent?.({ type: "text_delta", delta: text });
			return {
				providerId: this.id,
				model: request.model,
				...(responseId ? { responseId } : {}),
				text,
				toolCalls: [],
				usage,
				finishReason: "stop",
			};
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new ModelProviderError(
				error instanceof Error
					? error.message
					: "OpenCode subscription request failed.",
				this.id,
				true,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}
