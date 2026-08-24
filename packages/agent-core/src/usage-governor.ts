import type { KestrelDatabase } from "@kestrel/database";
import { type UsagePolicy, UsagePolicySchema } from "@kestrel/shared-types";
import type { ModelUsage } from "./providers";

export const DEFAULT_USAGE_POLICY: UsagePolicy = UsagePolicySchema.parse({
	dailyBudgetUsd: 25,
	monthlyBudgetUsd: 250,
	perCallReservationUsd: 2,
	maximumConcurrentCalls: 4,
	defaultRate: {
		inputPerMillionUsd: 1,
		outputPerMillionUsd: 5,
		cachedInputPerMillionUsd: 0.25,
		reasoningPerMillionUsd: 5,
	},
	rates: {},
});

export class UsageGovernor {
	private readonly key = "runtime.usage-policy";
	private readonly ephemeralUsageKey = "runtime.ephemeral-model-spending";
	private activeCalls = 0;

	constructor(
		private readonly database: KestrelDatabase,
		private readonly now: () => Date = () => new Date(),
	) {}

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
		if (this.activeCalls >= policy.maximumConcurrentCalls)
			throw new Error(
				`Model concurrency limit of ${policy.maximumConcurrentCalls} is active.`,
			);
		const reserved =
			this.activeCalls * policy.perCallReservationUsd +
			policy.perCallReservationUsd;
		if (spending.dailyUsd + reserved > policy.dailyBudgetUsd)
			throw new Error(
				"Daily model budget would be exceeded by the configured per-call reservation.",
			);
		if (spending.monthlyUsd + reserved > policy.monthlyBudgetUsd)
			throw new Error(
				"Monthly model budget would be exceeded by the configured per-call reservation.",
			);
		this.activeCalls += 1;
		let released = false;
		return {
			release: () => {
				if (!released) {
					released = true;
					this.activeCalls -= 1;
				}
			},
		};
	}

	estimateCost(providerId: string, model: string, usage: ModelUsage): number {
		const policy = this.getPolicy();
		const rate =
			policy.rates[`${providerId}:${model}`] ??
			policy.rates[model] ??
			policy.defaultRate;
		const uncachedInput = Math.max(
			0,
			usage.inputTokens - (usage.cachedInputTokens ?? 0),
		);
		const TOKENS_PER_MILLION = 1_000_000;
		const COST_PRECISION_MULTIPLIER = 100_000_000;
		const amount =
			(uncachedInput * rate.inputPerMillionUsd +
				(usage.cachedInputTokens ?? 0) * rate.cachedInputPerMillionUsd +
				usage.outputTokens * rate.outputPerMillionUsd +
				(usage.reasoningTokens ?? 0) * rate.reasoningPerMillionUsd) /
			TOKENS_PER_MILLION;
		return Math.round(amount * COST_PRECISION_MULTIPLIER) / COST_PRECISION_MULTIPLIER;
	}

	routingCostScore(providerId: string, model: string): number {
		return this.estimateCost(providerId, model, {
			inputTokens: 2_000,
			outputTokens: 1_000,
		});
	}

	canAttempt(attemptIndex: number): boolean {
		const policy = this.getPolicy();
		const spending = this.spending();
		const reserved =
			(this.activeCalls + attemptIndex) * policy.perCallReservationUsd;
		return (
			spending.dailyUsd + reserved <= policy.dailyBudgetUsd &&
			spending.monthlyUsd + reserved <= policy.monthlyBudgetUsd
		);
	}

	/**
	 * Account for small model calls that intentionally have no durable agent
	 * run or transcript, such as the privacy-bounded New Tab welcome.
	 */
	recordEphemeralCost(costUsd: number): void {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return;
		const now = this.now();
		const dayStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
		).toISOString();
		const monthStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		).toISOString();
		const stored = this.database.getPrivateState<unknown>(
			this.ephemeralUsageKey,
		) as
			| {
					dayStart?: unknown;
					monthStart?: unknown;
					dailyUsd?: unknown;
					monthlyUsd?: unknown;
				}
			| undefined;
		const dailyUsd =
			stored?.dayStart === dayStart &&
			typeof stored.dailyUsd === "number" &&
			Number.isFinite(stored.dailyUsd)
				? stored.dailyUsd
				: 0;
		const monthlyUsd =
			stored?.monthStart === monthStart &&
			typeof stored.monthlyUsd === "number" &&
			Number.isFinite(stored.monthlyUsd)
				? stored.monthlyUsd
				: 0;
		this.database.setPrivateState(this.ephemeralUsageKey, {
			dayStart,
			monthStart,
			dailyUsd: dailyUsd + costUsd,
			monthlyUsd: monthlyUsd + costUsd,
		});
	}

	spending(): { dailyUsd: number; monthlyUsd: number; activeCalls: number } {
		const now = this.now();
		const dayStartIso = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
		).toISOString();
		const monthStartIso = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		).toISOString();

		const persisted = this.database.calculateSpending(
			dayStartIso,
			monthStartIso,
		);
		const stored = this.database.getPrivateState<unknown>(
			this.ephemeralUsageKey,
		) as
			| {
					dayStart?: unknown;
					monthStart?: unknown;
					dailyUsd?: unknown;
					monthlyUsd?: unknown;
				}
			| undefined;
		const ephemeralDaily =
			stored?.dayStart === dayStartIso &&
			typeof stored.dailyUsd === "number" &&
			Number.isFinite(stored.dailyUsd)
				? stored.dailyUsd
				: 0;
		const ephemeralMonthly =
			stored?.monthStart === monthStartIso &&
			typeof stored.monthlyUsd === "number" &&
			Number.isFinite(stored.monthlyUsd)
				? stored.monthlyUsd
				: 0;

		return {
			dailyUsd: persisted.dailyUsd + ephemeralDaily,
			monthlyUsd: persisted.monthlyUsd + ephemeralMonthly,
			activeCalls: this.activeCalls,
		};
	}
}
