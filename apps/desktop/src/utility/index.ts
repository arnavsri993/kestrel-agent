import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
	AgentCore,
	type BrowserAction,
	type BrowserAutomationBackend,
	BrowserController,
	type BrowserDiagnostic,
	type BrowserDownload,
	type BrowserSnapshot,
	type BrowserViewport,
	createEnvironmentMediaProviders,
	createEnvironmentModelProviders,
	createEnvironmentTranscriptionProvider,
	type DesktopAction,
	environmentChannelConfiguration,
	environmentGoogleWorkspaceClient,
	environmentLanguageServerClient,
	environmentRemoteExecutionConfiguration,
	environmentWebAccessOptions,
	installBrowserTools,
	installCodeIntelligenceTools,
	installGoogleWorkspaceTools,
	type LanguageServerClient,
	loadSignedManagedPolicy,
	type ScreenshotFrame,
	VisualValidator,
} from "@kestrel/agent-core";
import { KestrelDatabase } from "@kestrel/database";
import { CoreRequestSchema } from "@kestrel/shared-types";

interface ParentPort {
	on(event: "message", listener: (event: { data: unknown }) => void): void;
	postMessage(message: unknown): void;
}
const port = (process as typeof process & { parentPort?: ParentPort })
	.parentPort;
if (!port)
	throw new Error(
		"Kestrel Agent Core must run as an Electron utility process.",
	);

let core: AgentCore | undefined;
let languageServer: LanguageServerClient | undefined;
let automationTimer: NodeJS.Timeout | undefined;
let automationRunning = false;
let automationController: AbortController | undefined;
let automationTask: Promise<void> | undefined;
const browserPending = new Map<
	string,
	{
		resolve(value: unknown): void;
		reject(error: Error): void;
		abort?: () => void;
		signal?: AbortSignal;
	}
>();

function browserRequest<T>(
	request: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	const requestId = `browser-wire-${randomUUID()}`;
	return new Promise<T>((resolve, reject) => {
		const cancelled = () =>
			signal?.reason instanceof Error
				? signal.reason
				: new Error("Browser operation cancelled.");
		if (signal?.aborted) {
			reject(cancelled());
			return;
		}
		const abort = signal
			? () => {
					port.postMessage({ type: "browser-backend-cancel", requestId });
					reject(
						signal.reason instanceof Error
							? signal.reason
							: new Error("Browser operation cancelled."),
					);
					browserPending.delete(requestId);
				}
			: undefined;
		if (abort) {
			signal!.addEventListener("abort", abort, { once: true });
			if (signal!.aborted) {
				signal!.removeEventListener("abort", abort);
				reject(cancelled());
				return;
			}
		}
		browserPending.set(requestId, {
			resolve,
			reject,
			...(abort && signal ? { abort, signal } : {}),
		});
		port.postMessage({ type: "browser-backend-request", requestId, request });
	});
}

const browserBackend: BrowserAutomationBackend = {
	createSession: async ({ allowedOrigins }) =>
		browserRequest<string>({ operation: "create", allowedOrigins }),
	navigate: async (sessionId, url, signal) => {
		await browserRequest({ operation: "navigate", sessionId, url }, signal);
	},
	act: async (sessionId, action: BrowserAction, signal) => {
		await browserRequest({ operation: "act", sessionId, action }, signal);
	},
	snapshot: (sessionId, signal) =>
		browserRequest<BrowserSnapshot>(
			{ operation: "snapshot", sessionId },
			signal,
		),
	screenshot: async (sessionId, signal) => {
		const result = await browserRequest<ScreenshotFrame>(
			{ operation: "screenshot", sessionId },
			signal,
		);
		return {
			...result,
			rgba: new Uint8Array(result.rgba),
			...(result.png ? { png: new Uint8Array(result.png) } : {}),
		};
	},
	setViewport: async (sessionId, viewport: BrowserViewport, signal) => {
		await browserRequest(
			{ operation: "viewport", sessionId, viewport },
			signal,
		);
	},
	diagnostics: (sessionId, signal) =>
		browserRequest<BrowserDiagnostic[]>(
			{ operation: "diagnostics", sessionId },
			signal,
		),
	authHandoff: async (sessionId, visible, signal) => {
		await browserRequest(
			{ operation: "auth-handoff", sessionId, visible },
			signal,
		);
	},
	upload: async (sessionId, selector, paths, signal) => {
		await browserRequest(
			{ operation: "upload", sessionId, selector, paths },
			signal,
		);
	},
	downloads: (sessionId, signal) =>
		browserRequest<BrowserDownload[]>(
			{ operation: "downloads", sessionId },
			signal,
		),
	desktopScreenshot: async (signal) => {
		const result = await browserRequest<ScreenshotFrame>(
			{ operation: "desktop-screenshot" },
			signal,
		);
		return {
			...result,
			rgba: new Uint8Array(result.rgba),
			...(result.png ? { png: new Uint8Array(result.png) } : {}),
		};
	},
	desktopAct: async (action: DesktopAction, signal) => {
		await browserRequest({ operation: "desktop-act", action }, signal);
	},
	visibleTabs: (signal) =>
		browserRequest({ operation: "visible-tabs" }, signal),
	visibleContext: (tabId, signal) =>
		browserRequest(
			{ operation: "visible-context", ...(tabId ? { tabId } : {}) },
			signal,
		),
	visibleSnapshot: (tabId, signal) =>
		browserRequest(
			{ operation: "visible-snapshot", ...(tabId ? { tabId } : {}) },
			signal,
		),
	visibleScreenshot: async (tabId, signal) => {
		const result = await browserRequest<ScreenshotFrame>(
			{ operation: "visible-screenshot", ...(tabId ? { tabId } : {}) },
			signal,
		);
		return {
			...result,
			rgba: new Uint8Array(result.rgba),
			...(result.png ? { png: new Uint8Array(result.png) } : {}),
		};
	},
	visibleHistory: (query, limit, signal) =>
		browserRequest(
			{
				operation: "visible-history",
				...(query ? { query } : {}),
				...(limit !== undefined ? { limit } : {}),
			},
			signal,
		),
	visibleDownloads: (signal) =>
		browserRequest({ operation: "visible-downloads" }, signal),
	visibleAct: async (tabId, action, signal) => {
		await browserRequest({ operation: "visible-act", tabId, action }, signal);
	},
	visibleNavigate: async (tabId, input, signal) => {
		await browserRequest(
			{ operation: "visible-navigate", tabId, input },
			signal,
		);
	},
	visibleCreate: (input, signal) =>
		browserRequest(
			{ operation: "visible-create", ...(input ? { input } : {}) },
			signal,
		),
	visibleClose: async (tabId, signal) => {
		await browserRequest({ operation: "visible-close", tabId }, signal);
	},
	visibleSelect: async (tabId, signal) => {
		await browserRequest({ operation: "visible-select", tabId }, signal);
	},
	close: async (sessionId) => {
		await browserRequest({ operation: "close", sessionId });
	},
};

port.on("message", async ({ data }) => {
	const message = data as {
		type?: string;
		config?: {
			databasePath: string;
			encryptionKeyBase64: string;
			workspaceRoots: string[];
			configuredWorkspaceRoots: string[];
			pluginRoots: string[];
			managedPluginRoots: string[];
			learnedSkillRoot: string;
			secureEnvironment: NodeJS.ProcessEnv;
		};
		requestId?: string;
		request?: unknown;
		ok?: boolean;
		result?: unknown;
		error?: string;
	};
	if (message.type === "browser-backend-response" && message.requestId) {
		const pending = browserPending.get(message.requestId);
		if (!pending) return;
		browserPending.delete(message.requestId);
		if (pending.abort && pending.signal)
			pending.signal.removeEventListener("abort", pending.abort);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new Error(message.error ?? "Browser backend failed."));
		return;
	}
	if (message.type === "bootstrap" && message.config) {
		try {
			const database = new KestrelDatabase(
				message.config.databasePath,
				Buffer.from(message.config.encryptionKeyBase64, "base64"),
			);
			const webAccess = environmentWebAccessOptions(
				message.config.secureEnvironment,
			);
			const configuredChannels = environmentChannelConfiguration();
			const googleWorkspace = environmentGoogleWorkspaceClient(
				message.config.secureEnvironment,
			);
			const channels = googleWorkspace
				? {
						adapters: [
							...(configuredChannels?.adapters ?? []),
							googleWorkspace.gmailAdapter,
						],
						signingSecrets: configuredChannels?.signingSecrets ?? {},
						sessionRoutes: configuredChannels?.sessionRoutes ?? {},
					}
				: configuredChannels;
			const managedPolicy =
				process.env.KESTREL_MANAGED_POLICY &&
				process.env.KESTREL_MANAGED_POLICY_KEY
					? loadSignedManagedPolicy(
							process.env.KESTREL_MANAGED_POLICY,
							process.env.KESTREL_MANAGED_POLICY_KEY,
						)
					: undefined;
			if (
				Boolean(process.env.KESTREL_MANAGED_POLICY) !==
				Boolean(process.env.KESTREL_MANAGED_POLICY_KEY)
			)
				throw new Error(
					"KESTREL_MANAGED_POLICY and KESTREL_MANAGED_POLICY_KEY must be configured together.",
				);
			const artifactRoot = join(
				dirname(message.config.databasePath),
				"artifacts",
			);
			const transcriptionProvider = createEnvironmentTranscriptionProvider(
				message.config.secureEnvironment,
			);
			const remoteExecution = environmentRemoteExecutionConfiguration(
				message.config.secureEnvironment,
				join(artifactRoot, "remote"),
			);
			core = new AgentCore({
				database,
				seedDevelopmentFixtures:
					Boolean(process.env.KESTREL_TEST_USER_DATA) &&
					process.env.KESTREL_REAL_USER_PROFILE !== "1",
				modelProviders: createEnvironmentModelProviders(
					message.config.secureEnvironment,
				),
				mediaProviders: createEnvironmentMediaProviders(
					message.config.secureEnvironment,
				),
				...(transcriptionProvider ? { transcriptionProvider } : {}),
				...(message.config.secureEnvironment.GITHUB_TOKEN
					? { githubToken: message.config.secureEnvironment.GITHUB_TOKEN }
					: {}),
				...(message.config.secureEnvironment.HONCHO_API_KEY
					? { honchoApiKey: message.config.secureEnvironment.HONCHO_API_KEY }
					: {}),
				...(remoteExecution ? { remoteExecution } : {}),
				workspaceRoots: message.config.workspaceRoots,
				configuredWorkspaceRoots: message.config.configuredWorkspaceRoots,
				learnedSkillRoot: message.config.learnedSkillRoot,
				pluginRoots: message.config.pluginRoots,
				managedPluginRoots: message.config.managedPluginRoots,
				artifactRoot,
				petRoot: join(dirname(message.config.databasePath), "pets"),
				onAgentTextDelta: (event) =>
					port.postMessage({ type: "agent-stream", event }),
				...(webAccess ? { webAccess } : {}),
				...(channels ? { channels } : {}),
				...(managedPolicy ? { managedPolicy } : {}),
				...(googleWorkspace ? { googleWorkspace } : {}),
			});
			for (const key of Object.keys(message.config.secureEnvironment))
				delete message.config.secureEnvironment[key];
			const mainSession = core.runtime.ensureMainSession();
			if (googleWorkspace)
				installGoogleWorkspaceTools(
					core.runtime,
					googleWorkspace,
					mainSession.id,
				);
			const browserToolNames = installBrowserTools(
				core.runtime,
				new BrowserController(browserBackend),
				mainSession.id,
				new VisualValidator(database, artifactRoot),
			);
			// Sessions created after registration inherit these tools automatically.
			// Preserve conversation timestamps while making the new browser layer
			// available to conversations that already existed before this release.
			for (const session of core.runtime.listSessions())
				if (session.id !== mainSession.id)
					core.runtime.allowTools(session.id, browserToolNames, {
						preserveUpdatedAt: true,
					});
			const configuredLanguageServer = await environmentLanguageServerClient();
			if (configuredLanguageServer) {
				languageServer = configuredLanguageServer.client;
				for (const session of core.runtime.listSessions())
					installCodeIntelligenceTools(
						core.runtime,
						languageServer,
						session.id,
					);
			}
			core.runtime.on("event", (event) =>
				port.postMessage({ type: "runtime-event", event }),
			);
			automationTimer = setInterval(() => {
				if (!core || automationRunning) return;
				automationRunning = true;
				const controller = new AbortController();
				automationController = controller;
				const checkedAt = new Date();
				const task = Promise.resolve()
					.then(async () => {
						await core!.runAmbientMaintenance(checkedAt);
						return core!.orchestrator.runDue(checkedAt, controller.signal);
					})
					.then((jobs) => {
						if (jobs.length === 0) return;
						port.postMessage({
							type: "background-jobs",
							event: {
								checkedAt: checkedAt.toISOString(),
								jobs: jobs.map(
									({
										prompt: _prompt,
										instructions: _instructions,
										providerModels: _models,
										...job
									}) => job,
								),
							},
						});
					})
					.catch((error) =>
						port.postMessage({
							type: "automation-error",
							error:
								error instanceof Error
									? error.message
									: "Background automation failed.",
						}),
					)
					.finally(() => {
						if (automationController === controller)
							automationController = undefined;
						if (automationTask === task) automationTask = undefined;
						automationRunning = false;
					});
				automationTask = task;
				void task;
			}, 30_000);
			automationTimer.unref();
			port.postMessage({ type: "ready" });
		} catch (error) {
			port.postMessage({
				type: "start-error",
				error: error instanceof Error ? error.message : "Core bootstrap failed",
			});
		}
		return;
	}
	if (message.type === "request" && message.requestId) {
		const response = core
			? await core.handle(CoreRequestSchema.parse(message.request))
			: { ok: false as const, error: "Agent Core is not initialized." };
		port.postMessage({ requestId: message.requestId, response });
		return;
	}
	if (message.type === "shutdown") {
		if (automationTimer) clearInterval(automationTimer);
		automationTimer = undefined;
		automationController?.abort(new Error("Kestrel is shutting down."));
		automationController = undefined;
		await automationTask;
		automationTask = undefined;
		for (const pending of browserPending.values()) {
			if (pending.abort && pending.signal)
				pending.signal.removeEventListener("abort", pending.abort);
			pending.reject(new Error("Agent Core is shutting down."));
		}
		browserPending.clear();
		await languageServer?.close();
		await core?.close();
		process.exit(0);
	}
});
