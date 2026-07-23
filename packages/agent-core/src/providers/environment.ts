import { AnthropicMessagesProvider } from "./anthropic-messages";
import { OllamaChatProvider } from "./ollama-chat";
import { OpenAIResponsesProvider } from "./openai-responses";
import { GeminiGenerateContentProvider } from "./gemini-generate-content";
import { ClaudeSubscriptionProvider } from "./subscription-cli";
import { CodexAppServerProvider } from "./codex-app-server";
import type { ModelProvider } from "./types";

export function createEnvironmentModelProviders(environment: NodeJS.ProcessEnv = process.env): ModelProvider[] {
  const providers: ModelProvider[] = [];
  if (environment.OPENAI_API_KEY) {
    providers.push(new OpenAIResponsesProvider({
      apiKey: environment.OPENAI_API_KEY,
      ...(environment.OPENAI_MODEL ? { defaultModel: environment.OPENAI_MODEL } : {}),
      ...(environment.OPENAI_API_KEY_SECONDARY ? { id: "openai-key-1", poolId: "openai" } : {}),
      ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}),
      ...(environment.OPENAI_ORGANIZATION ? { organization: environment.OPENAI_ORGANIZATION } : {}),
      ...(environment.OPENAI_PROJECT ? { project: environment.OPENAI_PROJECT } : {})
    }));
  }
  if (environment.OPENAI_API_KEY_SECONDARY) providers.push(new OpenAIResponsesProvider({ apiKey: environment.OPENAI_API_KEY_SECONDARY, id: "openai-key-2", poolId: "openai", ...(environment.OPENAI_MODEL ? { defaultModel: environment.OPENAI_MODEL } : {}), ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}), ...(environment.OPENAI_ORGANIZATION ? { organization: environment.OPENAI_ORGANIZATION } : {}), ...(environment.OPENAI_PROJECT ? { project: environment.OPENAI_PROJECT } : {}) }));
  if (environment.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicMessagesProvider({
      apiKey: environment.ANTHROPIC_API_KEY,
      ...(environment.ANTHROPIC_MODEL ? { defaultModel: environment.ANTHROPIC_MODEL } : {}),
      ...(environment.ANTHROPIC_API_KEY_SECONDARY ? { id: "anthropic-key-1", poolId: "anthropic" } : {}),
      ...(environment.ANTHROPIC_BASE_URL ? { baseUrl: environment.ANTHROPIC_BASE_URL } : {})
    }));
  }
  if (environment.ANTHROPIC_API_KEY_SECONDARY) providers.push(new AnthropicMessagesProvider({ apiKey: environment.ANTHROPIC_API_KEY_SECONDARY, id: "anthropic-key-2", poolId: "anthropic", ...(environment.ANTHROPIC_MODEL ? { defaultModel: environment.ANTHROPIC_MODEL } : {}), ...(environment.ANTHROPIC_BASE_URL ? { baseUrl: environment.ANTHROPIC_BASE_URL } : {}) }));
  if (environment.GEMINI_API_KEY) providers.push(new GeminiGenerateContentProvider({ apiKey: environment.GEMINI_API_KEY, ...(environment.GEMINI_MODEL ? { defaultModel: environment.GEMINI_MODEL } : {}), ...(environment.GEMINI_BASE_URL ? { baseUrl: environment.GEMINI_BASE_URL } : {}) }));
  if (environment.KESTREL_ENABLE_CODEX_SUBSCRIPTION === "1") providers.push(new CodexAppServerProvider({
    ...(environment.KESTREL_CODEX_PATH ? { executable: environment.KESTREL_CODEX_PATH } : {}),
    ...(environment.KESTREL_CODEX_SUBSCRIPTION_MODEL ? { defaultModel: environment.KESTREL_CODEX_SUBSCRIPTION_MODEL } : {}),
    environment
  }));
  if (environment.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION === "1") providers.push(new ClaudeSubscriptionProvider({
    ...(environment.KESTREL_CLAUDE_PATH ? { executable: environment.KESTREL_CLAUDE_PATH } : {}),
    ...(environment.KESTREL_CLAUDE_SUBSCRIPTION_MODEL ? { defaultModel: environment.KESTREL_CLAUDE_SUBSCRIPTION_MODEL } : {}),
    environment
  }));
  if (environment.KESTREL_OLLAMA_BASE_URL || environment.KESTREL_ENABLE_OLLAMA === "1") {
    providers.push(new OllamaChatProvider({
      baseUrl: environment.KESTREL_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"
      ,...(environment.KESTREL_OLLAMA_MODEL ? { defaultModel: environment.KESTREL_OLLAMA_MODEL } : {})
      ,...(environment.KESTREL_OLLAMA_CONTEXT_WINDOW && Number.isFinite(Number(environment.KESTREL_OLLAMA_CONTEXT_WINDOW)) ? { contextWindow: Number(environment.KESTREL_OLLAMA_CONTEXT_WINDOW) } : {})
    }));
  }
  return providers;
}
