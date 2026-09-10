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
} from "./types";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;

interface CliRunResult {
	stdout: string;
	stderr: string;
}

export interface CursorCliStatus {
	connected: boolean;
}

export interface CursorCliManagerOptions {
	executable: string;
	environment?: NodeJS.ProcessEnv;
	statusTimeoutMs?: number;
	loginTimeoutMs?: number;
}

export interface CursorSubscriptionOptions {
	id?: string;
	poolId?: string;
	executable?: string;
	defaultModel?: string;
	environment?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(MAX_TIMER_MS, Math.trunc(value)));
}

/**
 * Cursor keeps its own login material in its provider-owned profile. Keep the
 * process environment narrow so an unrelated API key cannot silently change
 * authentication or leak into a child process.
 */
function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"LANG",
		"LC_ALL",
		"TERM",
		"TMPDIR",
	] as const;
	const environment: NodeJS.ProcessEnv = {};
	for (const key of allowed) if (source[key]) environment[key] = source[key];
	return environment;
}

function killChildProcess(child: ChildProcess): void {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	}, 1_000).unref();
}

function cancellationError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("Cursor request was cancelled.");
}

function runCursorCli(
	executable: string,
	args: string[],
	options: {
		cwd: string;
		environment: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeoutMs: number;
		onChild?: (child: ChildProcess | undefined) => void;
		onLine?: (line: string) => void;
	},
): Promise<CliRunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(cancellationError(options.signal));
			return;
		}
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.environment,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		options.onChild?.(child);
		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let settled = false;
		const finish = (error?: Error, result?: CliRunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			options.onChild?.(undefined);
			if (error) reject(error);
			else resolve(result!);
		};
		const stop = (reason: Error) => {
			killChildProcess(child);
			finish(reason);
		};
		const abort = () => stop(cancellationError(options.signal));
		const timer = setTimeout(
			() => stop(new Error("Cursor CLI timed out.")),
			options.timeoutMs,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) return abort();
		child.once("error", () =>
			finish(new Error("Cursor CLI could not be started.")),
		);
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout += text;
			if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES)
				stop(new Error("Cursor CLI output exceeded the safety limit."));
			lineBuffer += text;
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
				stop(new Error("Cursor CLI error output exceeded the safety limit."));
		});
		child.once("close", (code, signal) => {
			const trailing = lineBuffer.trim();
			if (trailing) options.onLine?.(trailing);
			if (code === 0) finish(undefined, { stdout, stderr });
			else
				finish(
					new Error(
						`Cursor CLI exited ${signal ? `on ${signal}` : `with code ${code ?? "unknown"}`}.`,
					),
				);
		});
	});
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function cursorStatusFromOutput(value: string): CursorCliStatus {
	try {
		const parsed = object(JSON.parse(value));
		return {
			connected:
				parsed?.isAuthenticated === true || parsed?.status === "authenticated",
		};
	} catch {
		throw new Error("Cursor CLI returned an invalid account status.");
	}
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
			return `${messageLabel(message)}:\n${[text, unsupported]
				.filter(Boolean)
				.join("\n")}`;
		})
		.join("\n\n");
	return `${transcript}\n\nYou are an isolated reasoning route inside Kestrel. Respond to the final user message as plain text. Do not inspect files, run commands, browse, use MCP, load plugins, make network requests, or take actions. Kestrel owns browser control, tools, and approvals.`;
}

function stringsFrom(value: unknown, depth = 0): string[] {
	if (depth > 4) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value))
		return value.flatMap((entry) => stringsFrom(entry, depth + 1));
	const record = object(value);
	if (!record) return [];
	return [
		...stringsFrom(record.text, depth + 1),
		...stringsFrom(record.delta, depth + 1),
		...stringsFrom(record.content, depth + 1),
	];
}

function eventText(event: Record<string, unknown>): string {
	return stringsFrom(
		event.delta ?? event.text ?? event.content ?? event.message,
	)
		.join("");
}

function resultText(event: Record<string, unknown>): string {
	return stringsFrom(event.result ?? event.message ?? event.text ?? event.content).join(
		"",
	);
}

function parseEvent(line: string): Record<string, unknown> | undefined {
	try {
		return object(JSON.parse(line));
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cursorModelsFromOutput(value: string): DiscoveredModel[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	const root = object(parsed);
	const entries = Array.isArray(parsed)
		? parsed
		: Array.isArray(root?.models)
			? root.models
			: Array.isArray(root?.data)
				? root.data
				: [];
	const models = new Map<string, DiscoveredModel>();
	for (const entry of entries) {
		const record = object(entry);
		if (!record) continue;
		const id = stringValue(record.id ?? record.model);
		if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) continue;
		models.set(id, {
			id,
			displayName: stringValue(record.displayName ?? record.name ?? record.label) ?? id,
			availability: "available",
			source: "cli",
			capabilities: {
				// The CLI listing confirms entitlement, while feature details remain
				// the behavior of this read-only Kestrel transport.
				capabilityProvenance: "transport",
				streaming: true,
				tools: false,
				images: false,
				audio: false,
				documents: false,
				video: false,
				structuredOutput: false,
			},
		});
	}
	return [...models.values()];
}

/**
 * Uses only the official Cursor CLI. Cursor owns its sign-in browser and
 * credential store; Kestrel receives a boolean account state and never reads
 * tokens, cookies, or profile files.
 */
export class CursorCliManager {
	private activeLogin: ChildProcess | undefined;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly statusTimeoutMs: number;
	private readonly loginTimeoutMs: number;

	constructor(private readonly options: CursorCliManagerOptions) {
		this.environment = safeEnvironment(options.environment ?? process.env);
		this.statusTimeoutMs = boundedTimeout(
			options.statusTimeoutMs,
			STATUS_TIMEOUT_MS,
		);
		this.loginTimeoutMs = boundedTimeout(
			options.loginTimeoutMs,
			LOGIN_TIMEOUT_MS,
		);
	}

	async status(signal?: AbortSignal): Promise<CursorCliStatus> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-cursor-status-"));
		try {
			const result = await runCursorCli(
				this.options.executable,
				["agent", "status", "--format", "json"],
				{
					cwd: root,
					environment: this.environment,
					...(signal ? { signal } : {}),
					timeoutMs: this.statusTimeoutMs,
				},
			);
			return cursorStatusFromOutput(result.stdout);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	async connect(signal?: AbortSignal): Promise<CursorCliStatus> {
		if (this.activeLogin)
			throw new Error("Cursor sign-in is already in progress.");
		const root = await mkdtemp(join(tmpdir(), "kestrel-cursor-login-"));
		try {
			await runCursorCli(this.options.executable, ["agent", "login"], {
				cwd: root,
				environment: this.environment,
				...(signal ? { signal } : {}),
				timeoutMs: this.loginTimeoutMs,
				onChild: (child) => {
					this.activeLogin = child;
				},
			});
		} finally {
			this.activeLogin = undefined;
			await rm(root, { recursive: true, force: true });
		}
		const status = await this.status(signal);
		if (!status.connected)
			throw new Error("Cursor sign-in finished without a usable account.");
		return status;
	}

	async cancel(): Promise<void> {
		if (this.activeLogin) killChildProcess(this.activeLogin);
	}
}

export class CursorSubscriptionProvider implements ModelProvider {
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
	private readonly manager: CursorCliManager;

	constructor(options: CursorSubscriptionOptions = {}) {
		this.id = options.id ?? "cursor-subscription";
		this.poolId = options.poolId ?? "cursor-subscription";
		this.executable = options.executable ?? "cursor";
		this.defaultModel = options.defaultModel ?? "cursor-auto";
		this.environment = safeEnvironment(options.environment ?? process.env);
		this.timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
		this.manager = new CursorCliManager({
			executable: this.executable,
			...(options.environment ? { environment: options.environment } : {}),
		});
	}

	async probe(signal?: AbortSignal): Promise<void> {
		try {
			if (!(await this.manager.status(signal)).connected)
				throw new Error("Cursor is not signed in.");
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ModelProviderError(
				"Cursor is not signed in. Complete sign-in with the official Cursor CLI.",
				this.id,
				false,
				401,
			);
		}
	}

	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		await this.probe(signal);
		const defaults: DiscoveredModel[] = [
			{
				id: "cursor-auto",
				displayName: "Cursor Auto",
				availability: "available",
				source: "cli",
				capabilities: {
					capabilityProvenance: "confirmed",
					streaming: true,
					tools: false,
					images: false,
					audio: false,
					documents: false,
					video: false,
					structuredOutput: false,
				},
			},
		];
		const root = await mkdtemp(join(tmpdir(), "kestrel-cursor-models-"));
		try {
			const result = await runCursorCli(
				this.executable,
				["agent", "--list-models", "--output-format", "json"],
				{
					cwd: root,
					environment: this.environment,
					...(signal ? { signal } : {}),
					timeoutMs: Math.min(this.timeoutMs, 60_000),
				},
			);
			return [
				...defaults,
				...cursorModelsFromOutput(result.stdout).filter(
					(model) => model.id !== "cursor-auto",
				),
			];
		} catch (error) {
			if (signal?.aborted) throw error;
			// Cursor Auto is the documented default when the installed CLI cannot
			// enumerate a model list. Keep that verified account route usable.
			return defaults;
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	async complete(
		request: ModelRequest,
		options: ModelCallOptions = {},
	): Promise<ModelResult> {
		const root = await mkdtemp(join(tmpdir(), "kestrel-cursor-agent-"));
		let streamedText = "";
		let finalText = "";
		let responseId: string | undefined;
		try {
			const args = [
				"agent",
				"--print",
				"--output-format",
				"stream-json",
				"--stream-partial-output",
				"--mode",
				"ask",
				"--sandbox",
				"enabled",
			];
			if (
				request.model &&
				request.model !== "cursor-auto" &&
				request.model !== "default"
			)
				args.push("--model", request.model);
			args.push(promptFor(request));
			await runCursorCli(this.executable, args, {
				cwd: root,
				environment: this.environment,
				...(options.signal ? { signal: options.signal } : {}),
				timeoutMs: this.timeoutMs,
				onLine: (line) => {
					const event = parseEvent(line);
					if (!event) return;
					if (typeof event.sessionId === "string") responseId = event.sessionId;
					if (typeof event.session_id === "string") responseId = event.session_id;
					if (typeof event.chatId === "string") responseId = event.chatId;
					if (event.type === "result") {
						finalText = resultText(event) || finalText;
						return;
					}
					const delta = eventText(event);
					if (!delta) return;
					streamedText += delta;
					options.onEvent?.({ type: "text_delta", delta });
				},
			});
			const text = finalText || streamedText;
			if (!streamedText && text)
				options.onEvent?.({ type: "text_delta", delta: text });
			return {
				providerId: this.id,
				model: request.model,
				...(responseId ? { responseId } : {}),
				text,
				toolCalls: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				finishReason: "stop",
			};
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new ModelProviderError(
				error instanceof Error && error.message.includes("safety limit")
					? error.message
					: "Cursor request failed.",
				this.id,
				true,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}
