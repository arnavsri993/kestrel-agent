import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ProviderAccountSummarySchema,
	type ProviderAccountAdapter,
	type ProviderAccountAuthTransport,
	type ProviderAccountInput,
	type ProviderAccountSummary,
	type ProviderAccountUpdate,
} from "@kestrel/shared-types";
import type { ProviderAccountRuntimeConfig } from "@kestrel/agent-core";
import { CredentialBroker } from "./credential-broker";

const STORE_VERSION = 3;
const ACCOUNT_SECRET_PREFIX = "provider-account-";
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/;

type StoredProviderAccount = {
	id: string;
	providerId: string;
	adapter: ProviderAccountAdapter;
	displayName: string;
	authTransport: ProviderAccountAuthTransport;
	enabled: boolean;
	baseUrl?: string | undefined;
	organization?: string | undefined;
	project?: string | undefined;
	defaultModel?: string | undefined;
	profilePath?: string | undefined;
	executable?: string | undefined;
	contextWindow?: number | undefined;
	/** Points at a brokered legacy credential without duplicating it. */
	legacyEnvironmentKey?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

type StoredProviderAccountFile = {
	version: number;
	accounts: StoredProviderAccount[];
	/**
	 * A removal is an explicit disconnect. Keep a non-secret tombstone so a
	 * still-present legacy environment variable cannot recreate that account at
	 * the next desktop launch.
	 */
	retiredLegacyAccountIds: string[];
};

type SecretEnvelope = {
	apiKey?: string | undefined;
	headers?: Record<string, string> | undefined;
};

type LegacyDefinition = {
	id: string;
	providerId: string;
	adapter: ProviderAccountAdapter;
	displayName: string;
	authTransport: ProviderAccountAuthTransport;
	credentialKey?: string;
	modelKey?: string;
	baseUrlKey?: string;
	organizationKey?: string;
	projectKey?: string;
	defaultModel?: string;
};

const LEGACY_COMPATIBLE_BASE_URLS: Readonly<Record<string, string>> = {
	nous: "https://inference-api.nousresearch.com/v1",
	groq: "https://api.groq.com/openai/v1",
	mistral: "https://api.mistral.ai/v1",
	openrouter: "https://openrouter.ai/api/v1",
	xai: "https://api.x.ai/v1",
	deepseek: "https://api.deepseek.com/v1",
	together: "https://api.together.xyz/v1",
	fireworks: "https://api.fireworks.ai/inference/v1",
	nvidia: "https://integrate.api.nvidia.com/v1",
	huggingface: "https://router.huggingface.co/v1",
	perplexity: "https://api.perplexity.ai",
	"github-models": "https://models.github.ai/inference",
	cohere: "https://api.cohere.ai/compatibility/v1",
	tokenrouter: "https://api.tokenrouter.com/v1",
	bai: "https://api.b.ai/v1",
	inferx: "https://model.inferx.net/endpoints/v1",
	zenmux: "https://zenmux.ai/api/v1",
	"opencode-zen": "https://opencode.ai/zen/v1",
	sensenova: "https://token.sensenova.cn/v1",
	gmicloud: "https://api.gmi-serving.com/v1",
	tokenharbor: "https://tokenharbor.ai/v1",
	cline: "https://api.cline.bot/api/v1",
	"command-code": "https://api.commandcode.ai/provider/v1",
	kilo: "https://api.kilo.ai/api/gateway",
	orcarouter: "https://api.orcarouter.ai/v1",
	aihubmix: "https://aihubmix.com/v1",
};

function legacyBaseUrl(
	definition: LegacyDefinition,
	environment: NodeJS.ProcessEnv,
): string | undefined {
	if (definition.providerId === "cloudflare") {
		const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
		return accountId
			? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`
			: undefined;
	}
	return (
		(definition.baseUrlKey ? environment[definition.baseUrlKey] : undefined) ??
		LEGACY_COMPATIBLE_BASE_URLS[definition.providerId]
	);
}

const LEGACY_API_DEFINITIONS: readonly LegacyDefinition[] = [
	{
		id: "legacy-openai-primary",
		providerId: "openai",
		adapter: "openai-responses",
		displayName: "OpenAI API",
		authTransport: "api_key",
		credentialKey: "OPENAI_API_KEY",
		modelKey: "OPENAI_MODEL",
		baseUrlKey: "OPENAI_BASE_URL",
		organizationKey: "OPENAI_ORGANIZATION",
		projectKey: "OPENAI_PROJECT",
		defaultModel: "gpt-5.6-terra",
	},
	{
		id: "legacy-openai-secondary",
		providerId: "openai",
		adapter: "openai-responses",
		displayName: "OpenAI API backup",
		authTransport: "api_key",
		credentialKey: "OPENAI_API_KEY_SECONDARY",
		modelKey: "OPENAI_MODEL",
		baseUrlKey: "OPENAI_BASE_URL",
		organizationKey: "OPENAI_ORGANIZATION",
		projectKey: "OPENAI_PROJECT",
		defaultModel: "gpt-5.6-terra",
	},
	{
		id: "legacy-anthropic-primary",
		providerId: "anthropic",
		adapter: "anthropic-messages",
		displayName: "Anthropic API",
		authTransport: "api_key",
		credentialKey: "ANTHROPIC_API_KEY",
		modelKey: "ANTHROPIC_MODEL",
		baseUrlKey: "ANTHROPIC_BASE_URL",
	},
	{
		id: "legacy-anthropic-secondary",
		providerId: "anthropic",
		adapter: "anthropic-messages",
		displayName: "Anthropic API backup",
		authTransport: "api_key",
		credentialKey: "ANTHROPIC_API_KEY_SECONDARY",
		modelKey: "ANTHROPIC_MODEL",
		baseUrlKey: "ANTHROPIC_BASE_URL",
	},
	{
		id: "legacy-gemini",
		providerId: "gemini",
		adapter: "gemini-generate-content",
		displayName: "Google Gemini API",
		authTransport: "api_key",
		credentialKey: "GEMINI_API_KEY",
		modelKey: "GEMINI_MODEL",
		baseUrlKey: "GEMINI_BASE_URL",
		defaultModel: "gemini-3.6-flash",
	},
	{
		id: "legacy-nous",
		providerId: "nous",
		adapter: "openai-compatible",
		displayName: "Nous Portal",
		authTransport: "api_key",
		credentialKey: "NOUS_API_KEY",
		modelKey: "NOUS_MODEL",
		baseUrlKey: "NOUS_BASE_URL",
		defaultModel: "stepfun/step-3.7-flash:free",
	},
	{
		id: "legacy-groq",
		providerId: "groq",
		adapter: "openai-compatible",
		displayName: "Groq",
		authTransport: "api_key",
		credentialKey: "GROQ_API_KEY",
		modelKey: "GROQ_MODEL",
		baseUrlKey: "GROQ_BASE_URL",
		defaultModel: "openai/gpt-oss-20b",
	},
	{
		id: "legacy-mistral",
		providerId: "mistral",
		adapter: "openai-compatible",
		displayName: "Mistral",
		authTransport: "api_key",
		credentialKey: "MISTRAL_API_KEY",
		modelKey: "MISTRAL_MODEL",
		baseUrlKey: "MISTRAL_BASE_URL",
		defaultModel: "mistral-small-latest",
	},
	{
		id: "legacy-openrouter",
		providerId: "openrouter",
		adapter: "openai-compatible",
		displayName: "OpenRouter",
		authTransport: "api_key",
		credentialKey: "OPENROUTER_API_KEY",
		modelKey: "OPENROUTER_MODEL",
		baseUrlKey: "OPENROUTER_BASE_URL",
		defaultModel: "openrouter/free",
	},
	{
		id: "legacy-cloudflare",
		providerId: "cloudflare",
		adapter: "openai-compatible",
		displayName: "Cloudflare Workers AI",
		authTransport: "api_key",
		credentialKey: "CLOUDFLARE_API_KEY",
		modelKey: "CLOUDFLARE_MODEL",
		baseUrlKey: "CLOUDFLARE_BASE_URL",
		defaultModel: "@cf/openai/gpt-oss-20b",
	},
	{
		id: "legacy-xai",
		providerId: "xai",
		adapter: "openai-compatible",
		displayName: "xAI",
		authTransport: "api_key",
		credentialKey: "XAI_API_KEY",
		modelKey: "XAI_MODEL",
		baseUrlKey: "XAI_BASE_URL",
		defaultModel: "grok-3-mini",
	},
	{
		id: "legacy-deepseek",
		providerId: "deepseek",
		adapter: "openai-compatible",
		displayName: "DeepSeek",
		authTransport: "api_key",
		credentialKey: "DEEPSEEK_API_KEY",
		modelKey: "DEEPSEEK_MODEL",
		baseUrlKey: "DEEPSEEK_BASE_URL",
		defaultModel: "deepseek-chat",
	},
	{
		id: "legacy-together",
		providerId: "together",
		adapter: "openai-compatible",
		displayName: "Together AI",
		authTransport: "api_key",
		credentialKey: "TOGETHER_API_KEY",
		modelKey: "TOGETHER_MODEL",
		baseUrlKey: "TOGETHER_BASE_URL",
		defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
	},
	{
		id: "legacy-fireworks",
		providerId: "fireworks",
		adapter: "openai-compatible",
		displayName: "Fireworks AI",
		authTransport: "api_key",
		credentialKey: "FIREWORKS_API_KEY",
		modelKey: "FIREWORKS_MODEL",
		baseUrlKey: "FIREWORKS_BASE_URL",
		defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
	},
	{
		id: "legacy-nvidia",
		providerId: "nvidia",
		adapter: "openai-compatible",
		displayName: "NVIDIA NIM",
		authTransport: "api_key",
		credentialKey: "NVIDIA_API_KEY",
		modelKey: "NVIDIA_MODEL",
		baseUrlKey: "NVIDIA_BASE_URL",
		defaultModel: "meta/llama-3.3-70b-instruct",
	},
	{
		id: "legacy-huggingface",
		providerId: "huggingface",
		adapter: "openai-compatible",
		displayName: "Hugging Face",
		authTransport: "api_key",
		credentialKey: "HUGGINGFACE_API_KEY",
		modelKey: "HUGGINGFACE_MODEL",
		baseUrlKey: "HUGGINGFACE_BASE_URL",
		defaultModel: "openai/gpt-oss-120b:cerebras",
	},
	{
		id: "legacy-perplexity",
		providerId: "perplexity",
		adapter: "openai-compatible",
		displayName: "Perplexity",
		authTransport: "api_key",
		credentialKey: "PERPLEXITY_API_KEY",
		modelKey: "PERPLEXITY_MODEL",
		baseUrlKey: "PERPLEXITY_BASE_URL",
		defaultModel: "sonar",
	},
	{
		id: "legacy-github-models",
		providerId: "github-models",
		adapter: "openai-compatible",
		displayName: "GitHub Models",
		authTransport: "api_key",
		credentialKey: "GITHUB_MODELS_TOKEN",
		modelKey: "GITHUB_MODELS_MODEL",
		baseUrlKey: "GITHUB_MODELS_BASE_URL",
		defaultModel: "openai/gpt-4.1-mini",
	},
	{
		id: "legacy-cohere",
		providerId: "cohere",
		adapter: "openai-compatible",
		displayName: "Cohere",
		authTransport: "api_key",
		credentialKey: "COHERE_API_KEY",
		modelKey: "COHERE_MODEL",
		baseUrlKey: "COHERE_BASE_URL",
		defaultModel: "command-a-plus-05-2026",
	},
	{
		id: "legacy-tokenrouter",
		providerId: "tokenrouter",
		adapter: "openai-compatible",
		displayName: "TokenRouter",
		authTransport: "api_key",
		credentialKey: "TOKENROUTER_API_KEY",
		modelKey: "TOKENROUTER_MODEL",
		baseUrlKey: "TOKENROUTER_BASE_URL",
		defaultModel: "qwen/qwen3.8-max-free",
	},
	{
		id: "legacy-bai",
		providerId: "bai",
		adapter: "openai-compatible",
		displayName: "B.AI",
		authTransport: "api_key",
		credentialKey: "BAI_API_KEY",
		modelKey: "BAI_MODEL",
		baseUrlKey: "BAI_BASE_URL",
		defaultModel: "deepseek-v4-flash",
	},
	{
		id: "legacy-inferx",
		providerId: "inferx",
		adapter: "openai-compatible",
		displayName: "InferX",
		authTransport: "api_key",
		credentialKey: "INFERX_API_KEY",
		modelKey: "INFERX_MODEL",
		baseUrlKey: "INFERX_BASE_URL",
		defaultModel: "deepseek-v4-flash",
	},
	{
		id: "legacy-zenmux",
		providerId: "zenmux",
		adapter: "openai-compatible",
		displayName: "ZenMux",
		authTransport: "api_key",
		credentialKey: "ZENMUX_API_KEY",
		modelKey: "ZENMUX_MODEL",
		baseUrlKey: "ZENMUX_BASE_URL",
		defaultModel: "z-ai/glm-4.7-flash-free",
	},
	{
		id: "legacy-opencode-zen",
		providerId: "opencode-zen",
		adapter: "openai-compatible",
		displayName: "OpenCode Zen",
		authTransport: "api_key",
		credentialKey: "OPENCODE_API_KEY",
		modelKey: "OPENCODE_MODEL",
		baseUrlKey: "OPENCODE_BASE_URL",
		defaultModel: "mimo-v2.5-free",
	},
	{
		id: "legacy-sensenova",
		providerId: "sensenova",
		adapter: "openai-compatible",
		displayName: "SenseNova",
		authTransport: "api_key",
		credentialKey: "SENSENOVA_API_KEY",
		modelKey: "SENSENOVA_MODEL",
		baseUrlKey: "SENSENOVA_BASE_URL",
		defaultModel: "deepseek-v4-flash",
	},
	{
		id: "legacy-gmicloud",
		providerId: "gmicloud",
		adapter: "openai-compatible",
		displayName: "GMI Cloud",
		authTransport: "api_key",
		credentialKey: "GMICLOUD_API_KEY",
		modelKey: "GMICLOUD_MODEL",
		baseUrlKey: "GMICLOUD_BASE_URL",
		defaultModel: "deepseek-ai/DeepSeek-V4-Pro",
	},
	{
		id: "legacy-tokenharbor",
		providerId: "tokenharbor",
		adapter: "openai-compatible",
		displayName: "Token Harbor",
		authTransport: "api_key",
		credentialKey: "TOKENHARBOR_API_KEY",
		modelKey: "TOKENHARBOR_MODEL",
		baseUrlKey: "TOKENHARBOR_BASE_URL",
		defaultModel: "deepseek-v4-flash:free",
	},
	{
		id: "legacy-cline",
		providerId: "cline",
		adapter: "openai-compatible",
		displayName: "Cline",
		authTransport: "api_key",
		credentialKey: "CLINE_API_KEY",
		modelKey: "CLINE_MODEL",
		baseUrlKey: "CLINE_BASE_URL",
		defaultModel: "poolside/laguna-s-2.1:free",
	},
	{
		id: "legacy-command-code",
		providerId: "command-code",
		adapter: "openai-compatible",
		displayName: "Command Code",
		authTransport: "api_key",
		credentialKey: "COMMAND_CODE_API_KEY",
		modelKey: "COMMAND_CODE_MODEL",
		baseUrlKey: "COMMAND_CODE_BASE_URL",
		defaultModel: "poolside/laguna-s-2.1-free",
	},
	{
		id: "legacy-kilo",
		providerId: "kilo",
		adapter: "openai-compatible",
		displayName: "Kilo",
		authTransport: "api_key",
		credentialKey: "KILO_API_KEY",
		modelKey: "KILO_MODEL",
		baseUrlKey: "KILO_BASE_URL",
		defaultModel: "kilo-auto/free",
	},
	{
		id: "legacy-orcarouter",
		providerId: "orcarouter",
		adapter: "openai-compatible",
		displayName: "OrcaRouter",
		authTransport: "api_key",
		credentialKey: "ORCAROUTER_API_KEY",
		modelKey: "ORCAROUTER_MODEL",
		baseUrlKey: "ORCAROUTER_BASE_URL",
		defaultModel: "orcarouter/free",
	},
	{
		id: "legacy-aihubmix",
		providerId: "aihubmix",
		adapter: "openai-compatible",
		displayName: "AIHubMix",
		authTransport: "api_key",
		credentialKey: "AIHUBMIX_API_KEY",
		modelKey: "AIHUBMIX_MODEL",
		baseUrlKey: "AIHUBMIX_BASE_URL",
		defaultModel: "xiaomi-mimo-v2.5-free",
	},
] as const;

function secretId(accountId: string): string {
	const id = `${ACCOUNT_SECRET_PREFIX}${accountId}`;
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(id))
		throw new Error("Provider account ID is invalid.");
	return id;
}

function sanitizeOptional(value: string | undefined, maximum: number): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed.slice(0, maximum) : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

function isLoopbackBaseUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const parsed = new URL(value);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			isLoopbackHostname(parsed.hostname)
		);
	} catch {
		return false;
	}
}

function normalizeBaseUrl(
	value: string | undefined,
	_adapter: ProviderAccountAdapter,
): string | undefined {
	const raw = sanitizeOptional(value, 2_000);
	if (!raw) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Provider base URL is invalid.");
	}
	if (parsed.username || parsed.password || parsed.hash || parsed.search)
		throw new Error(
			"Provider base URL must not contain credentials, a query, or a fragment.",
		);
	const local = isLoopbackHostname(parsed.hostname);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))
		throw new Error("Provider base URLs must use HTTPS, except loopback local runtimes.");
	return parsed.toString().replace(/\/$/, "");
}

function normalizeStoredBaseUrl(
	value: string | undefined,
	adapter: ProviderAccountAdapter,
): string | undefined {
	try {
		return normalizeBaseUrl(value, adapter);
	} catch {
		return undefined;
	}
}

function headersFrom(
	headers: ProviderAccountInput["headers"] | ProviderAccountUpdate["headers"],
): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	const result: Record<string, string> = {};
	for (const header of headers) {
		const name = header.name.trim();
		const value = header.value.trim();
		if (!HEADER_NAME.test(name) || !value || /[\r\n\0]/.test(value))
			throw new Error("Provider header is invalid.");
		result[name] = value;
	}
	return Object.keys(result).length ? result : undefined;
}

function adapterCapabilities(
	adapter: ProviderAccountAdapter,
	authTransport: ProviderAccountAuthTransport,
) {
	switch (adapter) {
		case "openai-responses":
			return {
				streaming: true,
				tools: true,
				images: true,
				audio: true,
				documents: true,
				local: false,
			};
		case "anthropic-messages":
			return {
				streaming: true,
				tools: true,
				images: true,
				audio: false,
				documents: true,
				local: false,
			};
		case "gemini-generate-content":
			return {
				streaming: false,
				tools: true,
				images: true,
				audio: true,
				documents: true,
				video: true,
				local: false,
			};
		case "ollama":
			return {
				streaming: true,
				tools: true,
				images: true,
				audio: false,
				documents: false,
				local: true,
			};
		case "openai-compatible":
			return {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: authTransport === "local",
			};
		default:
			return {
				streaming: true,
				tools: false,
				images: false,
				audio: false,
				documents: false,
				video: false,
				local: false,
			};
	}
}

function accountSummary(account: StoredProviderAccount): ProviderAccountSummary {
	return ProviderAccountSummarySchema.parse({
		id: account.id,
		endpointId: account.id,
		providerId: account.providerId,
		displayName: account.displayName,
		authTransport: account.authTransport,
		enabled: account.enabled,
		capabilities: adapterCapabilities(account.adapter, account.authTransport),
		discovery: { state: "idle" },
		models: [],
	});
}

function isLegacyAccountId(value: string): boolean {
	return /^legacy-[a-z0-9-]{1,90}$/.test(value);
}

function parseStore(value: unknown): StoredProviderAccountFile {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { version: STORE_VERSION, accounts: [], retiredLegacyAccountIds: [] };
	const raw = value as {
		version?: unknown;
		accounts?: unknown;
		retiredLegacyAccountIds?: unknown;
	};
	if (!Array.isArray(raw.accounts))
		return { version: STORE_VERSION, accounts: [], retiredLegacyAccountIds: [] };
	const accounts = raw.accounts.flatMap((candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			return [];
		const account = candidate as Partial<StoredProviderAccount>;
		if (
			typeof account.id !== "string" ||
			typeof account.providerId !== "string" ||
			typeof account.adapter !== "string" ||
			typeof account.displayName !== "string" ||
			typeof account.authTransport !== "string" ||
			typeof account.enabled !== "boolean" ||
			typeof account.createdAt !== "string" ||
			typeof account.updatedAt !== "string"
		)
			return [];
		const providerId = sanitizeOptional(account.providerId, 80)?.toLowerCase();
		const displayName = sanitizeOptional(account.displayName, 200);
		const validNonLegacyId = /^[a-z][a-z0-9-]{0,46}$/.test(account.id);
		if (
			(!validNonLegacyId && !isLegacyAccountId(account.id)) ||
			!providerId ||
			!/^[a-z][a-z0-9-]{0,79}$/.test(providerId) ||
			!displayName ||
			!Number.isFinite(Date.parse(account.createdAt)) ||
			!Number.isFinite(Date.parse(account.updatedAt))
		)
			return [];
		const parsed = ProviderAccountSummarySchema.shape.authTransport.safeParse(
			account.authTransport,
		);
		const adapter = [
			"openai-responses",
			"anthropic-messages",
			"gemini-generate-content",
			"openai-compatible",
			"ollama",
			"codex-app-server",
			"opencode-cli",
			"claude-cli",
			"cursor-cli",
		].includes(account.adapter)
			? (account.adapter as ProviderAccountAdapter)
			: undefined;
		if (!parsed.success || !adapter) return [];
		const rawBaseUrl = sanitizeOptional(account.baseUrl, 2_000);
		const baseUrl = rawBaseUrl
			? normalizeStoredBaseUrl(rawBaseUrl, adapter)
			: undefined;
		if (rawBaseUrl && !baseUrl) return [];
		if (adapter === "openai-compatible" && !baseUrl) return [];
		if (!supportsTransport(adapter, parsed.data, baseUrl)) return [];
		return [
			{
				id: account.id,
				providerId,
				adapter,
				displayName,
				authTransport: parsed.data,
				enabled: account.enabled,
				...(baseUrl ? { baseUrl } : {}),
				...(sanitizeOptional(account.organization, 300)
					? { organization: sanitizeOptional(account.organization, 300) }
					: {}),
				...(sanitizeOptional(account.project, 300)
					? { project: sanitizeOptional(account.project, 300) }
					: {}),
				...(sanitizeOptional(account.defaultModel, 200)
					? { defaultModel: sanitizeOptional(account.defaultModel, 200) }
					: {}),
				...(sanitizeOptional(account.profilePath, 2_000)
					? { profilePath: sanitizeOptional(account.profilePath, 2_000) }
					: {}),
				...(sanitizeOptional(account.executable, 2_000)
					? { executable: sanitizeOptional(account.executable, 2_000) }
					: {}),
				...(typeof account.contextWindow === "number" &&
					Number.isInteger(account.contextWindow) &&
					account.contextWindow > 0
					? { contextWindow: account.contextWindow }
					: {}),
				...(sanitizeOptional(account.legacyEnvironmentKey, 120)
					? { legacyEnvironmentKey: sanitizeOptional(account.legacyEnvironmentKey, 120) }
					: {}),
				createdAt: account.createdAt,
				updatedAt: account.updatedAt,
			},
		];
	});
	const retiredLegacyAccountIds = [
		...new Set(
			(Array.isArray(raw.retiredLegacyAccountIds)
				? raw.retiredLegacyAccountIds
				: []
			).flatMap((value) =>
				typeof value === "string" && isLegacyAccountId(value) ? [value] : [],
			),
		),
	];
	return { version: STORE_VERSION, accounts, retiredLegacyAccountIds };
}

function supportsTransport(
	adapter: ProviderAccountAdapter,
	authTransport: ProviderAccountAuthTransport,
	baseUrl?: string,
): boolean {
	if (adapter === "openai-compatible")
		return (
			authTransport === "api_key" ||
			(authTransport === "local" && isLoopbackBaseUrl(baseUrl))
		);
	const expected: Partial<Record<ProviderAccountAdapter, ProviderAccountAuthTransport>> = {
		"openai-responses": "api_key",
		"anthropic-messages": "api_key",
		"gemini-generate-content": "api_key",
		ollama: "local",
		"codex-app-server": "oauth",
		"opencode-cli": "cli_profile",
		"claude-cli": "cli_profile",
		"cursor-cli": "cli_profile",
	};
	return expected[adapter] === authTransport;
}

function assertTransport(input: ProviderAccountInput): void {
	if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.providerId))
		throw new Error("Provider ID is invalid.");
	if (!input.displayName.trim()) throw new Error("Account label is required.");
	if (input.adapter === "openai-compatible" && !input.baseUrl)
		throw new Error("An OpenAI-compatible account needs a base URL.");
	if (
		input.adapter === "openai-compatible" &&
		input.authTransport === "local" &&
		!isLoopbackBaseUrl(input.baseUrl)
	)
		throw new Error(
			"A no-auth OpenAI-compatible account must use a loopback local base URL.",
		);
	if (!supportsTransport(input.adapter, input.authTransport, input.baseUrl))
		throw new Error("That authentication transport is not supported by this adapter.");
	if (
		input.authTransport === "api_key" &&
		(!input.apiKey || input.apiKey.trim().length < 8)
	)
		throw new Error("Enter an API key in Kestrel's protected field.");
	if (input.authTransport === "cli_profile")
		throw new Error(
			"Kestrel can use a detected existing CLI profile, but this CLI does not expose a supported isolated-profile connection flow.",
		);
}

function assertStoredAccountConfiguration(account: StoredProviderAccount): void {
	if (account.adapter === "openai-compatible" && !account.baseUrl)
		throw new Error("An OpenAI-compatible account needs a base URL.");
	if (!supportsTransport(account.adapter, account.authTransport, account.baseUrl))
		throw new Error("That authentication transport is not supported by this adapter.");
}

export class ProviderAccountStore {
	constructor(
		private readonly path: string,
		private readonly broker: CredentialBroker,
		private readonly userDataPath: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	async list(): Promise<ProviderAccountSummary[]> {
		return (await this.load()).accounts.map(accountSummary);
	}

	async account(accountId: string): Promise<StoredProviderAccount | undefined> {
		return (await this.load()).accounts.find((account) => account.id === accountId);
	}

	/**
	 * Imports legacy configured routes as metadata-only account records. The
	 * brokered credential remains in its original encrypted slot; no token is
	 * copied, moved, or written to the account file.
	 */
	async ensureLegacyAccounts(environment: NodeJS.ProcessEnv): Promise<void> {
		const state = await this.load();
		let changed = false;
		const existing = new Set(state.accounts.map((account) => account.id));
		const retired = new Set(state.retiredLegacyAccountIds);
		const timestamp = this.now().toISOString();
		for (const definition of LEGACY_API_DEFINITIONS) {
			if (!definition.credentialKey || !environment[definition.credentialKey])
				continue;
			if (existing.has(definition.id) || retired.has(definition.id)) continue;
			const baseUrl = legacyBaseUrl(definition, environment);
			const normalizedBaseUrl = baseUrl
				? normalizeStoredBaseUrl(baseUrl, definition.adapter)
				: undefined;
			// A generic legacy route without a usable endpoint was never runnable;
			// leave it unimported rather than persisting a record that would block
			// this account from being repaired or executed later.
			if (definition.adapter === "openai-compatible" && !normalizedBaseUrl)
				continue;
			if (baseUrl && !normalizedBaseUrl) continue;
			state.accounts.push({
				id: definition.id,
				providerId: definition.providerId,
				adapter: definition.adapter,
				displayName: definition.displayName,
				authTransport: definition.authTransport,
				enabled: true,
				...(normalizedBaseUrl
					? {
						baseUrl: normalizedBaseUrl,
					}
					: {}),
				...(environment[definition.modelKey ?? ""]
					? { defaultModel: environment[definition.modelKey ?? ""] }
					: definition.defaultModel
						? { defaultModel: definition.defaultModel }
						: {}),
				...(sanitizeOptional(
					environment[definition.organizationKey ?? ""],
					300,
				)
					? {
						organization: sanitizeOptional(
							environment[definition.organizationKey ?? ""],
							300,
						),
					}
					: {}),
				...(sanitizeOptional(environment[definition.projectKey ?? ""], 300)
					? {
						project: sanitizeOptional(
							environment[definition.projectKey ?? ""],
							300,
						),
					}
					: {}),
				legacyEnvironmentKey: definition.credentialKey,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			existing.add(definition.id);
			changed = true;
		}
		const subscriptions: Array<{
			id: string;
			providerId: string;
			adapter: ProviderAccountAdapter;
			displayName: string;
			authTransport: ProviderAccountAuthTransport;
			enabledKey: string;
			pathKey: string;
			modelKey: string;
		}> = [
			{
				id: "legacy-codex",
				providerId: "codex",
				adapter: "codex-app-server",
				displayName: "Codex",
				authTransport: "oauth",
				enabledKey: "KESTREL_ENABLE_CODEX_SUBSCRIPTION",
				pathKey: "KESTREL_CODEX_PATH",
				modelKey: "KESTREL_CODEX_SUBSCRIPTION_MODEL",
			},
			{
				id: "legacy-claude",
				providerId: "claude",
				adapter: "claude-cli",
				displayName: "Claude Code",
				authTransport: "cli_profile",
				enabledKey: "KESTREL_ENABLE_CLAUDE_SUBSCRIPTION",
				pathKey: "KESTREL_CLAUDE_PATH",
				modelKey: "KESTREL_CLAUDE_SUBSCRIPTION_MODEL",
			},
			{
				id: "legacy-opencode",
				providerId: "opencode",
				adapter: "opencode-cli",
				displayName: "OpenCode",
				authTransport: "cli_profile",
				enabledKey: "KESTREL_ENABLE_OPENCODE_SUBSCRIPTION",
				pathKey: "KESTREL_OPENCODE_PATH",
				modelKey: "KESTREL_OPENCODE_SUBSCRIPTION_MODEL",
			},
			{
				id: "legacy-cursor",
				providerId: "cursor",
				adapter: "cursor-cli",
				displayName: "Cursor",
				authTransport: "cli_profile",
				enabledKey: "KESTREL_ENABLE_CURSOR_SUBSCRIPTION",
				pathKey: "KESTREL_CURSOR_PATH",
				modelKey: "KESTREL_CURSOR_SUBSCRIPTION_MODEL",
			},
		];
		for (const subscription of subscriptions) {
			if (
				environment[subscription.enabledKey] !== "1" ||
				existing.has(subscription.id) ||
				retired.has(subscription.id)
			)
				continue;
			state.accounts.push({
				id: subscription.id,
				providerId: subscription.providerId,
				adapter: subscription.adapter,
				displayName: subscription.displayName,
				authTransport: subscription.authTransport,
				enabled: true,
				...(environment[subscription.pathKey]
					? { executable: environment[subscription.pathKey] }
					: {}),
				...(environment[subscription.modelKey]
					? { defaultModel: environment[subscription.modelKey] }
					: {}),
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			existing.add(subscription.id);
			changed = true;
		}
		const legacyOllamaBaseUrl = normalizeStoredBaseUrl(
			environment.KESTREL_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
			"ollama",
		);
		if (
			(environment.KESTREL_ENABLE_OLLAMA === "1" ||
				environment.KESTREL_OLLAMA_BASE_URL) &&
			legacyOllamaBaseUrl &&
			!existing.has("legacy-ollama") &&
			!retired.has("legacy-ollama")
		) {
			state.accounts.push({
				id: "legacy-ollama",
				providerId: "ollama",
				adapter: "ollama",
				displayName: "Ollama",
				authTransport: "local",
				enabled: true,
				baseUrl: legacyOllamaBaseUrl,
				...(environment.KESTREL_OLLAMA_MODEL
					? { defaultModel: environment.KESTREL_OLLAMA_MODEL }
					: {}),
				...(environment.KESTREL_OLLAMA_CONTEXT_WINDOW &&
					Number.isFinite(Number(environment.KESTREL_OLLAMA_CONTEXT_WINDOW))
					? {
						contextWindow: Math.floor(
							Number(environment.KESTREL_OLLAMA_CONTEXT_WINDOW),
						),
					}
					: {}),
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			changed = true;
		}
		if (changed) await this.save(state);
	}

	async create(input: ProviderAccountInput): Promise<ProviderAccountSummary[]> {
		assertTransport(input);
		const state = await this.load();
		const timestamp = this.now().toISOString();
		const id = `account-${randomUUID()}`;
		const adapter = input.adapter;
		const baseUrl = normalizeBaseUrl(input.baseUrl, adapter);
		const account: StoredProviderAccount = {
			id,
			providerId: input.providerId,
			adapter,
			displayName: input.displayName.trim(),
			authTransport: input.authTransport,
			enabled: input.enabled,
			...(baseUrl
				? { baseUrl }
				: {}),
			...(sanitizeOptional(input.organization, 300)
				? { organization: sanitizeOptional(input.organization, 300) }
				: {}),
			...(sanitizeOptional(input.project, 300)
				? { project: sanitizeOptional(input.project, 300) }
				: {}),
			...(sanitizeOptional(input.defaultModel, 200)
				? { defaultModel: sanitizeOptional(input.defaultModel, 200) }
				: {}),
			...(adapter === "codex-app-server"
				? { profilePath: join(this.userDataPath, "provider-profiles", id, "codex") }
				: {}),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		assertStoredAccountConfiguration(account);
		const headers = headersFrom(input.headers);
		if (input.apiKey || headers) {
			await this.broker.setOpaqueSecret(
				secretId(id),
				JSON.stringify({
					...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
					...(headers ? { headers } : {}),
				} satisfies SecretEnvelope),
			);
		}
		state.accounts.push(account);
		await this.save(state);
		return state.accounts.map(accountSummary);
	}

	async update(input: ProviderAccountUpdate): Promise<ProviderAccountSummary[]> {
		const state = await this.load();
		const index = state.accounts.findIndex((account) => account.id === input.id);
		if (index < 0) throw new Error("Provider account no longer exists.");
		const current = state.accounts[index]!;
		const timestamp = this.now().toISOString();
		const baseUrl =
			input.baseUrl === undefined
				? undefined
				: normalizeBaseUrl(input.baseUrl, current.adapter);
		const next: StoredProviderAccount = {
			...current,
			...(input.displayName !== undefined
				? { displayName: input.displayName.trim() }
				: {}),
			...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
			...(input.baseUrl !== undefined
				? (baseUrl ? { baseUrl } : { baseUrl: undefined })
				: {}),
			...(input.organization !== undefined
				? { organization: sanitizeOptional(input.organization, 300) }
				: {}),
			...(input.project !== undefined
				? { project: sanitizeOptional(input.project, 300) }
				: {}),
			...(input.defaultModel !== undefined
				? { defaultModel: sanitizeOptional(input.defaultModel, 200) }
				: {}),
			updatedAt: timestamp,
		};
		assertStoredAccountConfiguration(next);
		const existingSecret = await this.secretFor(current.id);
		const headers = headersFrom(input.headers);
		const secret: SecretEnvelope = {
			...(existingSecret?.apiKey ? { apiKey: existingSecret.apiKey } : {}),
			...(existingSecret?.headers ? { headers: existingSecret.headers } : {}),
			...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
			...(headers !== undefined ? { headers } : {}),
		};
		if (secret.apiKey || secret.headers) {
			await this.broker.setOpaqueSecret(secretId(current.id), JSON.stringify(secret));
		}
		state.accounts[index] = next;
		await this.save(state);
		return state.accounts.map(accountSummary);
	}

	async remove(accountId: string): Promise<ProviderAccountSummary[]> {
		const state = await this.load();
		const account = state.accounts.find((candidate) => candidate.id === accountId);
		if (!account) throw new Error("Provider account no longer exists.");
		state.accounts = state.accounts.filter((candidate) => candidate.id !== accountId);
		if (isLegacyAccountId(account.id)) {
			state.retiredLegacyAccountIds = [
				...new Set([...state.retiredLegacyAccountIds, account.id]),
			];
		}
		await this.save(state);
		// Persist the disconnect before revoking its broker secret. If protected
		// storage is temporarily unavailable, a harmless orphan can be cleaned up
		// later; the inverse ordering could leave an account record referring to a
		// credential that was irreversibly removed.
		if (!account.legacyEnvironmentKey)
			await this.broker.removeOpaqueSecret(secretId(account.id));
		return state.accounts.map(accountSummary);
	}

	async runtimeAccounts(
		environment: NodeJS.ProcessEnv,
	): Promise<ProviderAccountRuntimeConfig[]> {
		const accounts = (await this.load()).accounts;
		const runtime: ProviderAccountRuntimeConfig[] = [];
		for (const account of accounts) {
			if (!account.enabled) continue;
			// A malformed legacy file must not make a valid account prevent the
			// entire provider core from starting. It stays visible for removal.
			if (account.adapter === "openai-compatible" && !account.baseUrl) continue;
			const legacySecret = account.legacyEnvironmentKey
				? environment[account.legacyEnvironmentKey]
				: undefined;
			const secret: SecretEnvelope | undefined = account.legacyEnvironmentKey
				? legacySecret
					? { apiKey: legacySecret }
					: undefined
				: await this.secretFor(account.id);
			if (account.authTransport === "api_key" && !secret?.apiKey) continue;
			const legacyHeaders =
				account.providerId === "openrouter"
					? {
						"HTTP-Referer": environment.OPENROUTER_SITE_URL ?? "http://localhost",
						"X-OpenRouter-Title": environment.OPENROUTER_APP_NAME ?? "Kestrel",
					}
					: undefined;
			const headers =
				secret?.headers || legacyHeaders
					? { ...legacyHeaders, ...secret?.headers }
					: undefined;
			runtime.push({
				id: account.id,
				providerId: account.providerId,
				adapter: account.adapter,
				displayName: account.displayName,
				authTransport: account.authTransport,
				enabled: account.enabled,
				...(secret?.apiKey ? { apiKey: secret.apiKey } : {}),
				...(headers ? { headers } : {}),
				...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
				...(account.organization ? { organization: account.organization } : {}),
				...(account.project ? { project: account.project } : {}),
				...(account.defaultModel ? { defaultModel: account.defaultModel } : {}),
				...(account.profilePath ? { profilePath: account.profilePath } : {}),
				...(account.executable ? { executable: account.executable } : {}),
				...(account.contextWindow
					? { contextWindow: account.contextWindow }
					: {}),
				configurationVersion: account.updatedAt,
			});
		}
		return runtime;
	}

	private async secretFor(accountId: string): Promise<SecretEnvelope | undefined> {
		const raw = await this.broker.getOpaqueSecret(secretId(accountId));
		if (!raw) return undefined;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return undefined;
			const value = parsed as SecretEnvelope;
			const headers = value.headers && typeof value.headers === "object"
				? Object.fromEntries(
					Object.entries(value.headers).flatMap(([name, header]) =>
						typeof header === "string" && HEADER_NAME.test(name) &&
						!/[\r\n\0]/.test(header)
							? [[name, header] as const]
							: [],
					),
				)
				: undefined;
			return {
				...(typeof value.apiKey === "string" && value.apiKey.trim()
					? { apiKey: value.apiKey }
					: {}),
				...(headers && Object.keys(headers).length ? { headers } : {}),
			};
		} catch {
			throw new Error("Kestrel could not read a protected provider account secret.");
		}
	}

	private async load(): Promise<StoredProviderAccountFile> {
		try {
			return parseStore(JSON.parse(await readFile(this.path, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return {
					version: STORE_VERSION,
					accounts: [],
					retiredLegacyAccountIds: [],
				};
			throw new Error("Kestrel could not read provider account settings.");
		}
	}

	private async save(state: StoredProviderAccountFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(
				temporary,
				`${JSON.stringify(
					{
						version: STORE_VERSION,
						accounts: state.accounts,
						retiredLegacyAccountIds: state.retiredLegacyAccountIds,
					},
					null,
					2,
				)}\n`,
				{ mode: 0o600 },
			);
			await rename(temporary, this.path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}
