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
			features: { structuredOutput: input.tools ?? true, reasoningLevels: true, fastMode: true },
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
	provider({ id: "local-fast", model: "qwen3-mini", local: true, tools: true, capabilities: { speed: .98, cost_efficiency: .98, coding: .7, technical_writing: .8 }, latencyMs: 500, cost: 0 }),
	provider({ id: "frontier-code", model: "gpt-5.6", capabilities: { complex_reasoning: .98, coding: .98, backend_architecture: .98, debugging: .95, planning: .94, code_review: .95, reliability: .94 }, latencyMs: 2200, cost: 8 }),
	provider({ id: "vision-specialist", model: "gemini-3-pro", images: true, capabilities: { image_understanding: .99, ui_visual_design: .94, frontend_implementation: .85, complex_reasoning: .9 }, latencyMs: 2500, cost: 5 }),
	provider({ id: "long-context", model: "claude-opus", contextWindow: 1_000_000, capabilities: { long_context: 1, research: .9, complex_reasoning: .96, technical_writing: .9 }, latencyMs: 3000, cost: 12 }),
	provider({ id: "research-fast", model: "gemini-2.5-flash", capabilities: { research: .97, technical_writing: .9, speed: .9, structured_output: .9 }, latencyMs: 1000, cost: 1 }),
];

export const ROUTING_EVALUATION_FIXTURES: readonly RoutingEvaluationFixture[] = [
	{ id: "rewrite", prompt: "Rewrite this paragraph for a friendly, concise tone.", input: { requiresWriting: true }, expectedTaskType: "writing", expectedReason: "Short creative writing should favor a fast, low-cost route." },
	{ id: "html", prompt: "Create an accessible HTML landing page with semantic markup and CSS.", expectedTaskType: "frontend", expectedReason: "Frontend implementation needs coding and structured output." },
	{ id: "react-bug", prompt: "Debug this React state bug and explain the minimal fix with a regression test.", input: { requiresReview: true }, expectedTaskType: "frontend", expectedReason: "Debugging and review favor the coding specialist." },
	{ id: "typescript-architecture", prompt: "Design a difficult TypeScript architecture for a concurrent event system; think hard about failure modes and boundaries.", expectedTaskType: "coding", expectedReason: "High-complexity architecture requires frontier reasoning." },
	{ id: "repository-refactor", prompt: "Refactor the repository migration pipeline, edit files, run tests, and prepare a pull request.", input: { requiresTools: true, riskLevel: "sensitive" }, expectedTaskType: "repository_modification", expectedReason: "Repository mutation requires tools, coding, and verification." },
	{ id: "mcp-basic", prompt: "Use an MCP tool to read one issue and return its title as JSON.", input: { requiresTools: true, requiresStructuredOutput: true }, expectedTaskType: "mcp_tool_execution", expectedReason: "Basic MCP work needs confirmed tools and structured output." },
	{ id: "mcp-complex", prompt: "Use MCP tools to inspect the repository, correlate five services, and propose a validated remediation plan.", input: { requiresTools: true, requiresStructuredOutput: true, requiresReview: true }, expectedTaskType: "mcp_tool_execution", expectedReason: "Complex MCP orchestration needs tools, planning, and review." },
	{ id: "cad", prompt: "In CAD, create a constrained sketch, extrude it, and verify the resulting geometry.", input: { requiresTools: true }, expectedTaskType: "cad_tool_control", expectedReason: "CAD tool control requires a tool-capable route with geometry reasoning." },
	{ id: "research", prompt: "Research three approaches to local-first sync and return a cited comparison table.", input: { requiresStructuredOutput: true }, expectedTaskType: "research", expectedReason: "Research and comparison benefit from research specialization." },
	{ id: "long-context", prompt: `${"Analyze this long repository specification and identify contradictions. ".repeat(2500)}`, expectedTaskType: "long_context", expectedReason: "Long context must fit the large context window." },
	{ id: "multimodal", prompt: "Inspect this screenshot and explain the visual layout bug and the likely CSS fix.", input: { requiresVision: true }, expectedTaskType: "image_understanding", expectedReason: "Image understanding requires a confirmed vision-capable model." },
];

/** Run deterministic, offline routing fixtures; no provider calls or secrets are used. */
export function evaluateRoutingFixtures(
	fixtures: readonly RoutingEvaluationFixture[] = ROUTING_EVALUATION_FIXTURES,
): RoutingEvaluationResult[] {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const registry = new ModelRegistry(database, providers, [], () => new Date("2026-09-07T00:00:00.000Z"));
	const router = new AdaptiveModelRouter(database, registry, () => 0.01, () => true, () => new Date("2026-09-07T00:00:00.000Z"));
	const analyzer = new TaskRequirementAnalyzer();
	return fixtures.map((fixture) => {
		const requirements = analyzer.analyze(fixture.id, fixture.prompt, fixture.input);
		const decision = router.route(requirements, { role: "orchestrator", policy });
		const trace = router.traces().at(-1);
		return {
			id: fixture.id,
			taskProfile: requirements.taskProfile,
			candidates: trace?.candidates ?? [],
			selectedRoute: { modelId: decision.selectedModelId, providerId: decision.providerId, model: decision.model, reasoningLevel: decision.reasoningLevel, executionPattern: decision.executionPattern },
			expectedReason: fixture.expectedReason,
			routerReasons: decision.reasons,
		};
	});
}
