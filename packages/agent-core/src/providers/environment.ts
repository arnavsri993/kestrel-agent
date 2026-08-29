import { AnthropicMessagesProvider } from "./anthropic-messages";
import { CodexAppServerProvider } from "./codex-app-server";
import { GeminiGenerateContentProvider } from "./gemini-generate-content";
import { OllamaChatProvider } from "./ollama-chat";
import { OpenAIChatCompletionsProvider } from "./openai-chat-completions";
import { OpenAIResponsesProvider } from "./openai-responses";
import {
	ClaudeSubscriptionProvider,
	OpenCodeSubscriptionProvider,
} from "./subscription-cli";
import type { ModelProvider } from "./types";

export function createEnvironmentModelProviders(
	environment: NodeJS.ProcessEnv = process.env,
): ModelProvider[] {
	const providers: ModelProvider[] = [];
	if (environment.OPENAI_API_KEY) {
		providers.push(
			new OpenAIResponsesProvider({
				apiKey: environment.OPENAI_API_KEY,
				...(environment.OPENAI_MODEL
					? { defaultModel: environment.OPENAI_MODEL }
					: {}),
				...(environment.OPENAI_API_KEY_SECONDARY
					? { id: "openai-key-1", poolId: "openai" }
					: {}),
				...(environment.OPENAI_BASE_URL
					? { baseUrl: environment.OPENAI_BASE_URL }
					: {}),
				...(environment.OPENAI_ORGANIZATION
					? { organization: environment.OPENAI_ORGANIZATION }
					: {}),
				...(environment.OPENAI_PROJECT
					? { project: environment.OPENAI_PROJECT }
					: {}),
			}),
		);
	}
	if (environment.OPENAI_API_KEY_SECONDARY)
		providers.push(
			new OpenAIResponsesProvider({
				apiKey: environment.OPENAI_API_KEY_SECONDARY,
				id: "openai-key-2",
				poolId: "openai",
				...(environment.OPENAI_MODEL
					? { defaultModel: environment.OPENAI_MODEL }
					: {}),
				...(environment.OPENAI_BASE_URL
					? { baseUrl: environment.OPENAI_BASE_URL }
					: {}),
				...(environment.OPENAI_ORGANIZATION
					? { organization: environment.OPENAI_ORGANIZATION }
					: {}),
				...(environment.OPENAI_PROJECT
					? { project: environment.OPENAI_PROJECT }
					: {}),
			}),
		);
	if (environment.ANTHROPIC_API_KEY) {
		providers.push(
			new AnthropicMessagesProvider({
				apiKey: environment.ANTHROPIC_API_KEY,
				...(environment.ANTHROPIC_MODEL
					? { defaultModel: environment.ANTHROPIC_MODEL }
					: {}),
				...(environment.ANTHROPIC_API_KEY_SECONDARY
					? { id: "anthropic-key-1", poolId: "anthropic" }
					: {}),
				...(environment.ANTHROPIC_BASE_URL
					? { baseUrl: environment.ANTHROPIC_BASE_URL }
					: {}),
			}),
		);
	}
	if (environment.ANTHROPIC_API_KEY_SECONDARY)
		providers.push(
			new AnthropicMessagesProvider({
				apiKey: environment.ANTHROPIC_API_KEY_SECONDARY,
				id: "anthropic-key-2",
				poolId: "anthropic",
				...(environment.ANTHROPIC_MODEL
					? { defaultModel: environment.ANTHROPIC_MODEL }
					: {}),
				...(environment.ANTHROPIC_BASE_URL
					? { baseUrl: environment.ANTHROPIC_BASE_URL }
					: {}),
			}),
		);
	if (environment.GEMINI_API_KEY)
		providers.push(
			new GeminiGenerateContentProvider({
				apiKey: environment.GEMINI_API_KEY,
				...(environment.GEMINI_MODEL
					? { defaultModel: environment.GEMINI_MODEL }
					: {}),
				...(environment.GEMINI_BASE_URL
					? { baseUrl: environment.GEMINI_BASE_URL }
					: {}),
			}),
		);
	const compatible = [
		[
			"nous",
			"NOUS_API_KEY",
			"NOUS_MODEL",
			"NOUS_BASE_URL",
			"stepfun/step-3.7-flash:free",
			"https://inference-api.nousresearch.com/v1",
			true,
		],
		[
			"groq",
			"GROQ_API_KEY",
			"GROQ_MODEL",
			"GROQ_BASE_URL",
			"openai/gpt-oss-20b",
			"https://api.groq.com/openai/v1",
			false,
		],
		[
			"mistral",
			"MISTRAL_API_KEY",
			"MISTRAL_MODEL",
			"MISTRAL_BASE_URL",
			"mistral-small-latest",
			"https://api.mistral.ai/v1",
			false,
		],
		[
			"openrouter",
			"OPENROUTER_API_KEY",
			"OPENROUTER_MODEL",
			"OPENROUTER_BASE_URL",
			"openrouter/free",
			"https://openrouter.ai/api/v1",
			true,
		],
		[
			"xai",
			"XAI_API_KEY",
			"XAI_MODEL",
			"XAI_BASE_URL",
			"grok-3-mini",
			"https://api.x.ai/v1",
			true,
		],
		[
			"deepseek",
			"DEEPSEEK_API_KEY",
			"DEEPSEEK_MODEL",
			"DEEPSEEK_BASE_URL",
			"deepseek-chat",
			"https://api.deepseek.com/v1",
			false,
		],
		[
			"together",
			"TOGETHER_API_KEY",
			"TOGETHER_MODEL",
			"TOGETHER_BASE_URL",
			"meta-llama/Llama-3.3-70B-Instruct-Turbo",
			"https://api.together.xyz/v1",
			true,
		],
		[
			"fireworks",
			"FIREWORKS_API_KEY",
			"FIREWORKS_MODEL",
			"FIREWORKS_BASE_URL",
			"accounts/fireworks/models/llama-v3p3-70b-instruct",
			"https://api.fireworks.ai/inference/v1",
			true,
		],
		[
			"nvidia",
			"NVIDIA_API_KEY",
			"NVIDIA_MODEL",
			"NVIDIA_BASE_URL",
			"meta/llama-3.3-70b-instruct",
			"https://integrate.api.nvidia.com/v1",
			true,
		],
		[
			"huggingface",
			"HUGGINGFACE_API_KEY",
			"HUGGINGFACE_MODEL",
			"HUGGINGFACE_BASE_URL",
			"openai/gpt-oss-120b:cerebras",
			"https://router.huggingface.co/v1",
			true,
		],
		[
			"perplexity",
			"PERPLEXITY_API_KEY",
			"PERPLEXITY_MODEL",
			"PERPLEXITY_BASE_URL",
			"sonar",
			"https://api.perplexity.ai",
			false,
		],
		[
			"github-models",
			"GITHUB_MODELS_TOKEN",
			"GITHUB_MODELS_MODEL",
			"GITHUB_MODELS_BASE_URL",
			"openai/gpt-4.1-mini",
			"https://models.github.ai/inference",
			true,
		],
		[
			"cohere",
			"COHERE_API_KEY",
			"COHERE_MODEL",
			"COHERE_BASE_URL",
			"command-a-plus-05-2026",
			"https://api.cohere.ai/compatibility/v1",
			false,
		],
		[
			"tokenrouter",
			"TOKENROUTER_API_KEY",
			"TOKENROUTER_MODEL",
			"TOKENROUTER_BASE_URL",
			"qwen/qwen3.8-max-free",
			"https://api.tokenrouter.com/v1",
			true,
		],
		[
			"bai",
			"BAI_API_KEY",
			"BAI_MODEL",
			"BAI_BASE_URL",
			"deepseek-v4-flash",
			"https://api.b.ai/v1",
			false,
		],
		[
			"inferx",
			"INFERX_API_KEY",
			"INFERX_MODEL",
			"INFERX_BASE_URL",
			"deepseek-v4-flash",
			"https://model.inferx.net/endpoints/v1",
			false,
		],
		[
			"zenmux",
			"ZENMUX_API_KEY",
			"ZENMUX_MODEL",
			"ZENMUX_BASE_URL",
			"z-ai/glm-4.7-flash-free",
			"https://zenmux.ai/api/v1",
			false,
		],
		[
			"opencode-zen",
			"OPENCODE_API_KEY",
			"OPENCODE_MODEL",
			"OPENCODE_BASE_URL",
			"mimo-v2.5-free",
			"https://opencode.ai/zen/v1",
			false,
		],
		[
			"sensenova",
			"SENSENOVA_API_KEY",
			"SENSENOVA_MODEL",
			"SENSENOVA_BASE_URL",
			"deepseek-v4-flash",
			"https://token.sensenova.cn/v1",
			false,
		],
		[
			"gmicloud",
			"GMICLOUD_API_KEY",
			"GMICLOUD_MODEL",
			"GMICLOUD_BASE_URL",
			"deepseek-ai/DeepSeek-V4-Pro",
			"https://api.gmi-serving.com/v1",
			true,
		],
		[
			"tokenharbor",
			"TOKENHARBOR_API_KEY",
			"TOKENHARBOR_MODEL",
			"TOKENHARBOR_BASE_URL",
			"deepseek-v4-flash:free",
			"https://tokenharbor.ai/v1",
			false,
		],
		[
			"cline",
			"CLINE_API_KEY",
			"CLINE_MODEL",
			"CLINE_BASE_URL",
			"poolside/laguna-s-2.1:free",
			"https://api.cline.bot/api/v1",
			true,
		],
		[
			"command-code",
			"COMMAND_CODE_API_KEY",
			"COMMAND_CODE_MODEL",
			"COMMAND_CODE_BASE_URL",
			"poolside/laguna-s-2.1-free",
			"https://api.commandcode.ai/provider/v1",
			false,
		],
		[
			"kilo",
			"KILO_API_KEY",
			"KILO_MODEL",
			"KILO_BASE_URL",
			"kilo-auto/free",
			"https://api.kilo.ai/api/gateway",
			false,
		],
		[
			"orcarouter",
			"ORCAROUTER_API_KEY",
			"ORCAROUTER_MODEL",
			"ORCAROUTER_BASE_URL",
			"orcarouter/free",
			"https://api.orcarouter.ai/v1",
			false,
		],
		[
			"aihubmix",
			"AIHUBMIX_API_KEY",
			"AIHUBMIX_MODEL",
			"AIHUBMIX_BASE_URL",
			"xiaomi-mimo-v2.5-free",
			"https://aihubmix.com/v1",
			false,
		],
	] as const;
	for (const [
		id,
		keyName,
		modelName,
		baseName,
		defaultModel,
		defaultBase,
		images,
	] of compatible) {
		const apiKey = environment[keyName];
		if (!apiKey) continue;
		providers.push(
			new OpenAIChatCompletionsProvider({
				id,
				apiKey,
				defaultModel: environment[modelName] ?? defaultModel,
				baseUrl: environment[baseName] ?? defaultBase,
				images,
				...(id === "openrouter"
					? {
							headers: {
								"HTTP-Referer":
									environment.OPENROUTER_SITE_URL ?? "http://localhost",
								"X-OpenRouter-Title":
									environment.OPENROUTER_APP_NAME ?? "Kestrel",
							},
						}
					: {}),
			}),
		);
	}
	if (environment.CLOUDFLARE_API_KEY && environment.CLOUDFLARE_ACCOUNT_ID) {
		providers.push(
			new OpenAIChatCompletionsProvider({
				id: "cloudflare",
				apiKey: environment.CLOUDFLARE_API_KEY,
				defaultModel: environment.CLOUDFLARE_MODEL ?? "@cf/openai/gpt-oss-20b",
				baseUrl:
					environment.CLOUDFLARE_BASE_URL ??
					`https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
			}),
		);
	}
	if (environment.KESTREL_ENABLE_CODEX_SUBSCRIPTION === "1")
		providers.push(
			new CodexAppServerProvider({
				...(environment.KESTREL_CODEX_PATH
					? { executable: environment.KESTREL_CODEX_PATH }
					: {}),
				...(environment.KESTREL_CODEX_SUBSCRIPTION_MODEL
					? { defaultModel: environment.KESTREL_CODEX_SUBSCRIPTION_MODEL }
					: {}),
				environment,
			}),
		);
	if (environment.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION === "1")
		providers.push(
			new ClaudeSubscriptionProvider({
				...(environment.KESTREL_CLAUDE_PATH
					? { executable: environment.KESTREL_CLAUDE_PATH }
					: {}),
				...(environment.KESTREL_CLAUDE_SUBSCRIPTION_MODEL
					? { defaultModel: environment.KESTREL_CLAUDE_SUBSCRIPTION_MODEL }
					: {}),
				environment,
			}),
		);
	if (environment.KESTREL_ENABLE_OPENCODE_SUBSCRIPTION === "1")
		providers.push(
			new OpenCodeSubscriptionProvider({
				...(environment.KESTREL_OPENCODE_PATH
					? { executable: environment.KESTREL_OPENCODE_PATH }
					: {}),
				...(environment.KESTREL_OPENCODE_SUBSCRIPTION_MODEL
					? { defaultModel: environment.KESTREL_OPENCODE_SUBSCRIPTION_MODEL }
					: {}),
				environment,
			}),
		);
	if (
		environment.KESTREL_OLLAMA_BASE_URL ||
		environment.KESTREL_ENABLE_OLLAMA === "1"
	) {
		providers.push(
			new OllamaChatProvider({
				baseUrl:
					environment.KESTREL_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
				...(environment.KESTREL_OLLAMA_MODEL
					? { defaultModel: environment.KESTREL_OLLAMA_MODEL }
					: {}),
				...(environment.KESTREL_OLLAMA_CONTEXT_WINDOW &&
				Number.isFinite(Number(environment.KESTREL_OLLAMA_CONTEXT_WINDOW))
					? { contextWindow: Number(environment.KESTREL_OLLAMA_CONTEXT_WINDOW) }
					: {}),
			}),
		);
	}
	return providers;
}
