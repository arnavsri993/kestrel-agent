import type { ModelProfile } from "@kestrel/shared-types";
import type { ProviderHealth } from "../providers/provider-pool";

/**
 * Confidence describes the provenance of quota metadata, not an entitlement.
 * The monitor deliberately retains only routing-safe numbers and timestamps.
 */
export type QuotaConfidence = "exact" | "estimated" | "inferred" | "unknown";

export type AccountHealth = "healthy" | "degraded" | "cooling_down" | "unknown";

export interface QuotaUpdate {
	endpointId: string;
	confidence?: QuotaConfidence | undefined;
	remainingFraction?: number | undefined;
	resetAt?: string | Date | undefined;
}

export interface ActiveRequestUpdate {
	endpointId: string;
	activeRequests: number;
	concurrencyLimit?: number | undefined;
}

export interface AccountAvailabilitySnapshot {
	endpointId: string;
	providerId?: string | undefined;
	profileIds: string[];
	quotaConfidence: QuotaConfidence;
	remainingFraction?: number | undefined;
	resetAt?: string | undefined;
	health: AccountHealth;
	cooldownUntil?: string | undefined;
	activeRequests: number;
	concurrencyLimit?: number | undefined;
	eligible: boolean;
}

export interface AvailabilityCandidate {
	endpointId: string;
	profileId?: string | undefined;
	score: number;
}

export interface CandidateAvailabilityAdjustment {
	endpointId: string;
	profileId?: string | undefined;
	eligible: boolean;
	score: number;
	scarcityPenalty: number;
	reasons: Array<
		"profile_unavailable" | "cooldown" | "concurrency" | "quota_exhausted"
	>;
}

interface AvailabilityState {
	endpointId: string;
	providerId: string | undefined;
	profileIds: Set<string>;
	profiles: Map<string, ModelProfile>;
	quotaConfidence: QuotaConfidence;
	remainingFraction: number | undefined;
	resetAt: string | undefined;
	health: AccountHealth;
	cooldownUntil: string | undefined;
	activeRequests: number;
	concurrencyLimit: number | undefined;
}

const UNAVAILABLE_PROFILE_STATES = new Set([
	"authentication_required",
	"permission_denied",
	"unavailable",
	"unsupported",
]);

function finiteNonnegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizedFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function normalizedTimestamp(value: string | Date | undefined): string | undefined {
	if (value === undefined) return undefined;
	const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function profileIsUnavailable(profile: ModelProfile | undefined): boolean {
	return Boolean(
		profile &&
			(!profile.enabled ||
				(profile.availability !== undefined &&
					UNAVAILABLE_PROFILE_STATES.has(profile.availability))),
	);
}

/**
 * Private, in-memory routing state for endpoint/account availability. It never
 * accepts credentials, endpoint URLs, or provider error text.
 */
export class AccountAvailabilityMonitor {
	private readonly states = new Map<string, AvailabilityState>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	sync(input: {
		providerHealth: readonly ProviderHealth[];
		profiles: readonly ModelProfile[];
	}): AccountAvailabilitySnapshot[] {
		this.syncProfiles(input.profiles);
		this.syncProviderHealth(input.providerHealth);
		return this.snapshot();
	}

	syncProfiles(profiles: readonly ModelProfile[]): AccountAvailabilitySnapshot[] {
		for (const state of this.states.values()) {
			state.profileIds.clear();
			state.profiles.clear();
			state.concurrencyLimit = undefined;
		}
		for (const profile of profiles) {
			const state = this.stateFor(profile.endpointId);
			state.providerId = profile.provider;
			state.profileIds.add(profile.id);
			state.profiles.set(profile.id, profile);
			const limit = profile.limits.concurrency;
			if (limit !== undefined)
				state.concurrencyLimit = Math.min(state.concurrencyLimit ?? limit, limit);
		}
		return this.snapshot();
	}

	syncProviderHealth(healthRecords: readonly ProviderHealth[]): AccountAvailabilitySnapshot[] {
		const now = this.now().getTime();
		for (const health of healthRecords) {
			const state = this.matchState(health);
			if (!state) continue;
			if (health.activeRequests !== undefined)
				state.activeRequests = finiteNonnegative(health.activeRequests);
			const unhealthyUntil = normalizedTimestamp(health.unhealthyUntil);
			const cooldownAt = unhealthyUntil ? Date.parse(unhealthyUntil) : undefined;
			if (cooldownAt !== undefined && cooldownAt > now) {
				state.health = "cooling_down";
				state.cooldownUntil = unhealthyUntil;
			} else {
				state.cooldownUntil = undefined;
				state.health =
					health.consecutiveFailures > 0 || health.failures > health.successes
						? "degraded"
						: "healthy";
			}
		}
		return this.snapshot();
	}

	applyQuotaUpdate(update: QuotaUpdate): AccountAvailabilitySnapshot {
		const state = this.stateFor(update.endpointId);
		const remainingFraction = normalizedFraction(update.remainingFraction);
		state.quotaConfidence =
			update.confidence === "exact" ||
			update.confidence === "estimated" ||
			update.confidence === "inferred"
				? update.confidence
				: "unknown";
		state.remainingFraction = remainingFraction;
		state.resetAt = normalizedTimestamp(update.resetAt);
		if (state.quotaConfidence === "unknown") {
			state.remainingFraction = undefined;
			state.resetAt = undefined;
		}
		return this.snapshotFor(state);
	}

	setActiveRequests(update: ActiveRequestUpdate): AccountAvailabilitySnapshot {
		const state = this.stateFor(update.endpointId);
		state.activeRequests = finiteNonnegative(update.activeRequests);
		if (update.concurrencyLimit !== undefined)
			state.concurrencyLimit = finiteNonnegative(update.concurrencyLimit) || undefined;
		return this.snapshotFor(state);
	}

	adjustCandidate(candidate: AvailabilityCandidate): CandidateAvailabilityAdjustment {
		const state = this.states.get(candidate.endpointId);
		const reasons: CandidateAvailabilityAdjustment["reasons"] = [];
		if (!state) {
			return {
				...candidate,
				eligible: true,
				score: candidate.score,
				scarcityPenalty: 0,
				reasons,
			};
		}

		const profile = candidate.profileId
			? state.profiles.get(candidate.profileId)
			: undefined;
		if (profileIsUnavailable(profile)) reasons.push("profile_unavailable");
		if (state.health === "cooling_down") reasons.push("cooldown");
		if (
			state.concurrencyLimit !== undefined &&
			state.activeRequests >= state.concurrencyLimit
		)
			reasons.push("concurrency");
		if (state.remainingFraction === 0) reasons.push("quota_exhausted");

		const scarcityPenalty = this.scarcityPenalty(state);
		return {
			...candidate,
			eligible: reasons.length === 0,
			score: candidate.score - scarcityPenalty,
			scarcityPenalty,
			reasons,
		};
	}

	snapshot(): AccountAvailabilitySnapshot[] {
		return [...this.states.values()]
			.map((state) => this.snapshotFor(state))
			.sort((left, right) => left.endpointId.localeCompare(right.endpointId));
	}

	private stateFor(endpointId: string): AvailabilityState {
		const existing = this.states.get(endpointId);
		if (existing) return existing;
		const state: AvailabilityState = {
			endpointId,
			providerId: undefined,
			profileIds: new Set(),
			profiles: new Map(),
			quotaConfidence: "unknown",
			remainingFraction: undefined,
			resetAt: undefined,
			health: "unknown",
			cooldownUntil: undefined,
			activeRequests: 0,
			concurrencyLimit: undefined,
		};
		this.states.set(endpointId, state);
		return state;
	}

	private matchState(health: ProviderHealth): AvailabilityState | undefined {
		return (
			this.states.get(health.providerId) ??
			[...this.states.values()].find(
				(state) =>
					state.providerId === health.providerId ||
					(health.poolId !== undefined && state.providerId === health.poolId),
			)
		);
	}

	private scarcityPenalty(state: AvailabilityState): number {
		if (state.remainingFraction === undefined) return 0;
		// Keep the adjustment bounded so capability/quality routing remains useful.
		const quotaPenalty = (1 - state.remainingFraction) * 0.35;
		const confidenceMultiplier =
			state.quotaConfidence === "exact"
				? 1
				: state.quotaConfidence === "estimated"
					? 0.75
					: state.quotaConfidence === "inferred"
						? 0.5
						: 0;
		return Math.round(quotaPenalty * confidenceMultiplier * 1_000_000) / 1_000_000;
	}

	private snapshotFor(state: AvailabilityState): AccountAvailabilitySnapshot {
		const adjustment = this.adjustCandidate({
			endpointId: state.endpointId,
			score: 0,
		});
		return {
			endpointId: state.endpointId,
			...(state.providerId ? { providerId: state.providerId } : {}),
			profileIds: [...state.profileIds].sort(),
			quotaConfidence: state.quotaConfidence,
			...(state.remainingFraction !== undefined
				? { remainingFraction: state.remainingFraction }
				: {}),
			...(state.resetAt ? { resetAt: state.resetAt } : {}),
			health: state.health,
			...(state.cooldownUntil ? { cooldownUntil: state.cooldownUntil } : {}),
			activeRequests: state.activeRequests,
			...(state.concurrencyLimit !== undefined
				? { concurrencyLimit: state.concurrencyLimit }
				: {}),
			eligible: adjustment.eligible,
		};
	}
}
