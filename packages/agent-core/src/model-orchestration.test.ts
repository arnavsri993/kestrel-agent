import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { ModelProfileSchema, RoutingPolicySchema } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	AdaptiveModelRouter,
	detectModelRefusal,
	inferModelTier,
	ModelRegistry,
	reframePromptForNeutrality,
	TaskRequirementAnalyzer,
} from "./model-orchestration";
import type { ModelProvider } from "./providers";
import { ModelCatalog } from "./providers/model-catalog";
import { AccountAvailabilityMonitor } from "./routing/account-availability";

function provider(input: {
	id: string;
	model: string;
	local?: boolean;
	capabilities?: Record<string, number>;
	tools?: boolean;
	contextWindow?: number;
	reasoningLevels?: boolean;
	fastMode?: boolean;
	cost?: {
		inputPerMillion?: number;
		outputPerMillion?: number;
		fixedRequestCost?: number;
		priorityMultiplier?: number;
	};
	latency?: {
		averageMs?: number;
		p95Ms?: number;
	};
}): ModelProvider {
	return {
		id: input.id,
		defaultModel: input.model,
		capabilities: {
			streaming: true,
			tools: input.tools ?? true,
			images: false,
			audio: false,
			documents: false,
			local: input.local ?? false,
		},
		profileHints: {
			...(input.capabilities ? { capabilities: input.capabilities } : {}),
			limits: { contextWindow: input.contextWindow ?? 128_000 },
			features: {
				structuredOutput: input.tools ?? true,
				reasoningLevels: input.reasoningLevels ?? false,
				fastMode: input.fastMode ?? false,
			},
			...(input.cost ? { cost: input.cost } : {}),
			...(input.latency ? { latency: input.latency } : {}),
		},
		complete: async (request) => ({
			providerId: input.id,
			model: request.model,
			text: "done",
			toolCalls: [],
			usage: { inputTokens: 1, outputTokens: 1 },
			finishReason: "stop",
		}),
	};
}

function fixture(providers: ModelProvider[]) {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const registry = new ModelRegistry(
		database,
		providers,
		[],
		() => new Date("2026-07-29T12:00:00.000Z"),
	);
	const costs: Record<string, number> = {
		cheap: 0.001,
		strong: 0.2,
		external: 0.05,
		local: 0,
	};
	const router = new AdaptiveModelRouter(
		database,
		registry,
		(providerId) => costs[providerId] ?? 0.01,
		() => true,
		() => new Date("2026-07-29T12:00:00.000Z"),
	);
	return {
		database,
		registry,
		router,
		analyzer: new TaskRequirementAnalyzer(),
	};
}

describe("adaptive model orchestration", () => {
	it("does not automatically route to an unavailable account model", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const unavailable: ModelProvider = {
			id: "openai-account-a",
			poolId: "openai",
			account: {
				id: "account-a",
				providerId: "openai",
				displayName: "Account A",
				authTransport: "api_key",
				enabled: true,
			},
			defaultModel: "fallback-a",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			discoverModels: async () => [
				{
					id: "blocked-model",
					availability: "unavailable",
					source: "provider_api",
					capabilities: {
						capabilityProvenance: "confirmed",
						tools: true,
						structuredOutput: true,
					},
				},
			],
			complete: async (request) => ({
				providerId: "openai-account-a",
				model: request.model,
				text: "ok",
				toolCalls: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				finishReason: "stop",
			}),
		};
		const available: ModelProvider = {
			...unavailable,
			id: "openai-account-b",
			account: { ...unavailable.account!, id: "account-b", displayName: "Account B" },
			discoverModels: async () => [
				{
					id: "available-model",
					availability: "available",
					source: "provider_api",
					capabilities: {
						capabilityProvenance: "confirmed",
						tools: true,
						structuredOutput: true,
					},
				},
			],
		};
		const catalog = new ModelCatalog(database, [unavailable, available]);
		await catalog.refresh([unavailable, available]);
		const registry = new ModelRegistry(database, [unavailable, available], [], undefined, catalog);
		const router = new AdaptiveModelRouter(database, registry, () => 0);
		const requirements = new TaskRequirementAnalyzer().analyze(
			"available-only",
			"Summarize this small note.",
		);

		expect(router.route(requirements, { role: "worker" }).endpointId).toBe(
			"openai-account-b",
		);
		database.close();
	});

	it("routes plain text through a discovery-only model without claiming features", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const endpoint: ModelProvider = {
			id: "openai-discovery-only",
			poolId: "openai",
			account: {
				id: "account-a",
				providerId: "openai",
				displayName: "Personal",
				authTransport: "api_key",
				enabled: true,
			},
			defaultModel: "configured-default",
			capabilities: {
				streaming: true,
				tools: true,
				images: true,
				audio: false,
				documents: false,
				local: false,
			},
			discoverModels: async () => [
				{
					id: "advertised-only",
					availability: "available",
					source: "provider_api",
					capabilities: { capabilityProvenance: "unknown" },
				},
			],
			complete: async (request) => ({
				providerId: "openai-discovery-only",
				model: request.model,
				text: "ok",
				toolCalls: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				finishReason: "stop",
			}),
		};
		const catalog = new ModelCatalog(database, [endpoint]);
		await catalog.refresh([endpoint]);
		const registry = new ModelRegistry(database, [endpoint], [], undefined, catalog);
		const router = new AdaptiveModelRouter(database, registry, () => 0);

		expect(
			router.route(
				new TaskRequirementAnalyzer().analyze(
					"unknown-capabilities",
					"Summarize this small note.",
				),
				{ role: "worker" },
			).endpointId,
		).toBe("openai-discovery-only");
		expect(() =>
			router.route(
				new TaskRequirementAnalyzer().analyze(
					"unknown-capabilities-tools",
					"Use tools to inspect the repository.",
				),
				{ role: "worker" },
			),
		).toThrow("No configured model satisfies");
		database.close();
	});

	it("rotates equally ranked account endpoints in balanced mode", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const accounts: ModelProvider[] = ["a", "b", "c", "d"].map((suffix) => ({
			id: `codex-account-${suffix}`,
			poolId: "codex",
			account: {
				id: `account-${suffix}`,
				providerId: "codex",
				displayName: `Account ${suffix}`,
				authTransport: "oauth",
				enabled: true,
			},
			defaultModel: "gpt-catalog",
			capabilities: {
				streaming: true,
				tools: false,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			profileHints: {
				features: { structuredOutput: false, reasoningLevels: true },
			},
			discoverModels: async () => [
				{
					id: "gpt-catalog",
					availability: "available",
					source: "protocol",
					capabilities: {
						capabilityProvenance: "confirmed",
						streaming: true,
						tools: false,
						images: false,
						audio: false,
						documents: false,
						structuredOutput: false,
						reasoningEfforts: ["low", "high"],
					},
				},
			],
			complete: async (request) => ({
				providerId: `codex-account-${suffix}`,
				model: request.model,
				text: "ok",
				toolCalls: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				finishReason: "stop",
			}),
		}));
		const catalog = new ModelCatalog(database, accounts);
		await catalog.refresh(accounts);
		const registry = new ModelRegistry(database, accounts, [], undefined, catalog);
		const router = new AdaptiveModelRouter(database, registry, () => 0);
		const requirements = new TaskRequirementAnalyzer().analyze(
			"account-rotation",
			"Summarize this small note.",
		);

		expect(
			Array.from({ length: 5 }, () =>
				router.route(requirements, { role: "worker" }).endpointId,
			),
		).toEqual([
			"codex-account-a",
			"codex-account-b",
			"codex-account-c",
			"codex-account-d",
			"codex-account-a",
		]);
		database.close();
	});

	it("does not automatically route through an unverified fallback model", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const endpoint: ModelProvider = {
			...provider({ id: "fallback-only", model: "configured-default" }),
			account: {
				id: "fallback-account",
				providerId: "openai-compatible",
				displayName: "Fallback account",
				authTransport: "api_key",
				enabled: true,
			},
		};
		const catalog = new ModelCatalog(database, [endpoint]);
		const registry = new ModelRegistry(database, [endpoint], [], undefined, catalog);
		const router = new AdaptiveModelRouter(database, registry, () => 0);

		expect(catalog.modelsForEndpoint("fallback-only")).toMatchObject([
			{ availability: "unknown", discoverySource: "fallback" },
		]);
		expect(() =>
			router.route(
				new TaskRequirementAnalyzer().analyze(
					"fallback-only",
					"Summarize this small note.",
				),
				{ role: "worker" },
			),
		).toThrow("No configured model satisfies");
		database.close();
	});

	it("does not synthesize a default model for an empty dynamic catalog", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const endpoint: ModelProvider = {
			id: "dynamic-empty",
			poolId: "custom",
			account: {
				id: "dynamic-empty",
				providerId: "custom",
				displayName: "Empty dynamic account",
				authTransport: "api_key",
				enabled: true,
			},
			defaultModel: "should-not-appear",
			capabilities: {
				streaming: true,
				tools: true,
				images: false,
				audio: false,
				documents: false,
				local: false,
			},
			discoverModels: async () => [],
			complete: async (request) => ({
				providerId: "dynamic-empty",
				model: request.model,
				text: "ok",
				toolCalls: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				finishReason: "stop",
			}),
		};
		const catalog = new ModelCatalog(database, [endpoint]);
		const registry = new ModelRegistry(database, [endpoint], [], undefined, catalog);
		expect(registry.list()).toEqual([]);
		await catalog.refresh([endpoint]);
		registry.syncProviderCatalog([endpoint], catalog);
		expect(registry.list()).toEqual([]);
		database.close();
	});

	it("falls back to the default policy when persisted routing state is malformed", () => {
		const item = fixture([provider({ id: "local", model: "private" })]);
		item.database.setPrivateState("orchestration.routing-policy.v1", {
			mode: "unsupported",
		});

		expect(item.router.policy()).toMatchObject({
			mode: "balanced",
			maximumParallelism: 4,
			maximumRetries: 2,
		});
		expect(
			item.router.route(
				item.analyzer.analyze("recovery", "Summarize this note."),
				{ role: "worker" },
			).selectedModelId,
		).toBe("local:private");
		item.database.close();
	});

	it("routes simple verifiable work to the cheaper adequate endpoint", () => {
		const item = fixture([
			provider({
				id: "cheap",
				model: "small",
				capabilities: {
					technical_writing: 0.82,
					instruction_following: 0.84,
					reliability: 0.85,
					speed: 0.95,
					cost_efficiency: 0.98,
				},
				fastMode: true,
			}),
			provider({
				id: "strong",
				model: "large",
				capabilities: {
					technical_writing: 0.94,
					instruction_following: 0.95,
					reliability: 0.94,
					complex_reasoning: 0.98,
				},
				reasoningLevels: true,
			}),
		]);
		const requirements = item.analyzer.analyze(
			"simple",
			"Format this short technical note as a clear README.",
		);
		const decision = item.router.route(requirements, { role: "worker" });
		expect(decision).toMatchObject({
			selectedModelId: "cheap:small",
			providerId: "cheap",
			reasoningLevel: "low",
			fastMode: true,
		});
		expect(decision.reasons.join(" ")).not.toMatch(/chain.of.thought/i);
		item.database.close();
	});

	it("routes around a scarce account while retaining account-safe candidate evidence", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const premium = {
			...provider({
				id: "premium-account",
				model: "premium-reasoner",
				capabilities: {
					technical_writing: 0.98,
					instruction_following: 0.98,
					reliability: 0.96,
				},
			}),
			poolId: "example-provider",
			account: {
				id: "premium-account-id",
				providerId: "example-provider",
				displayName: "Premium workspace",
				authTransport: "api_key" as const,
				enabled: true,
			},
		};
		const healthy = {
			...provider({
				id: "healthy-account",
				model: "steady-reasoner",
				capabilities: {
					technical_writing: 0.87,
					instruction_following: 0.88,
					reliability: 0.89,
				},
			}),
			poolId: "example-provider",
			account: {
				id: "healthy-account-id",
				providerId: "example-provider",
				displayName: "Steady workspace",
				authTransport: "api_key" as const,
				enabled: true,
			},
		};
		const registry = new ModelRegistry(database, [premium, healthy]);
		const availability = new AccountAvailabilityMonitor(
			() => new Date("2026-07-29T12:00:00.000Z"),
		);
		availability.sync({
			profiles: registry.list(),
			providerHealth: [
				{
					providerId: premium.id,
					poolId: premium.poolId,
					attempts: 4,
					successes: 4,
					failures: 0,
					consecutiveFailures: 0,
					averageLatencyMs: 400,
					activeRequests: 0,
				},
				{
					providerId: healthy.id,
					poolId: healthy.poolId,
					attempts: 4,
					successes: 4,
					failures: 0,
					consecutiveFailures: 0,
					averageLatencyMs: 400,
					activeRequests: 0,
				},
			],
		});
		availability.applyQuotaUpdate({
			endpointId: premium.id,
			confidence: "exact",
			remainingFraction: 0.02,
		});
		const router = new AdaptiveModelRouter(
			database,
			registry,
			() => 0.01,
			() => true,
			() => new Date("2026-07-29T12:00:00.000Z"),
			availability,
		);
		const decision = router.route(
			new TaskRequirementAnalyzer().analyze(
				"account-scarcity",
				"Rewrite this short technical note clearly.",
			),
			{ role: "worker" },
		);
		expect(decision.endpointId).toBe("healthy-account");
		expect(decision.accountAlias).toBe("Steady workspace");
		const candidates = router.traces().at(-1)?.candidates ?? [];
		expect(candidates.find((candidate) => candidate.endpointId === premium.id))
			.toMatchObject({ scarcityPenalty: expect.any(Number), accountAlias: "Premium workspace" });
		expect(
			candidates.find((candidate) => candidate.endpointId === premium.id)
				?.scarcityPenalty,
		).toBeGreaterThan(0);
		database.close();
	});

	it("uses a stronger reasoning endpoint for complex high-impact architecture", () => {
		const item = fixture([
			provider({
				id: "cheap",
				model: "small",
				capabilities: {
					backend_architecture: 0.42,
					complex_reasoning: 0.38,
					reliability: 0.75,
				},
			}),
			provider({
				id: "strong",
				model: "large",
				capabilities: {
					backend_architecture: 0.98,
					complex_reasoning: 0.98,
					planning: 0.96,
					reliability: 0.96,
				},
				reasoningLevels: true,
			}),
		]);
		const requirements = item.analyzer.analyze(
			"architecture",
			"Design and implement a production security architecture, database migration, API boundary, validation plan, and coordinated rollout across multiple systems.",
		);
		const decision = item.router.route(requirements, { role: "orchestrator" });
		expect(decision.selectedModelId).toBe("strong:large");
		expect(["high", "xhigh", "max"]).toContain(decision.reasoningLevel);
		expect(decision.settings.reviewRequired).toBe(true);
		expect(decision.settings.parallelism).toBeGreaterThan(1);
		item.database.close();
	});

	it("enforces privacy, feature, and context requirements before scoring", () => {
		const item = fixture([
			provider({
				id: "local",
				model: "private",
				local: true,
				tools: true,
				contextWindow: 64_000,
				capabilities: { coding: 0.78, reliability: 0.82 },
			}),
			provider({
				id: "external",
				model: "remote",
				tools: false,
				contextWindow: 256_000,
				capabilities: { coding: 0.98, reliability: 0.98 },
			}),
		]);
		item.router.setPolicy({
			...item.router.policy(),
			mode: "privacy_first",
			allowExternal: true,
		});
		const requirements = item.analyzer.analyze(
			"private-code",
			"Inspect the repository and implement this code change.",
			{ requiresTools: true },
		);
		expect(
			item.router.route(requirements, { role: "worker" }).selectedModelId,
		).toBe("local:private");
		item.database.close();
	});

	it("keeps a privacy-first global policy closed to external local-first wording", () => {
		const item = fixture([
			provider({ id: "local", model: "private", local: true }),
		]);
		const policy = item.router.setPolicy({
			...item.router.policy(),
			allowExternal: false,
			mode: "privacy_first",
		});
		expect(
			item.analyzer.routingPolicy(
				"Use local models unless quality would suffer.",
				policy,
			),
		).toMatchObject({
			mode: "local_first",
			allowExternal: false,
			preferLocal: true,
		});
		item.database.close();
	});

	it("keeps the selected model mapping when a fallback shares its endpoint", () => {
		const item = fixture([provider({ id: "shared", model: "selected" })]);
		const selected = item.registry.get("shared:selected");
		item.registry.register({
			...selected,
			id: "shared:fallback",
			model: "fallback",
			displayName: "fallback",
		});
		const decision = item.router.route(
			item.analyzer.analyze("mapping", "Review this implementation."),
			{ role: "worker" },
		);
		const plan = item.router.executionPlan({
			...decision,
			selectedModelId: "shared:selected",
			model: "selected",
			fallbackModelIds: ["shared:fallback"],
		});
		expect(plan).toEqual({
			model: "selected",
			providerIds: ["shared"],
			providerModels: { shared: "selected" },
		});
		item.database.close();
	});

	it("applies local preference independently of the routing mode", () => {
		const item = fixture([
			provider({
				id: "local",
				model: "private",
				local: true,
				capabilities: { coding: 0.72, reliability: 0.8 },
			}),
			provider({
				id: "external",
				model: "remote",
				capabilities: { coding: 0.98, reliability: 0.8 },
			}),
		]);
		const policy = item.analyzer.routingPolicy(
			"Prefer local models and keep this under $1.",
			item.router.policy(),
		);
		expect(policy).toMatchObject({ mode: "custom_budget", preferLocal: true });
		expect(
			item.router.route(
				item.analyzer.analyze(
					"local-preference",
					"Implement this code change.",
				),
				{ role: "worker", policy },
			).selectedModelId,
		).toBe("local:private");
		item.database.close();
	});

	it("uses conservative defaults for unknown latency and partial price data", () => {
		const item = fixture([provider({ id: "external", model: "remote" })]);
		const requirements = item.analyzer.analyze(
			"limits",
			"Summarize this note.",
		);
		expect(() =>
			item.router.route(requirements, {
				role: "worker",
				policy: { ...item.router.policy(), maximumLatencyMs: 2_000 },
			}),
		).toThrow("latency limits");

		const priced = fixture([provider({ id: "priced", model: "remote" })]);
		const decision = priced.router.route(
			priced.analyzer.analyze("price", "Summarize this note."),
			{ role: "worker" },
		);
		expect(decision.estimatedCost).toBeCloseTo(0.02, 8);
		item.database.close();
		priced.database.close();
	});

	it("disables priority mode for budget policies and prices priority execution", () => {
		const item = fixture([
			provider({
				id: "priority",
				model: "fast",
				fastMode: true,
				cost: {
					inputPerMillion: 1,
					outputPerMillion: 1,
					priorityMultiplier: 2,
				},
			}),
		]);
		const requirements = item.analyzer.analyze(
			"priority",
			"Finish this quickly.",
		);
		const balanced = item.router.route(requirements, { role: "worker" });
		expect(balanced.fastMode).toBe(true);
		expect(balanced.estimatedCost).toBeCloseTo(0.006, 8);
		const cheapest = item.router.route(requirements, {
			role: "worker",
			policy: { ...item.router.policy(), mode: "cheapest" },
		});
		expect(cheapest.fastMode).toBe(false);
		expect(cheapest.estimatedCost).toBeCloseTo(0.003, 8);
		const budgeted = item.router.route(requirements, {
			role: "worker",
			policy: {
				...item.router.policy(),
				mode: "custom_budget",
				maximumTaskCostUsd: 1,
			},
		});
		expect(budgeted.fastMode).toBe(false);
		expect(budgeted.estimatedCost).toBeCloseTo(0.003, 8);
		item.database.close();
	});

	it("learns from corrections and reranks models for the affected capability", () => {
		const item = fixture([
			provider({
				id: "cheap",
				model: "alpha",
				capabilities: { frontend_implementation: 0.86, reliability: 0.86 },
			}),
			provider({
				id: "external",
				model: "beta",
				capabilities: { frontend_implementation: 0.84, reliability: 0.86 },
			}),
		]);
		const requirements = item.analyzer.analyze(
			"frontend",
			"Implement a responsive React frontend component.",
		);
		expect(
			item.router.route(requirements, { role: "worker" }).selectedModelId,
		).toBe("cheap:alpha");
		for (let index = 0; index < 5; index += 1) {
			item.registry.recordOutcome({
				modelId: "cheap:alpha",
				capabilities: { frontend_implementation: 1 },
				succeeded: false,
				validationPassed: false,
				rewritten: true,
				observedAt: "2026-07-29T12:00:00.000Z",
			});
			item.registry.recordOutcome({
				modelId: "external:beta",
				capabilities: { frontend_implementation: 1 },
				succeeded: true,
				validationPassed: true,
				reviewerConfidence: 0.96,
				observedAt: "2026-07-29T12:00:00.000Z",
			});
		}
		expect(
			item.router.route(requirements, { role: "worker" }).selectedModelId,
		).toBe("external:beta");
		expect(item.registry.get("cheap:alpha").observations).toBe(5);
		item.database.close();
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"fails closed on malformed reviewer confidence: %s",
		(reviewerConfidence) => {
			const item = fixture([provider({ id: "cheap", model: "one" })]);

			expect(() =>
				item.registry.recordOutcome({
					modelId: "cheap:one",
					capabilities: { coding: 1 },
					succeeded: true,
					validationPassed: true,
					reviewerConfidence,
					observedAt: "2026-07-29T12:00:00.000Z",
				}),
			).not.toThrow();
			expect(item.registry.get("cheap:one").observations).toBe(1);
			item.database.close();
		},
	);

	it("stores concise inspectable traces with bounded fallbacks", () => {
		const item = fixture([
			provider({ id: "cheap", model: "one" }),
			provider({ id: "strong", model: "two" }),
			provider({ id: "external", model: "three" }),
			provider({ id: "more", model: "four" }),
		]);
		const decision = item.router.route(
			item.analyzer.analyze("trace", "Review this implementation."),
			{ role: "reviewer" },
		);
		const trace = item.router.traces()[0]!;
		expect(trace).toMatchObject({
			taskId: "trace",
			status: "planned",
			decisions: [{ id: decision.id, role: "reviewer" }],
		});
		expect(trace.decisions[0]?.fallbackModelIds).toHaveLength(2);
		item.database.close();
	});

	it("keeps routing traces profile-only when a prompt contains sensitive text", () => {
		const item = fixture([provider({ id: "safe", model: "one" })]);
		const secret = "sk-routing-private-token";
		item.router.route(
			item.analyzer.analyze(
				"private-trace",
				`Implement this change. Never retain ${secret} in routing diagnostics.`,
			),
			{ role: "worker" },
		);
		const trace = item.router.traces()[0]!;

		expect(trace.summary).toMatch(/task; .* risk; difficulty/i);
		expect(JSON.stringify(trace)).not.toContain(secret);
		expect(
			JSON.stringify(
				item.database.getPrivateState("orchestration.routing-traces.v1"),
			),
		).not.toContain(secret);
		item.database.close();
	});

	it("rejects known secret-like provider preferences before policy can be persisted", () => {
		const item = fixture([provider({ id: "safe", model: "one" })]);
		for (const identifier of [
			"sk-private-routing-token",
			`ghp_${"a".repeat(36)}`,
			`xoxb-${"a".repeat(24)}`,
			`AKIA${"A".repeat(16)}`,
			`AIza${"a".repeat(35)}`,
		]) {
			expect(
				RoutingPolicySchema.safeParse({
					...item.router.policy(),
					preferredProviderIds: [identifier],
				}).success,
			).toBe(false);
		}
		item.database.close();
	});

	it("omits unsafe account identifiers and aliases from routing traces", () => {
		for (const unsafeAccountId of [
			"owner@example.com",
			`ghp_${"a".repeat(36)}`,
		]) {
			const item = fixture([
				{
					...provider({ id: "account-endpoint", model: "one" }),
					poolId: "openai",
					account: {
						id: unsafeAccountId,
						providerId: "openai",
						displayName: unsafeAccountId,
						authTransport: "api_key",
						enabled: true,
					},
				},
			]);

			const decision = item.router.route(
				item.analyzer.analyze("unsafe-account", "Summarize this note."),
				{ role: "worker" },
			);
			const trace = item.router.traces()[0]!;

			expect(decision.accountId).toBeUndefined();
			expect(decision.accountAlias).toBeUndefined();
			expect(JSON.stringify(trace)).not.toContain(unsafeAccountId);
			expect(
				JSON.stringify(
					item.database.getPrivateState("orchestration.routing-traces.v1"),
				),
			).not.toContain(unsafeAccountId);
			item.database.close();
		}
	});

	it("rejects unsafe routing profile metadata before it can reach traces", () => {
		const item = fixture([provider({ id: "safe", model: "one" })]);
		const profile = item.registry.get("safe:one");
		for (const unsafe of [
			"owner@example.com",
			"https://provider.example/v1",
			`ghp_${"a".repeat(36)}`,
		]) {
			expect(
				ModelProfileSchema.safeParse({
					...profile,
					accountAlias: unsafe,
				}).success,
			).toBe(false);
			expect(
				ModelProfileSchema.safeParse({
					...profile,
					endpointId: unsafe,
				}).success,
			).toBe(false);
		}
		const unsafeDatabase = new KestrelDatabase(":memory:", createEncryptionKey());
		expect(
			new ModelRegistry(unsafeDatabase, [
				provider({
					id: "https://provider.example/v1",
					model: `ghp_${"a".repeat(36)}`,
				}),
			]).list(),
		).toEqual([]);
		unsafeDatabase.close();
		item.database.close();
	});

	it("does not allow caller task IDs or event text to become trace content", () => {
		const item = fixture([provider({ id: "safe", model: "one" })]);
		const secret = `ghp_${"a".repeat(36)}`;
		expect(() => item.analyzer.analyze("owner@example.com", "Summarize this note.")).toThrow(
			/opaque, non-secret identifier/i,
		);
		item.router.route(
			item.analyzer.analyze("safe-task", "Summarize this note."),
			{ role: "worker" },
		);
		const trace = item.router.traces()[0]!;
		Reflect.apply(item.router.recordTraceEvent, item.router, [
			trace.id,
			"ROUTE_RETRIED",
			secret,
		]);
		const updated = item.router.traces()[0]!;
		expect(updated.events?.at(-1)).toMatchObject({
			type: "ROUTE_RETRIED",
			message: "Retried execution after a normalized transient signal.",
		});
		expect(JSON.stringify(updated)).not.toContain(secret);
		item.database.close();
	});

	it("translates natural language preferences into task-scoped policy", () => {
		const item = fixture([
			provider({ id: "local", model: "private", local: true }),
		]);
		const localFirst = item.analyzer.routingPolicy(
			"Use local models unless quality would suffer and keep this under $1.",
			item.router.policy(),
		);
		expect(localFirst).toMatchObject({
			mode: "custom_budget",
			maximumTaskCostUsd: 1,
			preferLocal: true,
			allowExternal: true,
		});
		expect(
			item.analyzer.routingPolicy(
				"Use the best models available.",
				item.router.policy(),
			).mode,
		).toBe("best_quality");
		item.database.close();
	});

	it("accurately classifies model tiers and constructs multi-tier fallback ladders", () => {
		const frontierProvider = provider({
			id: "anthropic",
			model: "claude-3-7-sonnet",
			capabilities: { complex_reasoning: 0.98, coding: 0.96 },
			reasoningLevels: true,
		});
		const advancedProvider = provider({
			id: "openai",
			model: "gpt-4o",
			capabilities: { complex_reasoning: 0.88, coding: 0.88 },
		});
		const standardProvider = provider({
			id: "groq",
			model: "gpt-oss-20b",
			capabilities: { speed: 0.95, cost_efficiency: 0.95 },
			fastMode: true,
		});
		const permissiveFallback = provider({
			id: "nous",
			model: "step-3.7-flash",
			capabilities: { complex_reasoning: 0.85, coding: 0.85 },
		});
		const localProvider = provider({
			id: "ollama",
			model: "llama3.3",
			local: true,
		});

		const item = fixture([
			frontierProvider,
			advancedProvider,
			standardProvider,
			permissiveFallback,
			localProvider,
		]);

		const frontierProfile = item.registry.get("anthropic:claude-3-7-sonnet");
		expect(frontierProfile.tier).toBe("frontier");

		const advancedProfile = item.registry.get("openai:gpt-4o");
		expect(advancedProfile.tier).toBe("advanced");

		const standardProfile = item.registry.get("groq:gpt-oss-20b");
		expect(standardProfile.tier).toBe("standard");

		const permissiveProfile = item.registry.get("nous:step-3.7-flash");
		expect(permissiveProfile.tier).toBe("permissive_fallback");

		const localProfile = item.registry.get("ollama:llama3.3");
		expect(localProfile.tier).toBe("local_private");

		const requirements = item.analyzer.analyze(
			"security-audit",
			"Perform a security vulnerability assessment, exploit analysis, and hardening review of this kernel driver.",
		);
		expect(requirements.isSecurityOrAdminAudit).toBe(true);

		const decision = item.router.route(requirements, { role: "worker" });
		expect(decision.selectedModelId).toBe("anthropic:claude-3-7-sonnet");
		expect(decision.tier).toBe("frontier");
		expect(decision.reasoningLevel).toBe("high");
		expect(decision.fallbackModelIds.length).toBeGreaterThanOrEqual(2);

		item.database.close();
	});

	it("detects model refusals accurately from stop reasons, error messages, and semantic text patterns", () => {
		// 1. Finish reason refusal
		expect(
			detectModelRefusal({ finishReason: "refusal", text: "" }).refused,
		).toBe(true);
		expect(
			detectModelRefusal({ finishReason: "refusal", text: "" }).safetyPolicy,
		).toBe(true);

		// 2. Semantic text refusal
		expect(
			detectModelRefusal({
				finishReason: "stop",
				text: "I cannot fulfill this request because it violates safety policies.",
			}).safetyPolicy,
		).toBe(true);

		expect(
			detectModelRefusal({
				finishReason: "stop",
				text: "I apologize, but I am unable to assist with generating exploit code.",
			}).refused,
		).toBe(true);

		expect(
			detectModelRefusal({
				finishReason: "stop",
				text: "As an AI assistant, I cannot provide code for malicious purposes.",
			}).refused,
		).toBe(true);

		// 3. Provider safety error message
		expect(
			detectModelRefusal(
				{ text: "" },
				"Request blocked by safety moderation filters.",
			).refused,
		).toBe(true);

		// 4. Benign response containing 'cannot find file'
		expect(
			detectModelRefusal({
				finishReason: "stop",
				text: "I checked the repository, but cannot find the file `config.json` in the root directory. Let me inspect `src/`.",
			}).refused,
		).toBe(false);

		// 5. Tool call response is not a refusal
		expect(
			detectModelRefusal({
				finishReason: "tool_calls",
				toolCalls: [{ id: "c1", name: "read_file", arguments: {} }],
				text: "",
			}).refused,
		).toBe(false);
	});

	it("reframes prompts with defensive execution context for prompt neutrality", () => {
		const originalMessages = [
			{ role: "system" as const, content: [{ type: "text" as const, text: "Base agent instructions." }] },
			{ role: "user" as const, content: [{ type: "text" as const, text: "Analyze this vulnerability." }] },
		];

		const reframed = reframePromptForNeutrality(originalMessages);
		expect(reframed[0]?.content[1]?.type).toBe("text");
		expect((reframed[0]?.content[1] as { text: string }).text).toMatch(/authorized development, diagnostic audit/i);
	});

	it("escalates reasoning levels dynamically upon refusal or validation retry", () => {
		const item = fixture([
			provider({
				id: "strong",
				model: "reasoner",
				capabilities: { complex_reasoning: 0.95, coding: 0.95 },
				reasoningLevels: true,
			}),
		]);

		const requirements = item.analyzer.analyze(
			"task-1",
			"Fix the bug in the authentication handler.",
		);

		const normalDecision = item.router.route(requirements, { role: "worker" });
		expect(normalDecision.reasoningLevel).toBe("medium");

		const escalatedDecision = item.router.route(requirements, {
			role: "fallback",
			escalationReason: "refusal",
		});
		expect(escalatedDecision.reasoningLevel).toBe("high");
		expect(escalatedDecision.refusalRecovery).toBe(true);

		item.database.close();
	});

	it("records refusal outcomes and adjusts refusalRate reliability metrics", () => {
		const item = fixture([
			provider({
				id: "standard",
				model: "chat",
				capabilities: { coding: 0.8 },
			}),
		]);

		item.registry.recordOutcome({
			modelId: "standard:chat",
			capabilities: { coding: 0.8 },
			succeeded: false,
			refused: true,
			refusalReason: "Semantic refusal",
			observedAt: "2026-07-29T12:00:00.000Z",
		});

		const profile = item.registry.get("standard:chat");
		expect(profile.reliability.refusalCount).toBe(1);
		expect(profile.reliability.refusalRate).toBeGreaterThan(0);

		item.database.close();
	});

	it("classifies current hosted models and ignores compact names as frontier", () => {
		const empty = {
			complex_reasoning: 0.5,
			coding: 0.5,
		} as Record<string, number>;
		expect(
			inferModelTier("gpt-5.6-terra", "openai", false, empty),
		).toBe("frontier");
		expect(
			inferModelTier("claude-opus-4-6", "anthropic", false, empty),
		).toBe("frontier");
		expect(
			inferModelTier("claude-sonnet-4-5", "anthropic", false, empty),
		).toBe("advanced");
		expect(
			inferModelTier("claude-haiku-4-5", "anthropic", false, empty),
		).toBe("standard");
		expect(inferModelTier("grok-3-mini", "xai", false, empty)).toBe("standard");
		expect(inferModelTier("llama3.3", "ollama", true, empty)).toBe(
			"local_private",
		);
	});

	it("does not treat everyday wording as research, tools, or code review", () => {
		const analyzer = new TaskRequirementAnalyzer();
		const weather = analyzer.analyze(
			"weather",
			"What's the latest weather in St. Louis?",
		);
		expect(weather.capabilities.research).toBeUndefined();
		expect(weather.capabilities.tool_use).toBeUndefined();
		expect(weather.complexity).toBeLessThan(0.3);
		expect(weather.riskLevel).toBe("read_only");

		const dining = analyzer.analyze(
			"dining",
			"Review this restaurant and tell me if I should go.",
		);
		expect(dining.capabilities.code_review).toBeUndefined();
		expect(dining.capabilities.coding).toBeUndefined();

		expect(
			analyzer.routingPolicy("Think hard about this.", {
				mode: "balanced",
				allowExternal: true,
				preferLocal: false,
				maximumParallelism: 4,
				maximumRetries: 2,
				maximumDelegationDepth: 3,
				maximumTaskDurationMs: 600_000,
				requireReviewAboveRisk: "sensitive",
			}).mode,
		).toBe("best_quality");
	});

	it("keeps trivial work off frontier models when a cheaper adequate model exists", () => {
		const item = fixture([
			provider({
				id: "strong",
				model: "gpt-5.6-terra",
				reasoningLevels: true,
			}),
			provider({
				id: "cheap",
				model: "small",
				capabilities: {
					technical_writing: 0.82,
					instruction_following: 0.84,
					reliability: 0.85,
					speed: 0.95,
					cost_efficiency: 0.98,
				},
				fastMode: true,
			}),
		]);
		const decision = item.router.route(
			item.analyzer.analyze("note", "Summarize this note."),
			{ role: "worker" },
		);
		expect(decision.selectedModelId).toBe("cheap:small");
		expect(decision.reasoningLevel).toBe("low");
		expect(decision.reasons.join(" ")).toMatch(/thinking to low/i);
		item.database.close();
	});
});
