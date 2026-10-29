import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProviderAccountRuntimeConfig } from "@kestrel/agent-core";
import { RendererRequestSchema, type RendererResponse, type SubscriptionCliStatus } from "@kestrel/shared-types";
import { CredentialBroker, PlaintextSecretProtection } from "./credential-broker";
import { ChatGptOAuthManager, type ChatGptOAuthStatus } from "./chatgpt-oauth";
import { ProviderAccountStore } from "./provider-account-store";
import { NATIVE_PROVIDER_REQUEST_TYPES } from "./native-provider-requests";

const CLI = {
	codex: { name: "Codex", label: "ChatGPT plan through Codex", adapter: "codex-app-server", providerId: "codex", env: "KESTREL_CODEX_PATH" },
	claude: { name: "Claude Code", label: "Claude plan through Claude Code", adapter: "claude-cli", providerId: "claude", env: "KESTREL_CLAUDE_PATH" },
	opencode: { name: "OpenCode", label: "OpenCode AI runtime", adapter: "opencode-cli", providerId: "opencode", env: "KESTREL_OPENCODE_PATH" },
	cursor: { name: "Cursor", label: "Cursor account through Cursor Agent", adapter: "cursor-cli", providerId: "cursor", env: "KESTREL_CURSOR_PATH" },
} as const;
type CliId = keyof typeof CLI;
type Subscriptions = Partial<Record<CliId, { enabled: true; path: string }>>;

interface Options {
	root: string;
	encryptionKeyBase64: string;
	/** Original host home, not the private Agent Core HOME. */
	homeDirectory: string;
	environment: NodeJS.ProcessEnv;
	reconfigure<T>(mutation: () => Promise<T>): Promise<T>;
	/** Account metadata only; injectable for deterministic tests. */
	accountStatus?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<ChatGptOAuthStatus>;
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
	private statusCache: { path: string; until: number; value: ChatGptOAuthStatus } | undefined;
	private statusPending: { path: string; promise: Promise<ChatGptOAuthStatus> } | undefined;

	constructor(private readonly options: Options) {
		this.broker = new CredentialBroker(options.root, new PlaintextSecretProtection(), {
			keyProvider: async () => Buffer.from(options.encryptionKeyBase64, "base64"),
		});
		this.store = new ProviderAccountStore(join(options.root, "provider-accounts.json"), this.broker, options.root);
		this.preferencesPath = join(options.root, "native-runtime-preferences.json");
	}

	private async subscriptions(): Promise<Subscriptions> {
		let file;
		try {
			file = await open(this.preferencesPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await file.stat();
			if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16_384)
				throw new Error("Native provider preferences are not a private regular file.");
			const value: unknown = JSON.parse(await file.readFile("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native provider preferences.");
			const subscriptions = (value as { subscriptions?: unknown }).subscriptions;
			if (!subscriptions || typeof subscriptions !== "object" || Array.isArray(subscriptions)) return {};
			const result: Subscriptions = {};
			for (const id of Object.keys(CLI) as CliId[]) {
				const entry = (subscriptions as Record<string, unknown>)[id];
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const candidate = entry as { enabled?: unknown; path?: unknown };
				if (candidate.enabled === true && typeof candidate.path === "string" && candidate.path.length <= 4096 && isAbsolute(candidate.path))
					result[id] = { enabled: true, path: candidate.path };
			}
			return result;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error("Native provider preferences could not be read. Existing data was preserved.");
		} finally { await file?.close(); }
	}

	private async writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		const path = `${this.preferencesPath}.${randomUUID()}.new`;
		try {
			const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { await file.writeFile(JSON.stringify({ version: 1, subscriptions }) + "\n"); await file.sync(); }
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

	private async codexStatus(path: string): Promise<ChatGptOAuthStatus> {
		if (this.statusCache?.path === path && this.statusCache.until > Date.now()) return this.statusCache.value;
		if (this.statusPending?.path === path) return this.statusPending.promise;
		const promise = (this.options.accountStatus
			? this.options.accountStatus(path, this.vendorEnvironment())
			: new ChatGptOAuthManager({ executable: path, environment: this.vendorEnvironment(), requestTimeoutMs: 10_000,
				openExternal: async () => { throw new Error("Status checks cannot start sign-in."); },
			}).status(AbortSignal.timeout(12_000))).catch(() => ({ connected: false }));
		const pending = { path, promise }; this.statusPending = pending;
		try { const value = await promise; this.statusCache = { path, until: Date.now() + 15_000, value }; return value; }
		finally { if (this.statusPending === pending) this.statusPending = undefined; }
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
		const preferences = await this.subscriptions();
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
		const parsed = RendererRequestSchema.safeParse(raw);
		if (!parsed.success || !NATIVE_PROVIDER_REQUEST_TYPES.has(parsed.data.type)) return { ok: false, error: "Invalid native provider request." };
		const request = parsed.data;
		switch (request.type) {
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
