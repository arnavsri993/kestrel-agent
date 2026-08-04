import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import {
  ModelProfileSchema,
  RoutingDecisionSchema,
  RoutingPolicySchema,
  RoutingTraceSchema,
  type ModelCapability,
  type ModelProfile,
  type RiskLevel,
  type RoutingDecision,
  type RoutingPolicy,
  type RoutingTrace,
} from "@kestrel/shared-types";
import type { ModelProvider } from "./providers";

const CAPABILITIES: ModelCapability[] = [
  "complex_reasoning",
  "coding",
  "backend_architecture",
  "frontend_implementation",
  "ui_visual_design",
  "creative_writing",
  "technical_writing",
  "research",
  "long_context",
  "image_understanding",
  "tool_use",
  "planning",
  "debugging",
  "code_review",
  "mathematical_reasoning",
  "speed",
  "cost_efficiency",
  "reliability",
  "instruction_following",
  "structured_output",
];

const DEFAULT_POLICY: RoutingPolicy = RoutingPolicySchema.parse({
  mode: "balanced",
  allowExternal: true,
  preferLocal: false,
  maximumParallelism: 4,
  maximumRetries: 2,
  maximumDelegationDepth: 3,
  maximumTaskDurationMs: 600_000,
  requireReviewAboveRisk: "sensitive",
});

export interface TaskRequirements {
  taskId: string;
  summary: string;
  capabilities: Partial<Record<ModelCapability, number>>;
  riskLevel: RiskLevel;
  complexity: number;
  qualitySensitivity: number;
  latencySensitivity: number;
  contextCharacters: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  requiresTools: boolean;
  requiresVision: boolean;
  requiresStructuredOutput: boolean;
  parallelizable: boolean;
  creative: boolean;
}

export interface RoutingOutcome {
  modelId: string;
  capabilities: Partial<Record<ModelCapability, number>>;
  succeeded: boolean;
  validationPassed?: boolean;
  reviewerConfidence?: number;
  toolSuccessRate?: number;
  latencyMs?: number;
  actualCostUsd?: number;
  rewritten?: boolean;
  escalated?: boolean;
  observedAt: string;
}

export interface RouteOptions {
  role: RoutingDecision["role"];
  allowedProviderIds?: string[];
  excludeModelIds?: string[];
  parentTraceId?: string;
  policy?: RoutingPolicy;
}

function bounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function emptyScores(value = 0): Record<ModelCapability, number> {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, value])) as Record<ModelCapability, number>;
}

function riskRank(risk: RiskLevel): number {
  return ["read_only", "low", "external", "sensitive", "high_consequence"].indexOf(risk);
}

function estimatedLatencyMs(profile: ModelProfile): number {
  return profile.latency.p95Ms ?? profile.latency.averageMs ?? (profile.local ? 1_500 : 3_000);
}

function priorityEligible(
  profile: ModelProfile,
  requirements: TaskRequirements,
  policy: RoutingPolicy,
): boolean {
  return policy.mode !== "cheapest"
    && policy.mode !== "custom_budget"
    && profile.features.fastMode
    && requirements.latencySensitivity >= 0.7
    && requirements.riskLevel !== "high_consequence"
    && requirements.qualitySensitivity < 0.86;
}

function baselineCapabilities(provider: ModelProvider): Record<ModelCapability, number> {
  const scores = emptyScores(0.5);
  scores.speed = provider.capabilities.local ? 0.82 : 0.58;
  scores.cost_efficiency = provider.capabilities.local ? 0.95 : 0.5;
  scores.reliability = 0.65;
  scores.instruction_following = 0.62;
  scores.structured_output = provider.capabilities.tools ? 0.68 : 0.48;
  scores.tool_use = provider.capabilities.tools ? 0.75 : 0;
  scores.image_understanding = provider.capabilities.images ? 0.72 : 0;
  scores.long_context = provider.profileHints?.limits?.contextWindow
    ? bounded(provider.profileHints.limits.contextWindow / 200_000)
    : 0.55;
  for (const [capability, score] of Object.entries(provider.profileHints?.capabilities ?? {})) {
    if (CAPABILITIES.includes(capability as ModelCapability))
      scores[capability as ModelCapability] = bounded(score);
  }
  return scores;
}

function profileFromProvider(provider: ModelProvider): ModelProfile | undefined {
  if (!provider.defaultModel) return undefined;
  const capabilities = baselineCapabilities(provider);
  return ModelProfileSchema.parse({
    id: `${provider.id}:${provider.defaultModel}`,
    provider: provider.poolId ?? provider.id,
    endpointId: provider.id,
    model: provider.defaultModel,
    displayName: provider.profileHints?.displayName ?? provider.defaultModel,
    enabled: true,
    local: provider.capabilities.local,
    capabilities,
    cost: provider.profileHints?.cost ?? {},
    latency: provider.profileHints?.latency ?? {},
    limits: provider.profileHints?.limits ?? {},
    features: {
      tools: provider.capabilities.tools,
      vision: provider.capabilities.images,
      structuredOutput: provider.profileHints?.features?.structuredOutput ?? provider.capabilities.tools,
      reasoningLevels: provider.profileHints?.features?.reasoningLevels ?? false,
      fastMode: provider.profileHints?.features?.fastMode ?? false,
      streaming: provider.capabilities.streaming,
    },
    reliability: {},
    learnedPerformance: capabilities,
    observations: 0,
  });
}

export class ModelRegistry {
  private readonly key = "orchestration.model-registry.v1";
  private profiles = new Map<string, ModelProfile>();

  constructor(
    private readonly database: KestrelDatabase,
    providers: ModelProvider[],
    configuredProfiles: ModelProfile[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    const storedValue = database.getPrivateState<unknown>(this.key);
    const stored = Array.isArray(storedValue) ? storedValue : [];
    const storedById = new Map(stored.flatMap((profile) => {
      const parsed = ModelProfileSchema.safeParse(profile);
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : [];
    }));
    for (const provider of providers) {
      const discovered = profileFromProvider(provider);
      if (!discovered) continue;
      const learned = storedById.get(discovered.id);
      this.profiles.set(discovered.id, learned
        ? ModelProfileSchema.parse({
            ...discovered,
            learnedPerformance: learned.learnedPerformance,
            reliability: learned.reliability,
            observations: learned.observations,
            ...(learned.lastEvaluatedAt ? { lastEvaluatedAt: learned.lastEvaluatedAt } : {}),
          })
        : discovered);
    }
    for (const profile of configuredProfiles) {
      const parsed = ModelProfileSchema.parse(profile);
      const learned = storedById.get(parsed.id);
      this.profiles.set(parsed.id, learned
        ? ModelProfileSchema.parse({
            ...parsed,
            learnedPerformance: learned.learnedPerformance,
            reliability: learned.reliability,
            observations: learned.observations,
            ...(learned.lastEvaluatedAt ? { lastEvaluatedAt: learned.lastEvaluatedAt } : {}),
          })
        : parsed);
    }
    this.persist();
  }

  list(): ModelProfile[] {
    return [...this.profiles.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  get(id: string): ModelProfile {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Model profile ${id} is not registered.`);
    return profile;
  }

  register(profile: ModelProfile): ModelProfile {
    const parsed = ModelProfileSchema.parse(profile);
    this.profiles.set(parsed.id, parsed);
    this.persist();
    return parsed;
  }

  applyProviderHealth(health: Array<{ providerId: string; averageLatencyMs: number; attempts: number; successes: number }>): void {
    let changed = false;
    for (const [id, profile] of this.profiles) {
      const measurement = health.find((item) => item.providerId === profile.endpointId);
      if (!measurement || measurement.attempts === 0) continue;
      this.profiles.set(id, ModelProfileSchema.parse({
        ...profile,
        latency: { ...profile.latency, averageMs: measurement.averageLatencyMs },
        reliability: { ...profile.reliability, successRate: measurement.successes / measurement.attempts },
      }));
      changed = true;
    }
    if (changed) this.persist();
  }

  recordOutcome(outcome: RoutingOutcome): ModelProfile {
    const profile = this.get(outcome.modelId);
    const observations = profile.observations + 1;
    const learningRate = Math.max(0.08, Math.min(0.35, 2 / (observations + 4)));
    const quality = bounded(
      outcome.reviewerConfidence
      ?? (outcome.validationPassed === false ? 0.15 : outcome.succeeded ? 0.82 : 0.1),
    );
    const penalty = outcome.rewritten ? 0.18 : outcome.escalated ? 0.1 : 0;
    const learnedPerformance = { ...profile.learnedPerformance };
    for (const [capability, importance] of Object.entries(outcome.capabilities)) {
      if (!CAPABILITIES.includes(capability as ModelCapability) || importance === undefined || importance <= 0) continue;
      const previous = learnedPerformance[capability as ModelCapability] ?? profile.capabilities[capability as ModelCapability];
      const target = bounded(quality - penalty);
      learnedPerformance[capability as ModelCapability] = bounded(previous * (1 - learningRate) + target * learningRate);
    }
    const previousSuccess = profile.reliability.successRate ?? profile.capabilities.reliability;
    const successRate = bounded(previousSuccess * (1 - learningRate) + (outcome.succeeded ? 1 : 0) * learningRate);
    const updated = ModelProfileSchema.parse({
      ...profile,
      learnedPerformance,
      observations,
      latency: outcome.latencyMs === undefined
        ? profile.latency
        : {
            ...profile.latency,
            averageMs: profile.latency.averageMs === undefined
              ? outcome.latencyMs
              : Math.round(profile.latency.averageMs * 0.75 + outcome.latencyMs * 0.25),
          },
      reliability: {
        ...profile.reliability,
        successRate,
        ...(outcome.toolSuccessRate === undefined ? {} : { toolSuccessRate: bounded(outcome.toolSuccessRate) }),
      },
      lastEvaluatedAt: outcome.observedAt,
    });
    this.profiles.set(updated.id, updated);
    this.persist();
    return updated;
  }

  private persist(): void {
    this.database.setPrivateState(this.key, this.list());
  }
}

export class TaskRequirementAnalyzer {
  routingPolicy(prompt: string, base: RoutingPolicy): RoutingPolicy {
    const normalized = prompt.toLowerCase();
    const amount = normalized.match(
      /\b(?:under|below|no more than|budget(?: of)?)\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/,
    );
    let mode = base.mode;
    let allowExternal = base.allowExternal;
    let preferLocal = base.preferLocal;
    if (/\b(best models?|best quality|maximum quality|highest quality)\b/.test(normalized))
      mode = "best_quality";
    else if (/\b(as quickly as possible|fastest|finish quickly|prioritize speed)\b/.test(normalized))
      mode = "fastest";
    else if (/\b(cheapest|lowest cost|minimi[sz]e cost)\b/.test(normalized))
      mode = "cheapest";
    else if (/\b(maximum parallelism|parallelize as much as possible)\b/.test(normalized))
      mode = "maximum_parallelism";
    else if (/\b(local models? unless|local[- ]first|prefer local)\b/.test(normalized)) {
      mode = "local_first";
      allowExternal = base.allowExternal;
      preferLocal = true;
    } else if (/\b(local models? only|privacy[- ]first|do not send .* cloud)\b/.test(normalized)) {
      mode = "privacy_first";
      allowExternal = false;
      preferLocal = true;
    }
    if (amount) mode = "custom_budget";
    return RoutingPolicySchema.parse({
      ...base,
      mode,
      allowExternal,
      preferLocal,
      ...(amount ? { maximumTaskCostUsd: Number(amount[1]) } : {}),
    });
  }

  analyze(taskId: string, prompt: string, input: {
    riskLevel?: RiskLevel;
    requiresTools?: boolean;
    requiresVision?: boolean;
    requiresStructuredOutput?: boolean;
  } = {}): TaskRequirements {
    const normalized = prompt.toLowerCase();
    const words = prompt.trim().split(/\s+/).filter(Boolean).length;
    const capabilities: Partial<Record<ModelCapability, number>> = {
      instruction_following: 0.85,
      reliability: 0.72,
    };
    const mark = (capability: ModelCapability, score: number) => {
      capabilities[capability] = Math.max(capabilities[capability] ?? 0, score);
    };
    if (/\b(code|repository|typescript|javascript|python|api|test|refactor|debug|bug|implement)\b/.test(normalized)) mark("coding", 0.86);
    if (/\b(backend|database|schema|api|security|distributed|architecture)\b/.test(normalized)) mark("backend_architecture", 0.82);
    if (/\b(frontend|react|css|responsive|component|webpage|website)\b/.test(normalized)) mark("frontend_implementation", 0.82);
    if (/\b(ui|ux|visual|layout|design|figma|style|animation)\b/.test(normalized)) mark("ui_visual_design", 0.8);
    if (/\b(debug|root cause|failing test|regression)\b/.test(normalized)) mark("debugging", 0.9);
    if (/\b(review|audit|verify|critique|inspect)\b/.test(normalized)) mark("code_review", 0.82);
    if (/\b(research|search|sources|compare|latest|evidence)\b/.test(normalized)) mark("research", 0.82);
    if (/\b(write|copy|story|creative|narrative|brand)\b/.test(normalized)) mark("creative_writing", 0.72);
    if (/\b(documentation|technical writing|readme|specification|explain)\b/.test(normalized)) mark("technical_writing", 0.78);
    if (/\b(math|equation|proof|calculate|statistics|probability)\b/.test(normalized)) mark("mathematical_reasoning", 0.88);
    if (/\b(plan|coordinate|orchestrat|multiple|team|subtask|project)\b/.test(normalized)) mark("planning", 0.88);
    if (input.requiresTools || /\b(file|repository|browser|command|tool|git|deploy|publish)\b/.test(normalized)) mark("tool_use", 0.88);
    if (input.requiresVision || /\b(image|screenshot|photo|diagram|visual)\b/.test(normalized)) mark("image_understanding", 0.86);
    if (input.requiresStructuredOutput || /\b(json|schema|structured output|csv|table)\b/.test(normalized)) mark("structured_output", 0.86);
    const complexity = bounded(
      words / 700
      + (capabilities.coding ? 0.16 : 0)
      + (capabilities.backend_architecture ? 0.18 : 0)
      + (capabilities.planning ? 0.16 : 0)
      + (Object.keys(capabilities).length >= 6 ? 0.18 : 0),
    );
    if (complexity >= 0.55) mark("complex_reasoning", Math.max(0.7, complexity));
    if (prompt.length > 40_000) mark("long_context", bounded(prompt.length / 300_000 + 0.55));
    const highConsequence = /\b(production|deploy|publish|delete|payment|legal|medical|credential|security)\b/.test(normalized);
    const riskLevel = input.riskLevel ?? (highConsequence
      ? "high_consequence"
      : /\b(write|edit|change|create|run)\b/.test(normalized) ? "sensitive" : "read_only");
    const qualitySensitivity = bounded(
      0.42 + complexity * 0.42 + (riskLevel === "high_consequence" ? 0.24 : riskLevel === "sensitive" ? 0.08 : 0),
    );
    const distinctSpecialties = ["coding", "backend_architecture", "frontend_implementation", "ui_visual_design", "research", "technical_writing"]
      .filter((capability) => (capabilities[capability as ModelCapability] ?? 0) >= 0.7).length;
    return {
      taskId,
      summary: prompt.replace(/\s+/g, " ").trim().slice(0, 240) || "Agent task",
      capabilities,
      riskLevel,
      complexity,
      qualitySensitivity,
      latencySensitivity: words < 80 ? 0.78 : 0.42,
      contextCharacters: Math.max(24_000, prompt.length * 3),
      expectedInputTokens: Math.max(1_000, Math.ceil(prompt.length / 3.5)),
      expectedOutputTokens: complexity >= 0.75 ? 8_000 : complexity >= 0.45 ? 4_000 : 2_000,
      requiresTools: (capabilities.tool_use ?? 0) > 0,
      requiresVision: (capabilities.image_understanding ?? 0) > 0,
      requiresStructuredOutput: (capabilities.structured_output ?? 0) > 0,
      parallelizable: distinctSpecialties >= 2 && complexity >= 0.55,
      creative: (capabilities.creative_writing ?? 0) >= 0.7 || (capabilities.ui_visual_design ?? 0) >= 0.75,
    };
  }
}

interface ScoredProfile {
  profile: ModelProfile;
  score: number;
  estimatedCost: number;
  capabilityFit: number;
  reliability: number;
}

export class AdaptiveModelRouter {
  private readonly policyKey = "orchestration.routing-policy.v1";
  private readonly tracesKey = "orchestration.routing-traces.v1";

  constructor(
    private readonly database: KestrelDatabase,
    private readonly registry: ModelRegistry,
    private readonly estimateCost: (providerId: string, model: string, inputTokens: number, outputTokens: number) => number,
    private readonly providerAllowed: (providerId: string, endpointId: string) => boolean = () => true,
    private readonly now: () => Date = () => new Date(),
  ) {}

  policy(): RoutingPolicy {
    return RoutingPolicySchema.parse(this.database.getPrivateState<RoutingPolicy>(this.policyKey) ?? DEFAULT_POLICY);
  }

  setPolicy(policy: RoutingPolicy): RoutingPolicy {
    const parsed = RoutingPolicySchema.parse(policy);
    this.database.setPrivateState(this.policyKey, parsed);
    return parsed;
  }

  traces(): RoutingTrace[] {
    return (this.database.getPrivateState<RoutingTrace[]>(this.tracesKey) ?? [])
      .flatMap((trace) => {
        const parsed = RoutingTraceSchema.safeParse(trace);
        return parsed.success ? [parsed.data] : [];
      });
  }

  route(requirements: TaskRequirements, options: RouteOptions): RoutingDecision {
    const policy = RoutingPolicySchema.parse(options.policy ?? this.policy());
    const allowed = new Set(options.allowedProviderIds ?? []);
    const excluded = new Set(options.excludeModelIds ?? []);
    let candidates = this.registry.list().filter((profile) =>
      profile.enabled
      && !excluded.has(profile.id)
      && this.providerAllowed(profile.provider, profile.endpointId)
      && (allowed.size === 0 || allowed.has("auto") || allowed.has(profile.provider) || allowed.has(profile.endpointId))
      && (!requirements.requiresTools || profile.features.tools)
      && (!requirements.requiresVision || profile.features.vision)
      && (!requirements.requiresStructuredOutput || profile.features.structuredOutput)
      && (!profile.limits.contextWindow || profile.limits.contextWindow * 4 >= requirements.contextCharacters),
    );
    if (!policy.allowExternal) candidates = candidates.filter((profile) => profile.local);
    if ((policy.mode === "privacy_first" || policy.mode === "local_first" || policy.preferLocal) && candidates.some((profile) => profile.local)) {
      if (policy.mode === "privacy_first") candidates = candidates.filter((profile) => profile.local);
    }
    if (candidates.length === 0) throw new Error("No configured model satisfies the task features, context, provider policy, and privacy constraints.");
    const scored = candidates.map((profile) => this.score(profile, requirements, policy))
      .filter((candidate) => policy.maximumTaskCostUsd === undefined || candidate.estimatedCost <= policy.maximumTaskCostUsd)
      .filter((candidate) => policy.maximumLatencyMs === undefined || estimatedLatencyMs(candidate.profile) <= policy.maximumLatencyMs);
    if (scored.length === 0) throw new Error("No configured model fits the task budget and latency limits.");
    scored.sort((left, right) => right.score - left.score || left.estimatedCost - right.estimatedCost || left.profile.id.localeCompare(right.profile.id));
    const selected = scored[0]!;
    const second = scored[1];
    const confidence = bounded(0.5 + selected.capabilityFit * 0.28 + selected.reliability * 0.16 + Math.max(0, selected.score - (second?.score ?? 0)) * 0.2);
    const reasoningLevel = this.reasoningLevel(selected.profile, requirements);
    const reviewRequired = riskRank(requirements.riskLevel) >= riskRank(policy.requireReviewAboveRisk)
      || requirements.qualitySensitivity >= 0.86
      || confidence < 0.68;
    const selectedAt = this.now().toISOString();
    const reasons = [
      `${Math.round(selected.capabilityFit * 100)}% capability fit for the requested work.`,
      `${Math.round(selected.reliability * 100)}% current reliability estimate.`,
      selected.profile.local ? "Keeps this model step on the configured local endpoint." : "Uses a configured external endpoint because it offers the best policy-adjusted fit.",
      policy.mode === "balanced" ? "Balanced quality, reliability, latency, and cost." : `Applied the ${policy.mode.replaceAll("_", " ")} routing mode.`,
    ];
    const decision = RoutingDecisionSchema.parse({
      id: `route-${randomUUID()}`,
      taskId: requirements.taskId,
      selectedModelId: selected.profile.id,
      providerId: selected.profile.provider,
      endpointId: selected.profile.endpointId,
      model: selected.profile.model,
      role: options.role,
      reasoningLevel,
      fastMode: priorityEligible(selected.profile, requirements, policy),
      estimatedCost: selected.estimatedCost,
      confidence,
      reasons,
      fallbackModelIds: scored.slice(1, policy.maximumRetries + 1).map((item) => item.profile.id),
      validationStrategy: reviewRequired
        ? "Validate tool and structured outputs, run available deterministic checks, then use an independent reviewer route."
        : "Validate structured output and any available deterministic checks before accepting the result.",
      settings: {
        temperature: requirements.creative ? 0.65 : 0.2,
        maximumOutputTokens: Math.min(selected.profile.limits.maxOutputTokens ?? 16_384, requirements.expectedOutputTokens),
        maximumContextCharacters: Math.min(
          selected.profile.limits.contextWindow ? selected.profile.limits.contextWindow * 4 : 120_000,
          Math.max(24_000, requirements.contextCharacters),
        ),
        retryCount: Math.min(policy.maximumRetries, Math.max(0, scored.length - 1)),
        parallelism: requirements.parallelizable ? Math.min(policy.maximumParallelism, 4) : 1,
        reviewRequired,
      },
      selectedAt,
    });
    this.recordTrace(requirements, policy, decision, options.parentTraceId);
    return decision;
  }

  executionPlan(decision: RoutingDecision): {
    model: string;
    providerIds: string[];
    providerModels: Record<string, string>;
  } {
    const profiles = [decision.selectedModelId, ...decision.fallbackModelIds].map((id) => this.registry.get(id));
    return {
      model: decision.model,
      providerIds: [...new Set(profiles.map((profile) => profile.endpointId))],
      providerModels: profiles.reduce<Record<string, string>>((mapping, profile) => {
        if (mapping[profile.endpointId] === undefined)
          mapping[profile.endpointId] = profile.model;
        return mapping;
      }, {}),
    };
  }

  completeTrace(traceId: string, input: { status: RoutingTrace["status"]; actualCostUsd?: number; escalated?: boolean }): void {
    const traces = this.traces();
    const index = traces.findIndex((trace) => trace.id === traceId);
    const current = traces[index];
    if (!current) return;
    traces[index] = RoutingTraceSchema.parse({
      ...current,
      status: input.status,
      actualCostUsd: input.actualCostUsd ?? current.actualCostUsd,
      escalationCount: current.escalationCount + (input.escalated ? 1 : 0),
      updatedAt: this.now().toISOString(),
    });
    this.database.setPrivateState(this.tracesKey, traces.slice(-200));
  }

  private score(profile: ModelProfile, requirements: TaskRequirements, policy: RoutingPolicy): ScoredProfile {
    const weighted = Object.entries(requirements.capabilities).filter((entry): entry is [ModelCapability, number] => entry[1] !== undefined && entry[1] > 0);
    const importance = weighted.reduce((sum, [, weight]) => sum + weight, 0) || 1;
    const capabilityFit = weighted.reduce((sum, [capability, weight]) => {
      const baseline = profile.capabilities[capability] ?? 0;
      const learned = profile.learnedPerformance[capability] ?? baseline;
      const observed = profile.observations > 0 ? baseline * 0.55 + learned * 0.45 : baseline;
      return sum + observed * weight;
    }, 0) / importance;
    const reliability = profile.reliability.successRate ?? profile.capabilities.reliability;
    const latencyMs = estimatedLatencyMs(profile);
    const latencyScore = 1 / (1 + latencyMs / 4_000);
    const fallbackInputCost = this.estimateCost(
      profile.provider,
      profile.model,
      requirements.expectedInputTokens,
      0,
    );
    const fallbackOutputCost = this.estimateCost(
      profile.provider,
      profile.model,
      0,
      requirements.expectedOutputTokens,
    );
    const configuredTokenCost = (
      profile.cost.inputPerMillion === undefined
        ? fallbackInputCost
        : requirements.expectedInputTokens * profile.cost.inputPerMillion / 1_000_000
    ) + (
      profile.cost.outputPerMillion === undefined
        ? fallbackOutputCost
        : requirements.expectedOutputTokens * profile.cost.outputPerMillion / 1_000_000
    );
    const priorityCostMultiplier = profile.cost.priorityMultiplier ?? 1.5;
    const estimatedCost = configuredTokenCost * (priorityEligible(profile, requirements, policy) ? priorityCostMultiplier : 1)
      + (profile.cost.fixedRequestCost ?? 0);
    const costScore = 1 / (1 + estimatedCost * 20);
    const localScore = profile.local ? 1 : 0;
    const weightSets: Record<RoutingPolicy["mode"], readonly [number, number, number, number, number]> = {
      fastest: [0.3, 0.18, 0.42, 0.08, 0.02],
      cheapest: [0.3, 0.15, 0.05, 0.48, 0.02],
      balanced: [0.5, 0.22, 0.12, 0.12, 0.04],
      best_quality: [0.7, 0.22, 0.03, 0.03, 0.02],
      local_first: [0.34, 0.18, 0.08, 0.1, 0.3],
      privacy_first: [0.25, 0.15, 0.05, 0.05, 0.5],
      maximum_parallelism: [0.37, 0.18, 0.22, 0.18, 0.05],
      custom_budget: [0.42, 0.2, 0.08, 0.27, 0.03],
    };
    const weights = weightSets[policy.mode];
    const localPreferenceBonus = policy.preferLocal && profile.local ? 0.25 : 0;
    const score = capabilityFit * weights[0] + reliability * weights[1] + latencyScore * weights[2] + costScore * weights[3] + localScore * weights[4] + localPreferenceBonus;
    return { profile, score, estimatedCost, capabilityFit, reliability };
  }

  private reasoningLevel(
    profile: ModelProfile,
    requirements: TaskRequirements,
  ): RoutingDecision["reasoningLevel"] {
    if (!profile.features.reasoningLevels) return "low";
    if (requirements.riskLevel === "high_consequence" || requirements.complexity >= 0.92) return "max";
    if (requirements.complexity >= 0.7 || requirements.qualitySensitivity >= 0.86) return "high";
    if (requirements.complexity >= 0.4) return "medium";
    return "low";
  }

  private recordTrace(requirements: TaskRequirements, policy: RoutingPolicy, decision: RoutingDecision, parentTraceId?: string): void {
    const timestamp = this.now().toISOString();
    const trace = RoutingTraceSchema.parse({
      id: `trace-${randomUUID()}`,
      ...(parentTraceId ? { parentTraceId } : {}),
      taskId: requirements.taskId,
      summary: requirements.summary,
      status: "planned",
      policy,
      decisions: [decision],
      escalationCount: 0,
      estimatedCostUsd: decision.estimatedCost ?? 0,
      actualCostUsd: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const decisionWithTrace = { ...decision, traceId: trace.id };
    trace.decisions = [RoutingDecisionSchema.parse(decisionWithTrace)];
    this.database.setPrivateState(this.tracesKey, [...this.traces(), trace].slice(-200));
    Object.assign(decision, decisionWithTrace);
  }
}

export { DEFAULT_POLICY as DEFAULT_ROUTING_POLICY };
