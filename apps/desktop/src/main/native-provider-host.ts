import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProviderAccountRuntimeConfig } from "@kestrel/agent-core";
import { RendererRequestSchema, type RendererResponse, type SubscriptionCliStatus } from "@kestrel/shared-types";
import { CredentialBroker, PlaintextSecretProtection } from "./credential-broker";
import { ChatGptOAuthManager, type ChatGptOAuthStatus } from "./chatgpt-oauth";
import { ProviderAccountStore } from "./provider-account-store";
import { NATIVE_PROVIDER_REQUEST_TYPES } from "./native-provider-requests";
import { NativeLocalRuntime, nativeSystemProfile, NATIVE_LOCAL_RUNTIME_UNAVAILABLE, type NativeLocalSelection } from "./native-setup-status";

const CLI = {
	codex: { name: "Codex", label: "ChatGPT plan through Codex", adapter: "codex-app-server", providerId: "codex", env: "KESTREL_CODEX_PATH" },
	claude: { name: "Claude Code", label: "Claude plan through Claude Code", adapter: "claude-cli", providerId: "claude", env: "KESTREL_CLAUDE_PATH" },
	opencode: { name: "OpenCode", label: "OpenCode AI runtime", adapter: "opencode-cli", providerId: "opencode", env: "KESTREL_OPENCODE_PATH" },
	cursor: { name: "Cursor", label: "Cursor account through Cursor Agent", adapter: "cursor-cli", providerId: "cursor", env: "KESTREL_CURSOR_PATH" },
} as const;
type CliId = keyof typeof CLI;
type Subscriptions = Partial<Record<CliId, { enabled: true; path: string }>>;
interface Preferences { subscriptions: Subscriptions; localModel?: NativeLocalSelection }

type OAuthManager = Pick<ChatGptOAuthManager, "status" | "connect" | "cancel">;
interface OAuthOptions {
	executable: string;
	environment: NodeJS.ProcessEnv;
	openExternal(url: string): Promise<void>;
	requestTimeoutMs: number;
}

interface Options {
	root: string;
	encryptionKeyBase64: string;
	/** Original host home, not the private Agent Core HOME. */
	homeDirectory: string;
	environment: NodeJS.ProcessEnv;
	reconfigure<T>(mutation: () => Promise<T>): Promise<T>;
	/** Account metadata only; injectable for deterministic tests. */
	accountStatus?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<ChatGptOAuthStatus>;
	/** Open a provider-owned sign-in page in this Kestrel Chromium window. */
	openAuthUrl?: (url: string, signal: AbortSignal) => Promise<void>;
	/** No credentials cross this account-management boundary. */
	createOAuthManager?: (options: OAuthOptions) => OAuthManager;
	/** Fixed loopback transport; injectable for deterministic local setup tests. */
	localFetch?: typeof fetch;
}

function authUrl(raw: string): string {
	if (raw.length > 8192) throw new Error("Unexpected ChatGPT sign-in URL.");
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error("Unexpected ChatGPT sign-in URL."); }
	const allowed = ["openai.com", "chatgpt.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
	if (url.protocol !== "https:" || !allowed || url.username || url.password || url.port)
		throw new Error("Unexpected ChatGPT sign-in URL.");
	return url.toString();
}

// No shell/PATH lookup and no persisted renderer-provided executable. Each use
// re-detects a bounded trusted host installation and compares its real path.
export async function detectNativeSubscriptionCli(id: CliId, home: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (environment.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY === "1") return undefined;
	const names = id === "cursor" ? ["agent", "cursor-agent", "cursor"] : [id];
	const candidates = [environment[CLI[id].env],
		...(id === "codex" ? [
			"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
			"/Applications/ChatGPT.app/Contents/Resources/codex",
		] : []),
		...names.flatMap(name => [join(home, ".local/bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, join(home, ".npm-global/bin", name), join(home, "bin", name)]),
	];
	for (const candidate of candidates) {
		if (!candidate || !isAbsolute(candidate)) continue;
		try {
			const path = await realpath(candidate);
			const info = await stat(path);
			if (info.isFile() && (info.mode & 0o111) !== 0) return path;
		} catch { /* A removed installation does not authorize another executable. */ }
	}
	return undefined;
}

export class NativeProviderHost {
	private readonly broker: CredentialBroker;
	private readonly store: ProviderAccountStore;
	private readonly preferencesPath: string;
	private readonly localRuntime: NativeLocalRuntime;
	private statusCache: { path: string; until: number; value: ChatGptOAuthStatus } | undefined;
	private statusPending: { path: string; promise: Promise<ChatGptOAuthStatus> } | undefined;
	private statusGeneration = 0;
	private readonly statusManagers = new Set<OAuthManager>();
	private login: { controller: AbortController; manager: OAuthManager | undefined; done: Promise<RendererResponse> } | undefined;
	private closing = false;
	private localSetup: { controller: AbortController; done: Promise<RendererResponse> } | undefined;

	constructor(private readonly options: Options) {
		this.broker = new CredentialBroker(options.root, new PlaintextSecretProtection(), {
			keyProvider: async () => Buffer.from(options.encryptionKeyBase64, "base64"),
		});
		this.store = new ProviderAccountStore(join(options.root, "provider-accounts.json"), this.broker, options.root);
		this.preferencesPath = join(options.root, "native-runtime-preferences.json");
		this.localRuntime = new NativeLocalRuntime(options.root, options.localFetch);
	}

	private async preferences(): Promise<Preferences> {
		let file;
		try {
			file = await open(this.preferencesPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await file.stat();
			if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16_384)
				throw new Error("Native provider preferences are not a private regular file.");
			const value: unknown = JSON.parse(await file.readFile("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native provider preferences.");
			const subscriptions = (value as { subscriptions?: unknown }).subscriptions;
			const result: Subscriptions = {};
			for (const id of Object.keys(CLI) as CliId[]) {
				const entry = subscriptions && typeof subscriptions === "object" && !Array.isArray(subscriptions) ? (subscriptions as Record<string, unknown>)[id] : undefined;
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const candidate = entry as { enabled?: unknown; path?: unknown };
				if (candidate.enabled === true && typeof candidate.path === "string" && candidate.path.length <= 4096 && isAbsolute(candidate.path))
					result[id] = { enabled: true, path: candidate.path };
			}
			const local = (value as { localModel?: unknown }).localModel;
			let localModel: NativeLocalSelection | undefined;
			if (local && typeof local === "object" && !Array.isArray(local) && "model" in local && "verifiedAt" in local
				&& typeof local.model === "string" && local.model.length <= 200 && /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(local.model)
				&& typeof local.verifiedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(local.verifiedAt) && Number.isFinite(Date.parse(local.verifiedAt)))
				localModel = { model: local.model, verifiedAt: local.verifiedAt };
			return { subscriptions: result, ...(localModel ? { localModel } : {}) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { subscriptions: {} };
			throw new Error("Native provider preferences could not be read. Existing data was preserved.");
		} finally { await file?.close(); }
	}

	private async subscriptions(): Promise<Subscriptions> { return (await this.preferences()).subscriptions; }

	private async writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		await this.writePreferences({ ...await this.preferences(), subscriptions });
	}

	private async writePreferences(preferences: Preferences): Promise<void> {
		const path = `${this.preferencesPath}.${randomUUID()}.new`;
		try {
			const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { await file.writeFile(JSON.stringify({ version: 1, ...preferences }) + "\n"); await file.sync(); }
			finally { await file.close(); }
			await rename(path, this.preferencesPath);
		} finally { await rm(path, { force: true }); }
	}

	private cliPath(id: CliId) {
		return detectNativeSubscriptionCli(id, this.options.homeDirectory, this.options.environment);
	}

	private vendorEnvironment(): NodeJS.ProcessEnv {
		return { ...this.options.environment, HOME: this.options.homeDirectory };
	}

	private oauthManager(options: OAuthOptions): OAuthManager {
		return this.options.createOAuthManager?.(options) ?? new ChatGptOAuthManager(options);
	}

	private async codexStatus(path: string): Promise<ChatGptOAuthStatus> {
		if (this.closing) return { connected: false };
		if (this.statusCache?.path === path && this.statusCache.until > Date.now()) return this.statusCache.value;
		if (this.statusPending?.path === path) return this.statusPending.promise;
		const generation = this.statusGeneration;
		const promise = (this.options.accountStatus
			? this.options.accountStatus(path, this.vendorEnvironment())
			: this.readCodexStatus(path)).catch(() => ({ connected: false }));
		const pending = { path, promise }; this.statusPending = pending;
		try {
			const value = await promise;
			if (generation === this.statusGeneration) this.statusCache = { path, until: Date.now() + 15_000, value };
			return value;
		}
		finally { if (this.statusPending === pending) this.statusPending = undefined; }
	}

	private async readCodexStatus(path: string): Promise<ChatGptOAuthStatus> {
		const manager = this.oauthManager({ executable: path, environment: this.vendorEnvironment(), requestTimeoutMs: 10_000,
			openExternal: async () => { throw new Error("Status checks cannot start sign-in."); },
		});
		this.statusManagers.add(manager);
		try { return await manager.status(AbortSignal.timeout(12_000)); }
		finally {
			await manager.cancel().catch(() => undefined);
			this.statusManagers.delete(manager);
		}
	}

	private invalidateStatus(): void { this.statusGeneration++; this.statusCache = undefined; this.statusPending = undefined; }

	private connect(accountId?: string): Promise<RendererResponse> {
		if (this.closing) return Promise.reject(new Error("The native provider host is shutting down."));
		if (this.login) return Promise.reject(new Error("ChatGPT sign-in is already in progress."));
		const controller = new AbortController();
		// Publish ownership before any async work so two connect requests cannot
		// start children or race the provider reconfiguration guard.
		const login = { controller, manager: undefined as OAuthManager | undefined, done: undefined as unknown as Promise<RendererResponse> };
		this.login = login;
		login.done = this.options.reconfigure(async (): Promise<RendererResponse> => {
			controller.signal.throwIfAborted();
			const account = accountId ? await this.store.account(accountId) : undefined;
			if (accountId && !account) throw new Error("Provider account no longer exists.");
			if (account && (account.adapter !== "codex-app-server" || account.authTransport !== "oauth"))
				throw new Error("This account uses its provider's existing CLI or protected API-key flow.");
			const path = await this.cliPath("codex");
			if (!path) throw new Error("Codex was not found in a trusted local installation path.");
			const environment = { ...this.vendorEnvironment(), ...(account?.profilePath ? { CODEX_HOME: account.profilePath } : {}) };
			if (account?.profilePath) await mkdir(account.profilePath, { recursive: true, mode: 0o700 });
			controller.signal.throwIfAborted();
			login.manager = this.oauthManager({ executable: path, environment, requestTimeoutMs: 10_000,
				openExternal: async raw => {
					controller.signal.throwIfAborted();
					const url = authUrl(raw);
					if (!this.options.openAuthUrl) throw new Error("The native sign-in browser is unavailable.");
					await this.options.openAuthUrl(url, controller.signal);
				},
			});
			try {
				// Enabling an existing provider-owned login must never start a new
				// sign-in, replace the account, or copy its tokens into Kestrel.
				let status = await login.manager.status(controller.signal);
				controller.signal.throwIfAborted();
				if (!(status.connected && status.accountType === "chatgpt")) status = await login.manager.connect(controller.signal);
				controller.signal.throwIfAborted();
				if (!status.connected || status.accountType !== "chatgpt") throw new Error("ChatGPT sign-in did not return a usable account.");
			} catch {
				// Provider diagnostics may contain callback URLs or token-bearing
				// messages; return only this bounded, non-secret failure.
				throw new Error(controller.signal.aborted ? "ChatGPT sign-in was cancelled." : "ChatGPT sign-in could not be completed. Check the provider page and try again.");
			} finally {
				this.invalidateStatus();
				try { await login.manager.cancel(); }
				catch { throw new Error("ChatGPT sign-in cleanup could not be completed. Restart Kestrel before retrying."); }
			}
			controller.signal.throwIfAborted();
			if (accountId) return { ok: true, providerAccounts: await this.store.list() };
			const subscriptions = await this.subscriptions();
			controller.signal.throwIfAborted();
			subscriptions.codex = { enabled: true, path };
			await this.writeSubscriptions(subscriptions);
			return { ok: true, subscriptionClis: await this.subscriptionStatuses() };
		}).finally(() => { if (this.login === login) this.login = undefined; });
		return login.done;
	}

	private async cancelLogin(): Promise<void> {
		const login = this.login;
		if (!login) return;
		login.controller.abort(new Error("ChatGPT sign-in was cancelled."));
		try { await login.manager?.cancel(); } catch { /* The connect result reports a bounded cleanup failure. */ }
		finally { await login.done.catch(() => undefined); }
	}

	/** Wait for the guarded mutation to unwind and restore Core before shutdown. */
	async close(): Promise<void> {
		this.closing = true;
		await Promise.all([this.cancelLogin(), this.cancelLocalSetup(), ...[...this.statusManagers].map(manager => manager.cancel().catch(() => undefined))]);
	}

	private setupLocal(model: string): Promise<RendererResponse> {
		if (this.localSetup) return Promise.reject(new Error("Local model setup is already in progress."));
		const controller = new AbortController();
		const setup = { controller, done: undefined as unknown as Promise<RendererResponse> };
		this.localSetup = setup;
		setup.done = this.options.reconfigure(async (): Promise<RendererResponse> => {
			controller.signal.throwIfAborted();
			const selection = await this.localRuntime.verify(model, controller.signal);
			const preferences = await this.preferences();
			controller.signal.throwIfAborted();
			await this.writePreferences({ ...preferences, localModel: selection });
			return { ok: true, localRuntime: await this.localRuntime.status(selection) };
		}).finally(() => { if (this.localSetup === setup) this.localSetup = undefined; });
		return setup.done;
	}

	private async cancelLocalSetup(): Promise<void> {
		const setup = this.localSetup;
		if (!setup) return;
		setup.controller.abort(new Error("Local model setup was cancelled."));
		await setup.done.catch(() => undefined);
	}

	async subscriptionStatuses(): Promise<SubscriptionCliStatus[]> {
		const preferences = await this.subscriptions();
		return Promise.all((Object.keys(CLI) as CliId[]).map(async id => {
			const path = await this.cliPath(id);
			const enabled = Boolean(path && preferences[id]?.enabled && preferences[id]?.path === path);
			let account: ChatGptOAuthStatus | undefined;
			if (id === "codex" && path) {
				account = await this.codexStatus(path);
			}
			const detail = !path ? `Install the official ${CLI[id].name} CLI to make this route available.`
				: id === "codex" ? `${enabled ? "Enabled. " : ""}${account?.connected
					? "ChatGPT is connected through the official Codex app-server. Codex owns the login and token refresh."
					: "Codex is available. Sign in with ChatGPT in the official Codex app before enabling this route."}`
				: `${enabled ? "Enabled" : "Available"}. Uses the vendor's existing local configuration. Authentication is checked when the route runs.`;
			return { id, label: CLI[id].label, detected: Boolean(path), enabled, detail, ...(path ? { path } : {}),
				...(account ? { authenticated: account.connected, ...(account.accountType ? { accountType: account.accountType } : {}) } : {}),
			};
		}));
	}

	async runtimeConfiguration(): Promise<{ secureEnvironment: NodeJS.ProcessEnv; providerAccounts: ProviderAccountRuntimeConfig[] }> {
		// Never inherit ambient API keys or copy vendor-owned login stores.
		const secureEnvironment = await this.broker.providerEnvironment({});
		await this.store.ensureLegacyAccounts(secureEnvironment);
		const providerAccounts = await this.store.runtimeAccounts(secureEnvironment);
		const allPreferences = await this.preferences();
		const preferences = allPreferences.subscriptions;
		if (allPreferences.localModel) providerAccounts.push({
			id: "native-local-ollama", providerId: "ollama", adapter: "ollama", authTransport: "local", enabled: true,
			displayName: "Local Ollama", baseUrl: "http://127.0.0.1:11434", defaultModel: allPreferences.localModel.model,
		});
		for (const id of Object.keys(CLI) as CliId[]) {
			const path = await this.cliPath(id);
			if (!path || preferences[id]?.path !== path || !preferences[id]?.enabled) continue;
			providerAccounts.push({ id: `native-cli-${id}`, providerId: CLI[id].providerId, adapter: CLI[id].adapter,
				displayName: CLI[id].label, authTransport: id === "codex" ? "oauth" : "cli_profile", enabled: true,
				executable: path, homeDirectory: this.options.homeDirectory,
				...(id === "codex" ? { profilePath: this.options.environment.CODEX_HOME || join(this.options.homeDirectory, ".codex") } : {}),
			});
		}
		// Managed CLI accounts keep isolated vendor profiles. Their executable is
		// still selected by the host, never accepted from account metadata.
		for (const account of providerAccounts) {
			if (account.id.startsWith("native-cli-")) continue;
			const id = (Object.keys(CLI) as CliId[]).find(id => CLI[id].adapter === account.adapter);
			if (!id) continue;
			const executable = await this.cliPath(id);
			account.enabled = Boolean(executable);
			if (executable) { account.executable = executable; account.homeDirectory = this.options.homeDirectory; }
		}
		return { secureEnvironment, providerAccounts };
	}

	async handle(raw: unknown): Promise<RendererResponse> {
		if (this.closing) return { ok: false, error: "The native provider host is shutting down." };
		const parsed = RendererRequestSchema.safeParse(raw);
		if (!parsed.success || !NATIVE_PROVIDER_REQUEST_TYPES.has(parsed.data.type)) return { ok: false, error: "Invalid native provider request." };
		const request = parsed.data;
		switch (request.type) {
			case "local-model-status": {
				// A concurrent status read must not publish ready while guarded
				// setup is still waiting for Core to accept its new configuration.
				const localRuntime = await this.localRuntime.status(this.localSetup ? undefined : (await this.preferences()).localModel);
				return { ok: true, systemProfile: nativeSystemProfile(), ollamaAvailable: localRuntime.ollamaAvailable, localModels: localRuntime.localModels, localRuntime };
			}
			case "local-model-pull": return { ok: false, error: NATIVE_LOCAL_RUNTIME_UNAVAILABLE };
			case "local-runtime-bootstrap": return this.setupLocal(request.model);
			case "local-runtime-cancel": await this.cancelLocalSetup(); return { ok: true };
			case "oauth-chatgpt-connect": return this.connect();
			case "provider-account-connect": return this.connect(request.accountId);
			case "oauth-chatgpt-cancel":
				await this.cancelLogin();
				return { ok: true, subscriptionClis: await this.subscriptionStatuses() };
			case "credential-list": return { ok: true, credentials: await this.broker.listCredentials() };
			case "provider-account-list": return { ok: true, providerAccounts: await this.store.list() };
			case "subscription-cli-status": return { ok: true, subscriptionClis: await this.subscriptionStatuses() };
			case "credential-set":
				return this.options.reconfigure(async () => { await this.broker.setCredential(request.credentialId, request.value); return { ok: true, credentials: await this.broker.listCredentials() }; });
			case "credential-remove":
				return this.options.reconfigure(async () => { await this.broker.removeCredential(request.credentialId); return { ok: true, credentials: await this.broker.listCredentials() }; });
			case "provider-account-create":
				return this.options.reconfigure(async () => ({ ok: true, providerAccounts: await this.store.create(request.account) }));
			case "provider-account-update":
				return this.options.reconfigure(async () => ({ ok: true, providerAccounts: await this.store.update(request.account) }));
			case "provider-account-remove":
				return this.options.reconfigure(async () => ({ ok: true, providerAccounts: await this.store.remove(request.accountId) }));
			case "subscription-cli-set":
				return this.options.reconfigure(async () => {
					const path = await this.cliPath(request.id);
					if (request.enabled && !path) throw new Error("The vendor CLI was not found in a trusted local installation path.");
					const subscriptions = await this.subscriptions();
					if (request.enabled && path) subscriptions[request.id] = { enabled: true, path };
					else delete subscriptions[request.id];
					await this.writeSubscriptions(subscriptions);
					return { ok: true, subscriptionClis: await this.subscriptionStatuses() };
				});
			default: return { ok: false, error: "Invalid native provider request." };
		}
	}
}
