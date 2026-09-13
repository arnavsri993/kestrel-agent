import { EventEmitter } from "node:events";
import {
	AgentStreamEventSchema,
	BackgroundJobsEventSchema,
	type CoreRequest,
	type CoreResponse,
	CoreResponseSchema,
	type Project,
	RuntimeEventSchema,
} from "@kestrel/shared-types";
import type { ProviderAccountRuntimeConfig } from "@kestrel/agent-core";
import {
	ProtectedDatabaseError,
	PROTECTED_DATABASE_ERROR_CODE,
} from "@kestrel/database";
import {
	BrowserBackendCancelMessageSchema,
	BrowserBackendRequestMessageSchema,
	type BrowserBackendWireRequest,
} from "./browser-backend-wire";
import type { CoreProcess } from "./core-process";

import {
	coreRequestTimeoutMs,
	timedOutAgentStreamId,
} from "./core-request-lifecycle";

export interface CoreBootstrapConfig {
	/** Host-owned immutable runtime tool ceiling, preserved during recovery. */
	hostToolNames?: string[];
	databasePath: string;
	encryptionKeyBase64: string;
	workspaceRoots: string[];
	configuredWorkspaceRoots: string[];
	projects?: Project[];
	pluginRoots: string[];
	managedPluginRoots: string[];
	learnedSkillRoot: string;
	secureEnvironment: NodeJS.ProcessEnv;
	/** Runtime-only protected account credentials for the child bootstrap. */
	providerAccounts?: ProviderAccountRuntimeConfig[];
}

export interface CoreSupervisorOptions {
	processFactory: () => CoreProcess;
	restartDelaysMs?: readonly number[];
	stabilityWindowMs?: number;
	startupTimeoutMs?: number;
}

const DEFAULT_RESTART_DELAYS_MS = [250, 1_000, 5_000] as const;
const DEFAULT_STABILITY_WINDOW_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

function boundedTimer(
	value: number | undefined,
	fallback: number,
	minimum: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_TIMER_MS, Math.max(minimum, Math.trunc(value)));
}

function cloneBootstrapConfig(
	config: CoreBootstrapConfig,
): CoreBootstrapConfig {
	return {
		...config,
		...(config.hostToolNames !== undefined ? { hostToolNames: [...config.hostToolNames] } : {}),
		workspaceRoots: [...config.workspaceRoots],
		configuredWorkspaceRoots: [...config.configuredWorkspaceRoots],
		projects: config.projects?.map((project) => ({ ...project })) ?? [],
		pluginRoots: [...config.pluginRoots],
		managedPluginRoots: [...config.managedPluginRoots],
		secureEnvironment: { ...config.secureEnvironment },
		...(config.providerAccounts !== undefined
			? {
				providerAccounts: config.providerAccounts.map((account) => ({
					...account,
					...(account.headers ? { headers: { ...account.headers } } : {}),
				})),
			}
			: {}),
	};
}

export class CoreSupervisor extends EventEmitter {
	private child: CoreProcess | undefined;
	private readonly pending = new Map<
		string,
		{
			resolve: (value: CoreResponse) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	private requestNumber = 0;
	private stopping = false;
	private ready = false;
	private readonly browserRequests = new Map<string, AbortController>();
	private readonly processFactory: () => CoreProcess;
	private readonly restartDelaysMs: readonly number[];
	private readonly stabilityWindowMs: number;
	private readonly startupTimeoutMs: number;
	private lastSuccessfulConfig: CoreBootstrapConfig | undefined;
	private restartAttempts = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private stabilityTimer: NodeJS.Timeout | undefined;
	private recoveryFailureEmitted = false;
	private browserCleanup: Promise<void> = Promise.resolve();
	private startup:
		| {
				child: CoreProcess;
				resolve: () => void;
				reject: (error: Error) => void;
				timeout: NodeJS.Timeout;
				config: CoreBootstrapConfig;
		  }
		| undefined;

	constructor(
		private readonly browserHandler: ((
			request: BrowserBackendWireRequest,
			signal: AbortSignal,
		) => Promise<unknown>) | undefined,
		private readonly closeBrowsers: (() => Promise<void>) | undefined,
		options: CoreSupervisorOptions,
	) {
		super();
		this.processFactory = options.processFactory;
		const restartDelays = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
		this.restartDelaysMs = restartDelays.map((delay, index) =>
			boundedTimer(
				delay,
				DEFAULT_RESTART_DELAYS_MS[index] ?? DEFAULT_RESTART_DELAYS_MS.at(-1)!,
				0,
			),
		);
		this.stabilityWindowMs = boundedTimer(
			options.stabilityWindowMs,
			DEFAULT_STABILITY_WINDOW_MS,
			0,
		);
		this.startupTimeoutMs = boundedTimer(
			options.startupTimeoutMs,
			DEFAULT_STARTUP_TIMEOUT_MS,
			1,
		);
	}

	async start(config: CoreBootstrapConfig): Promise<void> {
		this.stopping = false;
		this.clearRecoveryTimers();
		this.restartAttempts = 0;
		this.recoveryFailureEmitted = false;
		this.lastSuccessfulConfig = undefined;
		const protectedConfig = cloneBootstrapConfig(config);
		await this.launch(protectedConfig);
		this.lastSuccessfulConfig = protectedConfig;
	}

	request(request: CoreRequest): Promise<CoreResponse> {
		const child = this.child;
		if (!child || !this.ready)
			return Promise.reject(
				new Error(
					this.recoveryFailureEmitted
						? "Agent Core could not recover. Restart Kestrel to try again."
						: this.restartTimer || (this.lastSuccessfulConfig && !this.stopping)
							? "Agent Core is restarting. Try again in a moment."
							: "Agent Core is unavailable.",
				),
			);
		const requestId = `core-${++this.requestNumber}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(requestId);
				const streamId = timedOutAgentStreamId(request);
				let cancellationRequestSent = false;
				if (streamId && this.child === child) {
					try {
						child.postMessage({
							type: "request",
							requestId: `core-timeout-cancel-${++this.requestNumber}`,
							request: { type: "runtime-cancel-stream", streamId },
						});
						cancellationRequestSent = true;
					} catch {
						// The original request still rejects even if the child exits while
						// the best-effort cancellation message is being sent.
					}
				}
				reject(
					new Error(
						streamId
							? cancellationRequestSent
								? "Agent Core did not finish in time; cancellation was requested."
								: "Agent Core did not finish in time, and Kestrel could not request cancellation."
							: "Agent Core request timed out.",
					),
				);
			}, coreRequestTimeoutMs(request));
			this.pending.set(requestId, { resolve, reject, timeout });
			try {
				child.postMessage({ type: "request", requestId, request });
			} catch (cause) {
				clearTimeout(timeout);
				this.pending.delete(requestId);
				reject(
					cause instanceof Error
						? cause
						: new Error("Agent Core could not receive the request."),
				);
			}
		});
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.ready = false;
		this.clearRecoveryTimers();
		for (const controller of this.browserRequests.values())
			controller.abort(new Error("Agent Core is stopping."));
		this.browserRequests.clear();
		await this.cleanupBrowsers();
		const child = this.child;
		if (!child) return;
		const exited = new Promise<void>((resolve) => {
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				resolve();
			};
			child.once("exit", finish);
			timeout = setTimeout(() => {
				try {
					child.kill();
				} catch {
					// The forced detach below still makes the supervisor restartable.
				}
				finish();
			}, 2_000);
			timeout.unref();
		});
		try {
			child.postMessage({ type: "shutdown" });
		} catch {
			try {
				child.kill();
			} catch {
				// The forced detach below still makes the supervisor restartable.
			}
		}
		await exited;
		if (this.child === child) {
			this.child = undefined;
			this.settleStartup(
				child,
				new Error("Agent Core stopped before becoming ready."),
			);
			for (const request of this.pending.values()) {
				clearTimeout(request.timeout);
				request.reject(new Error("Agent Core stopped before responding."));
			}
			this.pending.clear();
		}
	}

	private launch(config: CoreBootstrapConfig): Promise<void> {
		if (this.child)
			return Promise.reject(new Error("Agent Core is already running."));
		const child = this.processFactory();
		this.child = child;
		this.ready = false;
		child.on("message", (message) => this.onMessage(child, message));
		child.on("exit", (code) => this.onExit(child, code));
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				const error = new Error(
					"Agent Core did not become ready within 10 seconds.",
				);
				this.settleStartup(child, error);
				if (this.child === child) this.child = undefined;
				try {
					child.kill();
				} catch {
					// The startup promise already carries the actionable failure.
				}
			}, this.startupTimeoutMs);
			timeout.unref();
			this.startup = {
				child,
				resolve,
				reject,
				timeout,
				config: cloneBootstrapConfig(config),
			};
			try {
				child.postMessage({
					type: "bootstrap",
					config: cloneBootstrapConfig(config),
				});
			} catch (cause) {
				const error =
					cause instanceof Error
						? cause
						: new Error("Agent Core bootstrap could not be sent.");
				this.settleStartup(child, error);
				if (this.child === child) this.child = undefined;
				try {
					child.kill();
				} catch {
					// The startup promise already carries the actionable failure.
				}
			}
		});
	}

	private onMessage(child: CoreProcess, message: unknown): void {
		if (child !== this.child) return;
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			this.invalidCoreMessage("message");
			return;
		}
		const wire = message as Record<string, unknown>;
		if (wire.type === "ready") {
			if (this.stopping || this.startup?.child !== child) return;
			this.lastSuccessfulConfig = cloneBootstrapConfig(this.startup.config);
			this.ready = true;
			this.settleStartup(child);
			this.emit("ready");
			return;
		}
		if (wire.type === "start-error") {
			const message =
				typeof wire.error === "string"
					? wire.error
					: "Agent Core reported an invalid startup error.";
			const error =
				wire.errorCode === PROTECTED_DATABASE_ERROR_CODE
					? new ProtectedDatabaseError(message)
					: new Error(message);
			this.settleStartup(child, error);
			this.child = undefined;
			this.ready = false;
			try {
				child.kill();
			} catch {
				// The rejected startup promise surfaces the bootstrap failure.
			}
			this.emit("start-error", error);
			return;
		}
		if (wire.type === "runtime-event") {
			const parsed = RuntimeEventSchema.safeParse(wire.event);
			if (!parsed.success) this.invalidCoreMessage("runtime event");
			else this.emit("runtime-event", parsed.data);
			return;
		}
		if (wire.type === "agent-stream") {
			const parsed = AgentStreamEventSchema.safeParse(wire.event);
			if (!parsed.success) this.invalidCoreMessage("agent stream event");
			else this.emit("agent-stream", parsed.data);
			return;
		}
		if (wire.type === "background-jobs") {
			const parsed = BackgroundJobsEventSchema.safeParse(wire.event);
			if (!parsed.success) this.invalidCoreMessage("background jobs event");
			else this.emit("background-jobs", parsed.data);
			return;
		}
		if (wire.type === "automation-error") {
			this.emit(
				"automation-error",
				new Error(
					typeof wire.error === "string"
						? wire.error
						: "Agent Core reported an invalid automation error.",
				),
			);
			return;
		}
		if (wire.type === "browser-backend-cancel") {
			const parsed = BrowserBackendCancelMessageSchema.safeParse(wire);
			if (!parsed.success) {
				this.invalidCoreMessage("browser backend cancel");
				return;
			}
			this.browserRequests
				.get(parsed.data.requestId)
				?.abort(new Error("Browser operation cancelled."));
			return;
		}
		if (wire.type === "browser-backend-request") {
			const parsed = BrowserBackendRequestMessageSchema.safeParse(wire);
			if (!parsed.success) {
				this.invalidCoreMessage("browser backend request");
				return;
			}
			const requestId = parsed.data.requestId;
			if (!this.browserHandler) {
				this.safePost(child, {
					type: "browser-backend-response",
					requestId,
					ok: false,
					error: "Browser backend is unavailable.",
				});
				return;
			}
			const controller = new AbortController();
			this.browserRequests.set(requestId, controller);
			void Promise.resolve()
				.then(() => this.browserHandler!(parsed.data.request, controller.signal))
				.then((result) =>
					this.safePost(child, {
						type: "browser-backend-response",
						requestId,
						ok: true,
						result,
					}),
				)
				.catch((error) =>
					this.safePost(child, {
						type: "browser-backend-response",
						requestId,
						ok: false,
						error:
							error instanceof Error
								? error.message
								: "Browser backend failed.",
					}),
				)
				.finally(() => {
					if (this.browserRequests.get(requestId) === controller)
						this.browserRequests.delete(requestId);
				});
			return;
		}
		if (typeof wire.requestId !== "string" || !("response" in wire)) {
			this.invalidCoreMessage("response");
			return;
		}
		const pending = this.pending.get(wire.requestId);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pending.delete(wire.requestId);
		try {
			pending.resolve(CoreResponseSchema.parse(wire.response));
		} catch (cause) {
			pending.reject(
				cause instanceof Error
					? cause
					: new Error("Agent Core returned an invalid response."),
			);
		}
	}

	private onExit(child: CoreProcess, code: number | null): void {
		if (child !== this.child) return;
		this.child = undefined;
		this.ready = false;
		this.settleStartup(
			child,
			new Error("Agent Core stopped before becoming ready."),
		);
		for (const request of this.pending.values()) {
			clearTimeout(request.timeout);
			request.reject(new Error("Agent Core stopped before responding."));
		}
		this.pending.clear();
		for (const controller of this.browserRequests.values())
			controller.abort(new Error("Agent Core stopped."));
		this.browserRequests.clear();
		this.browserCleanup = this.cleanupBrowsers();
		if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
		this.stabilityTimer = undefined;
		if (this.stopping) return;
		this.scheduleRecovery(
			code,
			new Error(
				`Agent Core exited unexpectedly${code === null ? "" : ` with code ${code}`}.`,
			),
		);
	}

	private async cleanupBrowsers(): Promise<void> {
		try {
			await this.closeBrowsers?.();
		} catch (error) {
			this.emit("automation-error", error instanceof Error
				? error : new Error("Browser cleanup failed after Agent Core stopped."));
		}
	}

	private scheduleRecovery(code: number | null, cause: Error): void {
		if (this.stopping || this.restartTimer || this.child) return;
		const config = this.lastSuccessfulConfig;
		if (!config) {
			this.emit("crash", {
				code,
				restarts: this.restartAttempts,
				recovering: false,
			});
			return;
		}
		if (this.restartAttempts >= this.restartDelaysMs.length) {
			this.emit("crash", {
				code,
				restarts: this.restartAttempts,
				recovering: false,
			});
			if (!this.recoveryFailureEmitted) {
				this.recoveryFailureEmitted = true;
				this.emit(
					"recovery-failed",
					new Error(
						`Agent Core could not recover after ${this.restartAttempts} attempts: ${cause.message}`,
					),
				);
			}
			return;
		}
		const delayMs = this.restartDelaysMs[this.restartAttempts]!;
		const attempt = ++this.restartAttempts;
		this.emit("crash", {
			code,
			restarts: attempt,
			recovering: true,
			delayMs,
		});
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.stopping || this.child) return;
			void this.browserCleanup
				.then(async () => {
					if (this.stopping || this.child) return false;
					await this.launch(config);
					return true;
				})
				.then((launched) => {
					if (!launched || this.stopping || !this.child) return;
					this.emit("recovered", { attempt });
					this.stabilityTimer = setTimeout(() => {
						this.stabilityTimer = undefined;
						this.restartAttempts = 0;
						this.recoveryFailureEmitted = false;
					}, this.stabilityWindowMs);
					this.stabilityTimer.unref();
				})
				.catch((error) => {
					if (this.stopping) return;
					this.scheduleRecovery(
						null,
						error instanceof Error
							? error
							: new Error("Agent Core recovery failed."),
					);
				});
		}, delayMs);
		this.restartTimer.unref();
	}

	private settleStartup(child: CoreProcess, error?: Error): void {
		if (!this.startup || this.startup.child !== child) return;
		const startup = this.startup;
		this.startup = undefined;
		clearTimeout(startup.timeout);
		if (error) startup.reject(error);
		else startup.resolve();
	}

	private safePost(child: CoreProcess, message: unknown): void {
		if (child !== this.child) return;
		try {
			child.postMessage(message);
		} catch {
			// The exit handler rejects any user-visible work if the process is gone.
		}
	}

	private invalidCoreMessage(kind: string): void {
		this.emit(
			"automation-error",
			new Error(`Agent Core sent an invalid ${kind}.`),
		);
	}

	private clearRecoveryTimers(): void {
		if (this.restartTimer) clearTimeout(this.restartTimer);
		if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
		this.restartTimer = undefined;
		this.stabilityTimer = undefined;
	}
}
