import type { ModelCapability, ModelTier } from "@kestrel/shared-types";
import type { DiscoveredModelCapabilities, ModelProfileHints } from "./types";

/**
 * Kestrel only adds this compatibility data after the official OpenAI API has
 * already returned the model in the person's account catalog. It is not a
 * substitute for entitlement discovery.
 */
export type OpenAIModelMetadata = {
	capabilities: Partial<Record<ModelCapability, number>>;
	tier: ModelTier;
	cost: NonNullable<ModelProfileHints["cost"]>;
	discoveryCapabilities: Required<
		Omit<DiscoveredModelCapabilities, "capabilityProvenance">
	>;
};

const GPT_6_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const GPT_6_LIMITS = {
	contextWindow: 1_050_000,
	maxOutputTokens: 128_000,
} as const;

function exactGpt6Model(id: string): "sol" | "luna" | undefined {
	switch (id.trim().toLowerCase()) {
		case "gpt-6-sol":
			return "sol";
		case "gpt-6-luna":
			return "luna";
		default:
			return undefined;
	}
}

function documentedDiscoveryCapabilities(): Required<
	Omit<DiscoveredModelCapabilities, "capabilityProvenance">
> {
	return {
		streaming: true,
		tools: true,
		images: true,
		audio: false,
		documents: false,
		video: false,
		structuredOutput: true,
		reasoningEfforts: [...GPT_6_REASONING_EFFORTS],
		...GPT_6_LIMITS,
	};
}

/**
 * Documented compatibility and routing priors for GPT-6 models. These values
 * describe a model family, not a user's plan or availability; callers must
 * still keep account catalog discovery as the entitlement boundary.
 */
export function openAIModelMetadata(id: string): OpenAIModelMetadata | undefined {
	switch (exactGpt6Model(id)) {
		case "sol":
			return {
				tier: "frontier",
				capabilities: {
					complex_reasoning: 0.96,
					coding: 0.94,
					backend_architecture: 0.92,
					planning: 0.93,
					code_review: 0.92,
					instruction_following: 0.93,
					reliability: 0.9,
				},
				cost: { inputPerMillion: 2, outputPerMillion: 10 },
				discoveryCapabilities: documentedDiscoveryCapabilities(),
			};
		case "luna":
			return {
				tier: "standard",
				capabilities: {
					complex_reasoning: 0.72,
					coding: 0.74,
					planning: 0.7,
					instruction_following: 0.82,
					reliability: 0.84,
					speed: 0.95,
					cost_efficiency: 0.98,
				},
				cost: { inputPerMillion: 0.1, outputPerMillion: 0.5 },
				discoveryCapabilities: documentedDiscoveryCapabilities(),
			};
		default:
			return undefined;
	}
}
