import type { KestrelDatabase } from "@kestrel/database";
import { UsagePolicySchema, type UsagePolicy } from "@kestrel/shared-types";
import type { ModelUsage } from "./providers";

export const DEFAULT_USAGE_POLICY: UsagePolicy = UsagePolicySchema.parse({
  dailyBudgetUsd: 25,
  monthlyBudgetUsd: 250,
  perCallReservationUsd: 2,
  maximumConcurrentCalls: 4,
  defaultRate: { inputPerMillionUsd: 1, outputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.25, reasoningPerMillionUsd: 5 },
  rates: {}
});

export class UsageGovernor {
  private readonly key = "runtime.usage-policy";
  private activeCalls = 0;

  constructor(private readonly database: KestrelDatabase, private readonly now: () => Date = () => new Date()) {}

  getPolicy(): UsagePolicy {
    const stored = this.database.getPrivateState<unknown>(this.key);
    const parsed = UsagePolicySchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_USAGE_POLICY;
  }

  setPolicy(policy: UsagePolicy): UsagePolicy {
    const parsed = UsagePolicySchema.parse(policy);
    this.database.setPrivateState(this.key, parsed);
    return parsed;
  }

  acquire(): { release(): void } {
    const policy = this.getPolicy();
    const spending = this.spending();
    if (this.activeCalls >= policy.maximumConcurrentCalls) throw new Error(`Model concurrency limit of ${policy.maximumConcurrentCalls} is active.`);
    const reserved = this.activeCalls * policy.perCallReservationUsd + policy.perCallReservationUsd;
    if (spending.dailyUsd + reserved > policy.dailyBudgetUsd) throw new Error("Daily model budget would be exceeded by the configured per-call reservation.");
    if (spending.monthlyUsd + reserved > policy.monthlyBudgetUsd) throw new Error("Monthly model budget would be exceeded by the configured per-call reservation.");
    this.activeCalls += 1;
    let released = false;
    return { release: () => { if (!released) { released = true; this.activeCalls -= 1; } } };
  }

  estimateCost(providerId: string, model: string, usage: ModelUsage): number {
    const policy = this.getPolicy();
    const rate = policy.rates[`${providerId}:${model}`] ?? policy.rates[model] ?? policy.defaultRate;
    const uncachedInput = Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0));
    const TOKENS_PER_MILLION = 1_000_000;
    const COST_PRECISION_MULTIPLIER = 100_000_000;
    const amount = (
      uncachedInput * rate.inputPerMillionUsd
      + (usage.cachedInputTokens ?? 0) * rate.cachedInputPerMillionUsd
      + usage.outputTokens * rate.outputPerMillionUsd
      + (usage.reasoningTokens ?? 0) * rate.reasoningPerMillionUsd
    ) / TOKENS_PER_MILLION;
    return Math.round(amount * COST_PRECISION_MULTIPLIER) / COST_PRECISION_MULTIPLIER;
  }

  routingCostScore(providerId: string, model: string): number {
    return this.estimateCost(providerId, model, { inputTokens: 2_000, outputTokens: 1_000 });
  }

  canAttempt(attemptIndex: number): boolean {
    const policy = this.getPolicy();
    const spending = this.spending();
    const reserved = (this.activeCalls + attemptIndex) * policy.perCallReservationUsd;
    return spending.dailyUsd + reserved <= policy.dailyBudgetUsd && spending.monthlyUsd + reserved <= policy.monthlyBudgetUsd;
  }

  spending(): { dailyUsd: number; monthlyUsd: number; activeCalls: number } {
    const now = this.now();
    const dayStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const { dailyUsd, monthlyUsd } = this.database.calculateSpending(dayStartIso, monthStartIso);

    return { dailyUsd, monthlyUsd, activeCalls: this.activeCalls };
  }
}
