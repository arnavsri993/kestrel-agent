import { describe, expect, it } from "vitest";
import type { ModelProviderSummary } from "@kestrel/shared-types";
import {
	configuredProviders,
	modelSupportsThinking,
	modelsForProvider,
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

	it("keeps a custom model at the top when it is not in the catalog", () => {
		expect(
			modelsForProvider({
				providerId: "openai",
				localModels: [],
				currentModel: "gpt-4o-mini",
			})[0],
		).toMatchObject({ id: "gpt-4o-mini", detail: "Custom" });
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
