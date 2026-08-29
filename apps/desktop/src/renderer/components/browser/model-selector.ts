import type {
	LocalModelSummary,
	ModelProviderSummary,
	ReasoningEffort,
} from "@kestrel/shared-types";

export type ModelSelectorChoice = {
	executionMode: "automatic" | "manual";
	providerId: string;
	model: string;
	reasoningEffort: ReasoningEffort;
};

export type CatalogModel = {
	id: string;
	label: string;
	detail?: string;
	reasoningLevels: boolean;
};

export const THINKING_LEVELS: readonly {
	id: ReasoningEffort;
	label: string;
}[] = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Med" },
	{ id: "high", label: "High" },
	{ id: "xhigh", label: "Extra high" },
	{ id: "max", label: "Max" },
];

const PROVIDER_LABELS: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	gemini: "Google",
	ollama: "Ollama",
	"codex-subscription": "Codex",
	"claude-subscription": "Claude Code",
	"opencode-subscription": "OpenCode",
	groq: "Groq",
	mistral: "Mistral",
	openrouter: "OpenRouter",
	nous: "Nous",
	xai: "xAI",
	deepseek: "DeepSeek",
	together: "Together",
	fireworks: "Fireworks",
	nvidia: "NVIDIA",
	huggingface: "Hugging Face",
	perplexity: "Perplexity",
	"github-models": "GitHub Models",
	cohere: "Cohere",
	cloudflare: "Cloudflare",
	tokenrouter: "TokenRouter",
	bai: "B.AI",
	inferx: "InferX",
	zenmux: "ZenMux",
	"opencode-zen": "OpenCode Zen",
	sensenova: "SenseNova",
	gmicloud: "GMI Cloud",
	tokenharbor: "Token Harbor",
	cline: "Cline",
	"command-code": "Command Code",
	kilo: "Kilo",
	orcarouter: "OrcaRouter",
	aihubmix: "AIHubMix",
};

const PROVIDER_MODEL_CATALOG: Record<string, readonly CatalogModel[]> = {
	openai: [
		{ id: "gpt-5.6-sol", label: "Sol", reasoningLevels: true },
		{ id: "gpt-5.6-luna", label: "Luna", reasoningLevels: true },
		{ id: "gpt-5.6-terra", label: "Terra", reasoningLevels: true },
	],
	"codex-subscription": [
		{ id: "gpt-5.6-sol", label: "Sol", reasoningLevels: true },
		{ id: "gpt-5.6-terra", label: "Terra", reasoningLevels: true },
		{ id: "gpt-5.6-luna", label: "Luna", reasoningLevels: true },
	],
	anthropic: [
		{ id: "claude-sonnet-4-5", label: "Sonnet 4.5", reasoningLevels: true },
		{ id: "claude-opus-4-6", label: "Opus 4.6", reasoningLevels: true },
		{ id: "claude-haiku-4-5", label: "Haiku 4.5", reasoningLevels: false },
	],
	"claude-subscription": [
		{ id: "sonnet", label: "Sonnet", reasoningLevels: false },
		{ id: "opus", label: "Opus", reasoningLevels: false },
		{ id: "haiku", label: "Haiku", reasoningLevels: false },
	],
	gemini: [
		{ id: "gemini-3.6-flash", label: "Flash", reasoningLevels: false },
	],
	groq: [{ id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", reasoningLevels: false }],
	mistral: [
		{ id: "mistral-small-latest", label: "Small", reasoningLevels: false },
	],
	openrouter: [{ id: "openrouter/free", label: "Free", reasoningLevels: false }],
	nous: [
		{
			id: "stepfun/step-3.7-flash:free",
			label: "Step 3.7 Flash",
			reasoningLevels: false,
		},
	],
	xai: [{ id: "grok-3-mini", label: "Grok 3 Mini", reasoningLevels: false }],
	deepseek: [{ id: "deepseek-chat", label: "Chat", reasoningLevels: false }],
	"opencode-subscription": [
		{ id: "opencode", label: "OpenCode", reasoningLevels: false },
	],
	tokenrouter: [
		{
			id: "qwen/qwen3.8-max-free",
			label: "Qwen 3.8 Max Free",
			reasoningLevels: false,
		},
	],
	bai: [
		{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", reasoningLevels: false },
	],
	inferx: [
		{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", reasoningLevels: false },
	],
	zenmux: [
		{
			id: "z-ai/glm-4.7-flash-free",
			label: "GLM 4.7 Flash Free",
			reasoningLevels: false,
		},
	],
	"opencode-zen": [
		{
			id: "deepseek-v4-flash-free",
			label: "DeepSeek V4 Flash Free",
			reasoningLevels: false,
		},
		{
			id: "muse-spark-1.2-contributor-free",
			label: "Muse Spark 1.2 Contributor Free",
			reasoningLevels: false,
		},
		{ id: "mimo-v2.5-free", label: "MiMo V2.5 Free", reasoningLevels: false },
		{ id: "hy3-free", label: "HY 3 Free", reasoningLevels: false },
		{
			id: "ling-3.0-flash-fin-free",
			label: "Ling 3.0 Flash Fin Free",
			reasoningLevels: false,
		},
		{
			id: "nemotron-3-ultra-free",
			label: "Nemotron 3 Ultra Free",
			reasoningLevels: false,
		},
		{
			id: "nemotron-3.5-lightning-free",
			label: "Nemotron 3.5 Lightning Free",
			reasoningLevels: false,
		},
		{
			id: "laguna-s-2.1-free",
			label: "Laguna S 2.1 Free",
			reasoningLevels: false,
		},
	],
	sensenova: [
		{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", reasoningLevels: false },
	],
	gmicloud: [
		{
			id: "deepseek-ai/DeepSeek-V4-Pro",
			label: "DeepSeek V4 Pro",
			reasoningLevels: false,
		},
	],
	tokenharbor: [
		{
			id: "deepseek-v4-flash:free",
			label: "DeepSeek V4 Flash Free",
			reasoningLevels: false,
		},
	],
	cline: [
		{
			id: "poolside/laguna-s-2.1:free",
			label: "Laguna S 2.1 Free",
			reasoningLevels: false,
		},
	],
	"command-code": [
		{
			id: "poolside/laguna-s-2.1-free",
			label: "Laguna S 2.1 Free",
			reasoningLevels: false,
		},
	],
	kilo: [{ id: "kilo-auto/free", label: "Auto Free", reasoningLevels: false }],
	orcarouter: [
		{ id: "orcarouter/free", label: "OrcaRouter Free", reasoningLevels: false },
	],
	aihubmix: [
		{
			id: "xiaomi-mimo-v2.5-free",
			label: "MiMo V2.5 Free",
			reasoningLevels: false,
		},
	],
};

export function providerDisplayName(providerId: string): string {
	return PROVIDER_LABELS[providerId] ?? providerId;
}

export function compactModelBytes(value: number): string {
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
	if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
	return `${value} B`;
}

export function configuredProviders(
	providers: readonly ModelProviderSummary[],
): ModelProviderSummary[] {
	return providers.filter((provider) => provider.id !== "auto");
}

export function modelsForProvider(input: {
	providerId: string;
	localModels: readonly LocalModelSummary[];
	currentModel: string;
}): CatalogModel[] {
	if (input.providerId === "ollama") {
		const installed = input.localModels.map((item) => ({
			id: item.name,
			label: item.name,
			detail: compactModelBytes(item.size),
			reasoningLevels: false,
		}));
		return withCurrentModel(installed, input.currentModel);
	}
	const catalog = [...(PROVIDER_MODEL_CATALOG[input.providerId] ?? [])];
	return withCurrentModel(catalog, input.currentModel);
}

function withCurrentModel(
	models: CatalogModel[],
	currentModel: string,
): CatalogModel[] {
	const trimmed = currentModel.trim();
	if (!trimmed || trimmed === "auto") return models;
	if (models.some((model) => model.id === trimmed)) return models;
	return [
		{ id: trimmed, label: trimmed, detail: "Custom", reasoningLevels: false },
		...models,
	];
}

export function modelLabel(
	providerId: string,
	modelId: string,
	localModels: readonly LocalModelSummary[] = [],
): string {
	const match = modelsForProvider({
		providerId,
		localModels,
		currentModel: modelId,
	}).find((model) => model.id === modelId);
	return match?.label ?? modelId;
}

export function modelSupportsThinking(
	providerId: string,
	modelId: string,
	localModels: readonly LocalModelSummary[] = [],
): boolean {
	return (
		modelsForProvider({
			providerId,
			localModels,
			currentModel: modelId,
		}).find((model) => model.id === modelId)?.reasoningLevels === true
	);
}

export function thinkingLabel(effort: ReasoningEffort): string {
	return THINKING_LEVELS.find((level) => level.id === effort)?.label ?? effort;
}

export function selectorTriggerLabel(choice: ModelSelectorChoice): string {
	if (choice.executionMode === "automatic") return "Auto";
	const name = modelLabel(choice.providerId, choice.model);
	if (!choice.model.trim()) return "Choose model";
	if (
		modelSupportsThinking(choice.providerId, choice.model) &&
		choice.reasoningEffort !== "none"
	)
		return `${name} · ${thinkingLabel(choice.reasoningEffort)}`;
	return name;
}

export function selectProvider(
	providerId: string,
	localModels: readonly LocalModelSummary[],
	current: ModelSelectorChoice,
): ModelSelectorChoice {
	const models = modelsForProvider({
		providerId,
		localModels,
		currentModel: current.providerId === providerId ? current.model : "",
	});
	const model =
		current.providerId === providerId && current.model.trim()
			? current.model
			: (models[0]?.id ?? "");
	const supports = modelSupportsThinking(providerId, model, localModels);
	return {
		executionMode: "manual",
		providerId,
		model,
		reasoningEffort: supports
			? current.reasoningEffort === "none"
				? "medium"
				: current.reasoningEffort
			: "none",
	};
}

export function selectModel(
	providerId: string,
	model: string,
	localModels: readonly LocalModelSummary[],
	current: ModelSelectorChoice,
): ModelSelectorChoice {
	const supports = modelSupportsThinking(providerId, model, localModels);
	return {
		executionMode: "manual",
		providerId,
		model,
		reasoningEffort: supports
			? current.reasoningEffort === "none"
				? "medium"
				: current.reasoningEffort
			: "none",
	};
}

export function selectThinking(
	effort: ReasoningEffort,
	current: ModelSelectorChoice,
): ModelSelectorChoice {
	return {
		...current,
		executionMode: "manual",
		reasoningEffort: effort,
	};
}

export function selectAuto(current: ModelSelectorChoice): ModelSelectorChoice {
	return {
		...current,
		executionMode: "automatic",
		model: current.model.trim() || "auto",
		reasoningEffort: "none",
	};
}
