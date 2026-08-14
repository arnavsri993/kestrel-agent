import type { SetupSystemProfile } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	recommendedLocalModel,
	recommendedLocalModelTiers,
	supportedLocalModels,
	usableMemoryInGb,
} from "./local-model-catalog";

function profile(memoryGb: number): SetupSystemProfile {
	return {
		platform: "darwin",
		architecture: "arm64",
		memoryBytes: memoryGb * 1024 ** 3,
		logicalCpus: 8,
	};
}

describe("local model compatibility", () => {
	it("reserves memory for macOS and the app", () => {
		expect(usableMemoryInGb(profile(8))).toBe(6);
		expect(usableMemoryInGb(profile(16))).toBe(12);
		expect(usableMemoryInGb(profile(32))).toBe(28);
	});

	it("only returns models inside the usable-memory budget", () => {
		const models = supportedLocalModels(profile(16));
		expect(models.every((model) => model.minimumMemory <= 12)).toBe(true);
		expect(models.map((model) => model.name)).toContain(
			"huihui_ai/qwen3.5-abliterated:9b",
		);
		expect(models.every((model) => model.reducedSafeguards)).toBe(true);
	});

	it("recommends the strongest compatible Huihui model", () => {
		expect(recommendedLocalModel(profile(16))?.name).toBe(
			"huihui_ai/qwen3.5-abliterated:9b",
		);
	});

	it("offers at most three tiers, ending with the strongest compatible model", () => {
		expect(
			recommendedLocalModelTiers(profile(16)).map((model) => model.name),
		).toEqual([
			"huihui_ai/qwen3.5-abliterated:2b",
			"huihui_ai/qwen3.5-abliterated:4b",
			"huihui_ai/qwen3.5-abliterated:9b",
		]);
		expect(
			recommendedLocalModelTiers(profile(32)).map((model) => model.name),
		).toEqual([
			"huihui_ai/qwen3.5-abliterated:2b",
			"huihui_ai/qwen3.5-abliterated:4b",
			"huihui_ai/qwen3.5-abliterated:9b",
		]);
	});

	it("shows no curated model before capacity is known", () => {
		expect(supportedLocalModels(null)).toEqual([]);
		expect(recommendedLocalModel(null)).toBeNull();
		expect(recommendedLocalModelTiers(null)).toEqual([]);
	});
});
