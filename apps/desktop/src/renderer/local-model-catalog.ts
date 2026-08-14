import type { SetupSystemProfile } from "@kestrel/shared-types";

export type LocalModelCatalogEntry = {
	name: string;
	title: string;
	size: string;
	minimumMemory: number;
	recommendedSystemMemory: number;
	description: string;
	bestFor: string;
	speed: string;
	contextLength: string;
	reducedSafeguards?: boolean;
};

export const localModelCatalog: readonly LocalModelCatalogEntry[] = [
	{
		name: "huihui_ai/qwen3.5-abliterated:0.8b",
		title: "Huihui Qwen 3.5 · Tiny",
		size: "1.0 GB",
		minimumMemory: 6,
		recommendedSystemMemory: 8,
		description: "A more open model for short, lightweight tasks.",
		bestFor: "Quick questions and simple writing",
		speed: "Fastest",
		contextLength: "256K",
		reducedSafeguards: true,
	},
	{
		name: "huihui_ai/qwen3.5-abliterated:2b",
		title: "Huihui Qwen 3.5 · Small",
		size: "1.9 GB",
		minimumMemory: 8,
		recommendedSystemMemory: 8,
		description: "A persistent everyday model with fewer refusals.",
		bestFor: "Everyday chat, writing, and light tool use",
		speed: "Fast",
		contextLength: "256K",
		reducedSafeguards: true,
	},
	{
		name: "huihui_ai/qwen3.5-abliterated:4b",
		title: "Huihui Qwen 3.5 · Everyday",
		size: "3.3 GB",
		minimumMemory: 12,
		recommendedSystemMemory: 12,
		description: "A stronger local model for involved, multi-step work.",
		bestFor: "Complex tasks, tool use, and problem solving",
		speed: "Moderate",
		contextLength: "256K",
		reducedSafeguards: true,
	},
	{
		name: "huihui_ai/qwen3.5-abliterated:9b",
		title: "Huihui Qwen 3.5 · Capable",
		size: "6.6 GB",
		minimumMemory: 12,
		recommendedSystemMemory: 16,
		description: "Higher-capacity problem solving for difficult local work.",
		bestFor: "Deep analysis and demanding agent work",
		speed: "Deliberate",
		contextLength: "256K",
		reducedSafeguards: true,
	},
] as const;

export function memoryInGb(profile: SetupSystemProfile | null): number {
	return profile ? Math.max(1, Math.round(profile.memoryBytes / 1024 ** 3)) : 0;
}

export function usableMemoryInGb(profile: SetupSystemProfile | null): number {
	const memory = memoryInGb(profile);
	return memory >= 16 ? memory - 4 : memory >= 8 ? memory - 2 : memory;
}

export function supportedLocalModels(
	profile: SetupSystemProfile | null,
): readonly LocalModelCatalogEntry[] {
	if (!profile) return [];
	const budget = usableMemoryInGb(profile);
	return localModelCatalog.filter((model) => model.minimumMemory <= budget);
}

export function recommendedLocalModel(profile: SetupSystemProfile | null) {
	const supported = supportedLocalModels(profile);
	return supported.at(-1) ?? null;
}

export function recommendedLocalModelTiers(
	profile: SetupSystemProfile | null,
): readonly LocalModelCatalogEntry[] {
	return supportedLocalModels(profile).slice(-3);
}
