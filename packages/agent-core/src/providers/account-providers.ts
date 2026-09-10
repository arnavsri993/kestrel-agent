import { AnthropicMessagesProvider } from "./anthropic-messages";
import { CodexAppServerProvider } from "./codex-app-server";
import { CursorSubscriptionProvider } from "./cursor-cli";
import { GeminiGenerateContentProvider } from "./gemini-generate-content";
import { OllamaChatProvider } from "./ollama-chat";
import { OpenAIChatCompletionsProvider } from "./openai-chat-completions";
import { OpenAIResponsesProvider } from "./openai-responses";
import {
	ClaudeSubscriptionProvider,
	OpenCodeSubscriptionProvider,
} from "./subscription-cli";
import type {
	ModelProvider,
	ProviderAccountIdentity,
} from "./types";

/**
 * This message crosses the desktop main → isolated utility-process boundary.
 * It is intentionally runtime-only: callers must persist only the non-secret
 * fields in this shape and resolve `apiKey`/`headers` from protected storage
 * immediately before bootstrap.
 */
export interface ProviderAccountRuntimeConfig {
	id: string;
	providerId: string;
	adapter:
		| "openai-responses"
		| "anthropic-messages"
		| "gemini-generate-content"
		| "openai-compatible"
		| "ollama"
		| "codex-app-server"
		| "opencode-cli"
		| "claude-cli"
		| "cursor-cli";
	displayName: string;
	authTransport: "api_key" | "oauth" | "cli_profile" | "local";
	enabled: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
	baseUrl?: string;
	organization?: string;
	project?: string;
	defaultModel?: string;
	executable?: string;
	profilePath?: string;
	contextWindow?: number;
	/** Non-secret metadata revision for catalog invalidation. */
	configurationVersion?: string;
}

function accountIdentity(
	account: ProviderAccountRuntimeConfig,
): ProviderAccountIdentity {
	return {
		id: account.id,
		providerId: account.providerId,
		displayName: account.displayName,
		authTransport: account.authTransport,
		enabled: account.enabled,
		...(account.configurationVersion
			? { configurationVersion: account.configurationVersion }
			: {}),
	};
}

/**
 * Preserve adapter behavior while giving it the stable account endpoint and
 * logical provider identity used by routing. The wrapped provider still owns
 * its HTTP/CLI process and receives no renderer-facing account metadata.
 */
function attachAccount(
	provider: ModelProvider,
	account: ProviderAccountRuntimeConfig,
): ModelProvider {
	return {
		id: provider.id,
		poolId: account.providerId,
		account: accountIdentity(account),
		...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
		capabilities: provider.capabilities,
		...(provider.profileHints ? { profileHints: provider.profileHints } : {}),
		...(provider.probe ? { probe: provider.probe.bind(provider) } : {}),
		...(provider.discoverModels
			? { discoverModels: provider.discoverModels.bind(provider) }
			: {}),
		complete: provider.complete.bind(provider),
		...(provider.close ? { close: provider.close.bind(provider) } : {}),
	};
}

function requireApiKey(account: ProviderAccountRuntimeConfig): string {
	if (!account.apiKey)
		throw new Error(
			`${account.displayName} is missing its protected API credential.`,
		);
	return account.apiKey;
}

function isLoopbackOpenAICompatibleBaseUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		const hostname = parsed.hostname;
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			(hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname === "::1" ||
				hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

function accountEnvironment(
	account: ProviderAccountRuntimeConfig,
	key: "CODEX_HOME",
): NodeJS.ProcessEnv {
	return {
		...process.env,
		...(account.profilePath ? { [key]: account.profilePath } : {}),
	};
}

/**
 * Creates one adapter per enabled account. There is no provider-global model
 * list here: defaults are adapter fallbacks and are surfaced as such by the
 * model catalog until supported discovery reports a real result.
 */
export function createAccountModelProviders(
	accounts: readonly ProviderAccountRuntimeConfig[],
): ModelProvider[] {
	const providers: ModelProvider[] = [];
	for (const account of accounts) {
		if (!account.enabled) continue;
		let provider: ModelProvider;
		switch (account.adapter) {
			case "openai-responses":
				provider = new OpenAIResponsesProvider({
					id: account.id,
					apiKey: requireApiKey(account),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
					...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
					...(account.organization
						? { organization: account.organization }
						: {}),
					...(account.project ? { project: account.project } : {}),
					...(account.headers ? { headers: account.headers } : {}),
				});
				break;
			case "anthropic-messages":
				provider = new AnthropicMessagesProvider({
					id: account.id,
					apiKey: requireApiKey(account),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
					...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
					...(account.headers ? { headers: account.headers } : {}),
				});
				break;
			case "gemini-generate-content":
				provider = new GeminiGenerateContentProvider({
					id: account.id,
					apiKey: requireApiKey(account),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
					...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
					...(account.headers ? { headers: account.headers } : {}),
				});
				break;
			case "openai-compatible":
				if (!account.baseUrl)
					throw new Error(
						`${account.displayName} needs an OpenAI-compatible base URL.`,
					);
				if (
					account.authTransport === "local" &&
					!isLoopbackOpenAICompatibleBaseUrl(account.baseUrl)
				)
					throw new Error(
						`${account.displayName} needs a loopback base URL for no-auth local access.`,
					);
				if (
					account.authTransport !== "api_key" &&
					account.authTransport !== "local"
				)
					throw new Error(
						`${account.displayName} has an unsupported OpenAI-compatible authentication transport.`,
					);
				provider = new OpenAIChatCompletionsProvider({
					id: account.id,
					...(account.authTransport === "api_key"
						? { apiKey: requireApiKey(account) }
						: { local: true }),
					defaultModel: account.defaultModel ?? "default",
					baseUrl: account.baseUrl,
					...(account.headers ? { headers: account.headers } : {}),
				});
				break;
			case "ollama":
				provider = new OllamaChatProvider({
					id: account.id,
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
					...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
					...(account.headers ? { headers: account.headers } : {}),
					...(account.contextWindow
						? { contextWindow: account.contextWindow }
						: {}),
				});
				break;
			case "codex-app-server":
				provider = new CodexAppServerProvider({
					id: account.id,
					poolId: account.providerId,
					...(account.executable ? { executable: account.executable } : {}),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
					environment: accountEnvironment(account, "CODEX_HOME"),
				});
				break;
			case "opencode-cli":
				provider = new OpenCodeSubscriptionProvider({
					id: account.id,
					poolId: account.providerId,
					...(account.executable ? { executable: account.executable } : {}),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
				});
				break;
			case "claude-cli":
				provider = new ClaudeSubscriptionProvider({
					id: account.id,
					poolId: account.providerId,
					...(account.executable ? { executable: account.executable } : {}),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
				});
				break;
			case "cursor-cli":
				provider = new CursorSubscriptionProvider({
					id: account.id,
					poolId: account.providerId,
					...(account.executable ? { executable: account.executable } : {}),
					...(account.defaultModel
						? { defaultModel: account.defaultModel }
						: {}),
				});
				break;
		}
		providers.push(attachAccount(provider, account));
	}
	return providers;
}
