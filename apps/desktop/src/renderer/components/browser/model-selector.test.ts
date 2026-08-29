import { describe, expect, it } from "vitest";
import type { ModelProviderSummary } from "@kestrel/shared-types";
import {
	configuredProviders,
	modelSupportsThinking,
	modelsForProvider,
	providerDisplayName,
	selectAuto,
	selectModel,
	selectProvider,
	selectThinking,
	selectorTriggerLabel,
} from "./model-selector";

const openai: ModelProviderSummary = {
	id: "openai",
	capabilities: {
		streaming: true,
		tools: true,
		images: true,
		audio: false,
		documents: false,
		local: false,
	},
};

const freeProviderCatalog = [
	["tokenrouter", "TokenRouter", "qwen/qwen3.8-max-free"],
	["bai", "B.AI", "deepseek-v4-flash"],
	["inferx", "InferX", "deepseek-v4-flash"],
	["zenmux", "ZenMux", "z-ai/glm-4.7-flash-free"],
	["opencode-zen", "OpenCode Zen", "mimo-v2.5-free"],
	["sensenova", "SenseNova", "deepseek-v4-flash"],
	["gmicloud", "GMI Cloud", "deepseek-ai/DeepSeek-V4-Pro"],
	["tokenharbor", "Token Harbor", "deepseek-v4-flash:free"],
	["cline", "Cline", "poolside/laguna-s-2.1:free"],
	["command-code", "Command Code", "poolside/laguna-s-2.1-free"],
	["kilo", "Kilo", "kilo-auto/free"],
	["orcarouter", "OrcaRouter", "orcarouter/free"],
	["aihubmix", "AIHubMix", "xiaomi-mimo-v2.5-free"],
] as const;

describe("cascading model selector", () => {
	it("hides the synthetic auto provider from the provider list", () => {
		expect(
			configuredProviders([
				openai,
				{
					id: "auto",
					capabilities: openai.capabilities,
				},
			]).map((provider) => provider.id),
		).toEqual(["openai"]);
	});

	it("lists Sol, Luna, and Terra for OpenAI and treats them as thinking models", () => {
		const models = modelsForProvider({
			providerId: "openai",
			localModels: [],
			currentModel: "",
		});
		expect(models.map((model) => model.label)).toEqual(["Sol", "Luna", "Terra"]);
		expect(modelSupportsThinking("openai", "gpt-5.6-terra")).toBe(true);
	});

	it("lists the supported Codex app-server models in default order", () => {
		expect(
			modelsForProvider({
				providerId: "codex-subscription",
				localModels: [],
				currentModel: "",
			}).map((model) => model.id),
		).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
	});

	it("lists every currently returned OpenCode Zen free model in API order", () => {
		expect(
			modelsForProvider({
				providerId: "opencode-zen",
				localModels: [],
				currentModel: "",
			}).map((model) => model.id),
		).toEqual([
			"deepseek-v4-flash-free",
			"muse-spark-1.2-contributor-free",
			"mimo-v2.5-free",
			"hy3-free",
			"ling-3.0-flash-fin-free",
			"nemotron-3-ultra-free",
			"nemotron-3.5-lightning-free",
			"laguna-s-2.1-free",
		]);
	});

	it("exposes every added free provider with its configured default model", () => {
		for (const [providerId, label, modelId] of freeProviderCatalog) {
			expect(providerDisplayName(providerId)).toBe(label);
			expect(
				modelsForProvider({
					providerId,
					localModels: [],
					currentModel: "",
				}),
			).toContainEqual(expect.objectContaining({ id: modelId }));
		}
	});

	it("uses installed Ollama models instead of a static catalog", () => {
		expect(
			modelsForProvider({
				providerId: "ollama",
				localModels: [{ name: "qwen:test", size: 1024 ** 3 }],
				currentModel: "",
			}),
		).toEqual([
			{
				id: "qwen:test",
				label: "qwen:test",
				detail: "1.0 GB",
				reasoningLevels: false,
			},
		]);
	});

	it.each([
		["openai", "gpt-4o-mini"],
		["codex-subscription", "workspace-catalog-model"],
	])("keeps a custom %s model at the top", (providerId, currentModel) => {
		expect(
			modelsForProvider({
				providerId,
				localModels: [],
				currentModel,
			})[0],
		).toMatchObject({ id: currentModel, detail: "Custom" });
	});

	it("turns Auto on from the provider footer and labels the trigger Auto", () => {
		const next = selectAuto({
			executionMode: "manual",
			providerId: "openai",
			model: "gpt-5.6-terra",
			reasoningEffort: "high",
		});
		expect(next.executionMode).toBe("automatic");
		expect(selectorTriggerLabel(next)).toBe("Auto");
	});

	it("selects a provider's first model and a thinking level for that model", () => {
		const afterProvider = selectProvider("openai", [], {
			executionMode: "automatic",
			providerId: "",
			model: "",
			reasoningEffort: "none",
		});
		expect(afterProvider).toMatchObject({
			executionMode: "manual",
			providerId: "openai",
			model: "gpt-5.6-sol",
			reasoningEffort: "medium",
		});
		const afterModel = selectModel("openai", "gpt-5.6-luna", [], afterProvider);
		expect(afterModel.model).toBe("gpt-5.6-luna");
		expect(selectorTriggerLabel(selectThinking("low", afterModel))).toBe(
			"Luna · Low",
		);
	});
});
