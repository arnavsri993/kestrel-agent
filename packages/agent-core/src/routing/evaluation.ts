import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { ModelProvider } from "../providers";
import {
	AdaptiveModelRouter,
	ModelRegistry,
	TaskRequirementAnalyzer,
} from "../model-orchestration";

export interface RoutingEvaluationFixture {
	id: string;
	prompt: string;
	input?: Parameters<TaskRequirementAnalyzer["analyze"]>[2];
	expectedTaskType: ReturnType<TaskRequirementAnalyzer["analyze"]>["taskProfile"]["type"];
	expectedReason: string;
	/** When set, the selected provider must be one of these ids. */
	expectSelectedProviderIds?: readonly string[];
	/** When set, the selected reasoning level must be one of these values. */
	expectReasoningLevels?: readonly string[];
	/** When set, the selected provider must not be one of these ids. */
	forbidSelectedProviderIds?: readonly string[];
}

export interface RoutingEvaluationResult {
	id: string;
	taskProfile: ReturnType<TaskRequirementAnalyzer["analyze"]>["taskProfile"];
	candidates: NonNullable<ReturnType<AdaptiveModelRouter["traces"]>[number]["candidates"]>;
	selectedRoute: {
		modelId: string;
		providerId: string;
		model: string;
		reasoningLevel: string;
		executionPattern: string | undefined;
	};
	expectedReason: string;
	routerReasons: string[];
}

const policy = {
	mode: "balanced" as const,
	allowExternal: true,
	preferLocal: false,
	maximumParallelism: 4,
	maximumRetries: 2,
	maximumDelegationDepth: 3,
	maximumTaskDurationMs: 600_000,
	requireReviewAboveRisk: "sensitive" as const,
	allowAutomaticEscalation: true,
	maximumEscalations: 2,
	allowVerifier: true,
	preferredProviderIds: [],
	avoidedProviderIds: [],
};

function provider(input: {
	id: string;
	model: string;
	local?: boolean;
	images?: boolean;
	tools?: boolean;
	contextWindow?: number;
	capabilities: Record<string, number>;
	latencyMs: number;
	cost: number;
	reasoningLevels?: boolean;
}): ModelProvider {
	return {
		id: input.id,
		defaultModel: input.model,
		capabilities: {
			streaming: true,
			tools: input.tools ?? true,
			images: input.images ?? false,
			audio: false,
			documents: false,
			local: input.local ?? false,
		},
		profileHints: {
			capabilities: input.capabilities,
			cost: { inputPerMillion: input.cost, outputPerMillion: input.cost },
			latency: { averageMs: input.latencyMs, p95Ms: input.latencyMs * 2 },
			limits: { contextWindow: input.contextWindow ?? 128_000 },
			features: {
				structuredOutput: input.tools ?? true,
				reasoningLevels: input.reasoningLevels ?? true,
				fastMode: true,
			},
		},
		complete: async (request) => ({
			providerId: input.id,
			model: request.model,
			text: "offline fixture",
			toolCalls: [],
			usage: { inputTokens: 1, outputTokens: 1 },
			finishReason: "stop",
		}),
	};
}

const providers: ModelProvider[] = [
	provider({
		id: "local-fast",
		model: "qwen3-mini",
		local: true,
		tools: true,
		capabilities: {
			speed: 0.98,
			cost_efficiency: 0.98,
			coding: 0.7,
			technical_writing: 0.8,
			instruction_following: 0.82,
			reliability: 0.85,
		},
		latencyMs: 500,
		cost: 0,
		reasoningLevels: false,
	}),
	provider({
		id: "luna-efficient",
		model: "gpt-5.6-luna",
		capabilities: {
			complex_reasoning: 0.86,
			coding: 0.86,
			backend_architecture: 0.82,
			debugging: 0.84,
			planning: 0.82,
			code_review: 0.82,
			technical_writing: 0.84,
			instruction_following: 0.88,
			reliability: 0.86,
			speed: 0.92,
			cost_efficiency: 0.92,
			research: 0.8,
			structured_output: 0.85,
		},
		latencyMs: 900,
		cost: 1.2,
	}),
	provider({
		id: "frontier-sol",
		model: "gpt-5.6-sol",
		capabilities: {
			complex_reasoning: 0.98,
			coding: 0.98,
			backend_architecture: 0.98,
			debugging: 0.95,
			planning: 0.94,
			code_review: 0.95,
			reliability: 0.94,
			technical_writing: 0.92,
			instruction_following: 0.94,
			research: 0.9,
			structured_output: 0.92,
		},
		latencyMs: 2200,
		cost: 8,
	}),
	// Keep legacy id for fixtures that still name the coding specialist.
	provider({
		id: "frontier-code",
		model: "gpt-5.6-terra",
		capabilities: {
			complex_reasoning: 0.98,
			coding: 0.98,
			backend_architecture: 0.98,
			debugging: 0.95,
			planning: 0.94,
			code_review: 0.95,
			reliability: 0.94,
		},
		latencyMs: 2400,
		cost: 10,
	}),
	provider({
		id: "vision-specialist",
		model: "gemini-3-pro",
		images: true,
		capabilities: {
			image_understanding: 0.99,
			ui_visual_design: 0.94,
			frontend_implementation: 0.85,
			complex_reasoning: 0.9,
		},
		latencyMs: 2500,
		cost: 5,
	}),
	provider({
		id: "long-context",
		model: "claude-opus",
		contextWindow: 1_000_000,
		capabilities: {
			long_context: 1,
			research: 0.9,
			complex_reasoning: 0.96,
			technical_writing: 0.9,
		},
		latencyMs: 3000,
		cost: 12,
	}),
	provider({
		id: "research-fast",
		model: "gemini-2.5-flash",
		capabilities: {
			research: 0.97,
			technical_writing: 0.9,
			speed: 0.9,
			structured_output: 0.9,
		},
		latencyMs: 1000,
		cost: 1,
	}),
];

export const ROUTING_EVALUATION_FIXTURES: readonly RoutingEvaluationFixture[] = [
	{
		id: "rewrite",
		prompt: "Rewrite this paragraph for a friendly, concise tone.",
		input: { requiresWriting: true },
		expectedTaskType: "writing",
		expectedReason: "Short creative writing should favor a fast, low-cost route.",
		forbidSelectedProviderIds: ["frontier-sol", "frontier-code", "long-context"],
		expectReasoningLevels: ["low"],
	},
	{
		id: "html",
		prompt: "Create an accessible HTML landing page with semantic markup and CSS.",
		expectedTaskType: "frontend",
		expectedReason: "Frontend implementation needs coding without frontier overkill.",
		expectSelectedProviderIds: ["luna-efficient", "local-fast", "research-fast"],
		forbidSelectedProviderIds: ["frontier-sol", "frontier-code"],
	},
	{
		id: "react-bug",
		prompt: "Debug this React state bug and explain the minimal fix with a regression test.",
		input: { requiresReview: true },
		expectedTaskType: "frontend",
		expectedReason:
			"Mid debugging should prefer efficient Luna-class routes over frontier Sol/Terra.",
		expectSelectedProviderIds: ["luna-efficient"],
		forbidSelectedProviderIds: ["frontier-sol", "frontier-code"],
	},
	{
		id: "typescript-architecture",
		prompt:
			"Design a difficult TypeScript architecture for a concurrent event system with failure modes, consistency boundaries, and production verification across multiple services.",
		expectedTaskType: "coding",
		expectedReason: "High-complexity architecture requires frontier reasoning.",
		expectSelectedProviderIds: ["frontier-sol", "frontier-code", "long-context"],
		expectReasoningLevels: ["medium", "high", "xhigh", "max"],
	},
	{
		id: "repository-refactor",
		prompt:
			"Refactor the repository migration pipeline, edit files, run tests, and prepare a pull request.",
		input: { requiresTools: true, riskLevel: "sensitive" },
		expectedTaskType: "repository_modification",
		expectedReason: "Repository mutation requires tools, coding, and verification.",
		expectSelectedProviderIds: ["luna-efficient", "frontier-sol", "frontier-code"],
	},
	{
		id: "mcp-basic",
		prompt: "Use an MCP tool to read one issue and return its title as JSON.",
		input: { requiresTools: true, requiresStructuredOutput: true },
		expectedTaskType: "mcp_tool_execution",
		expectedReason: "Basic MCP work needs confirmed tools and structured output.",
		forbidSelectedProviderIds: ["frontier-sol", "frontier-code", "long-context"],
	},
	{
		id: "mcp-complex",
		prompt:
			"Use MCP tools to inspect the repository, correlate five services, and propose a validated remediation plan.",
		input: {
			requiresTools: true,
			requiresStructuredOutput: true,
			requiresReview: true,
		},
		expectedTaskType: "mcp_tool_execution",
		expectedReason: "Complex MCP orchestration needs tools, planning, and review.",
		expectSelectedProviderIds: [
			"luna-efficient",
			"frontier-sol",
			"frontier-code",
			"long-context",
		],
	},
	{
		id: "cad",
		prompt:
			"In CAD, create a constrained sketch, extrude it, and verify the resulting geometry.",
		input: { requiresTools: true },
		expectedTaskType: "cad_tool_control",
		expectedReason: "CAD tool control requires a tool-capable route with geometry reasoning.",
	},
	{
		id: "research",
		prompt: "Research three approaches to local-first sync and return a cited comparison table.",
		input: { requiresStructuredOutput: true },
		expectedTaskType: "research",
		expectedReason: "Research and comparison benefit from research specialization.",
		expectSelectedProviderIds: ["research-fast", "luna-efficient"],
		forbidSelectedProviderIds: ["frontier-sol", "frontier-code"],
	},
	{
		id: "long-context",
		prompt: `${"Analyze this long repository specification and identify contradictions. ".repeat(2500)}`,
		expectedTaskType: "long_context",
		expectedReason: "Long context must fit the large context window.",
		expectSelectedProviderIds: ["long-context"],
	},
	{
		id: "multimodal",
		prompt:
			"Inspect this screenshot and explain the visual layout bug and the likely CSS fix.",
		input: { requiresVision: true },
		expectedTaskType: "image_understanding",
		expectedReason: "Image understanding requires a confirmed vision-capable model.",
		expectSelectedProviderIds: ["vision-specialist"],
	},
	{
		id: "near-equivalent-mid",
		prompt:
			"Plan a careful multi-file TypeScript refactor with tests, then outline the pull request steps.",
		input: { requiresTools: true },
		expectedTaskType: "repository_modification",
		expectedReason:
			"Luna at high thinking should beat Sol at low when ability is near-identical and cost/latency favor Luna.",
		expectSelectedProviderIds: ["luna-efficient"],
		forbidSelectedProviderIds: ["frontier-sol", "frontier-code"],
	},
];

/** Run deterministic, offline routing fixtures; no provider calls or secrets are used. */
export function evaluateRoutingFixtures(
	fixtures: readonly RoutingEvaluationFixture[] = ROUTING_EVALUATION_FIXTURES,
): RoutingEvaluationResult[] {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const registry = new ModelRegistry(
		database,
		providers,
		[],
		() => new Date("2026-09-07T00:00:00.000Z"),
	);
	const router = new AdaptiveModelRouter(
		database,
		registry,
		() => 0.01,
		() => true,
		() => new Date("2026-09-07T00:00:00.000Z"),
	);
	const analyzer = new TaskRequirementAnalyzer();
	return fixtures.map((fixture) => {
		const requirements = analyzer.analyze(fixture.id, fixture.prompt, fixture.input);
		const decision = router.route(requirements, { role: "orchestrator", policy });
		const trace = router.traces().at(-1);
		return {
			id: fixture.id,
			taskProfile: requirements.taskProfile,
			candidates: trace?.candidates ?? [],
			selectedRoute: {
				modelId: decision.selectedModelId,
				providerId: decision.providerId,
				model: decision.model,
				reasoningLevel: decision.reasoningLevel,
				executionPattern: decision.executionPattern,
			},
			expectedReason: fixture.expectedReason,
			routerReasons: decision.reasons,
		};
	});
}
