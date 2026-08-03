import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { ModelProvider } from "./providers";
import {
  AdaptiveModelRouter,
  ModelRegistry,
  TaskRequirementAnalyzer,
} from "./model-orchestration";

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
  return { database, registry, router, analyzer: new TaskRequirementAnalyzer() };
}

describe("adaptive model orchestration", () => {
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
    expect(["high", "max"]).toContain(decision.reasoningLevel);
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
    expect(item.router.route(requirements, { role: "worker" }).selectedModelId)
      .toBe("local:private");
    item.database.close();
  });

  it("keeps a privacy-first global policy closed to external local-first wording", () => {
    const item = fixture([provider({ id: "local", model: "private", local: true })]);
    const policy = item.router.setPolicy({
      ...item.router.policy(),
      allowExternal: false,
      mode: "privacy_first",
    });
    expect(item.analyzer.routingPolicy(
      "Use local models unless quality would suffer.",
      policy,
    )).toMatchObject({
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
    expect(item.router.route(
      item.analyzer.analyze("local-preference", "Implement this code change."),
      { role: "worker", policy },
    ).selectedModelId).toBe("local:private");
    item.database.close();
  });

  it("uses conservative defaults for unknown latency and partial price data", () => {
    const item = fixture([provider({ id: "external", model: "remote" })]);
    const requirements = item.analyzer.analyze("limits", "Summarize this note.");
    expect(() => item.router.route(requirements, {
      role: "worker",
      policy: { ...item.router.policy(), maximumLatencyMs: 2_000 },
    })).toThrow("latency limits");

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
    const item = fixture([provider({
      id: "priority",
      model: "fast",
      fastMode: true,
      cost: { inputPerMillion: 1, outputPerMillion: 1, priorityMultiplier: 2 },
    })]);
    const requirements = item.analyzer.analyze("priority", "Finish this quickly.");
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
      policy: { ...item.router.policy(), mode: "custom_budget", maximumTaskCostUsd: 1 },
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
    expect(item.router.route(requirements, { role: "worker" }).selectedModelId)
      .toBe("cheap:alpha");
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
    expect(item.router.route(requirements, { role: "worker" }).selectedModelId)
      .toBe("external:beta");
    expect(item.registry.get("cheap:alpha").observations).toBe(5);
    item.database.close();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("fails closed on malformed reviewer confidence: %s", (reviewerConfidence) => {
    const item = fixture([provider({ id: "cheap", model: "one" })]);

    expect(() => item.registry.recordOutcome({
      modelId: "cheap:one",
      capabilities: { coding: 1 },
      succeeded: true,
      validationPassed: true,
      reviewerConfidence,
      observedAt: "2026-07-29T12:00:00.000Z",
    })).not.toThrow();
    expect(item.registry.get("cheap:one").observations).toBe(1);
    item.database.close();
  });

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

  it("translates natural language preferences into task-scoped policy", () => {
    const item = fixture([provider({ id: "local", model: "private", local: true })]);
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
});
