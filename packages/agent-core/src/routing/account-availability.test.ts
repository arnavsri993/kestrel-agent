import type { ModelProfile } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import type { ProviderHealth } from "../providers/provider-pool";
import { AccountAvailabilityMonitor } from "./account-availability";

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
	return {
		id: "provider:model",
		provider: "provider",
		endpointId: "endpoint",
		model: "model",
		displayName: "Model",
		enabled: true,
		local: false,
		capabilities: {} as ModelProfile["capabilities"],
		cost: {},
		latency: {},
		limits: { concurrency: 2 },
		features: {
			tools: true,
			vision: false,
			structuredOutput: false,
			reasoningLevels: false,
			fastMode: false,
			streaming: true,
		},
		reliability: {},
		learnedPerformance: {} as ModelProfile["learnedPerformance"],
		observations: 0,
		...overrides,
	};
}

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
	return {
		providerId: "endpoint",
		attempts: 4,
		successes: 4,
		failures: 0,
		consecutiveFailures: 0,
		averageLatencyMs: 100,
		...overrides,
	};
}

describe("AccountAvailabilityMonitor", () => {
	it("combines non-secret profile, provider health, quota, and active-request state", () => {
		const monitor = new AccountAvailabilityMonitor(
			() => new Date("2026-09-07T12:00:00.000Z"),
		);
		monitor.sync({
			providerHealth: [health()],
			profiles: [profile()],
			quotaUpdates: [
				{
					endpointId: "endpoint",
					confidence: "exact",
					remainingFraction: 0.2,
					resetAt: "2026-09-08T12:00:00.000Z",
				},
			],
		});
		monitor.setActiveRequests({ endpointId: "endpoint", activeRequests: 1 });

		expect(monitor.snapshot()).toEqual([
			expect.objectContaining({
				endpointId: "endpoint",
				profileIds: ["provider:model"],
				quotaConfidence: "exact",
				remainingFraction: 0.2,
				resetAt: "2026-09-08T12:00:00.000Z",
				health: "healthy",
				activeRequests: 1,
				concurrencyLimit: 2,
				eligible: true,
			}),
		]);
		expect(
			monitor.adjustCandidate({
				endpointId: "endpoint",
				profileId: "provider:model",
				score: 1,
			}),
		).toMatchObject({ eligible: true, scarcityPenalty: 0.28, score: 0.72 });
	});

	it("blocks cooldown, exhausted quota, unavailable profiles, and saturated endpoints", () => {
		const monitor = new AccountAvailabilityMonitor(
			() => new Date("2026-09-07T12:00:00.000Z"),
		);
		monitor.sync({
			providerHealth: [
				health({ unhealthyUntil: "2026-09-07T12:05:00.000Z", consecutiveFailures: 1 }),
			],
			profiles: [profile({ availability: "unavailable" })],
		});
		monitor.applyQuotaUpdate({
			endpointId: "endpoint",
			confidence: "exact",
			remainingFraction: 0,
		});
		monitor.setActiveRequests({ endpointId: "endpoint", activeRequests: 2 });

		expect(
			monitor.adjustCandidate({
				endpointId: "endpoint",
				profileId: "provider:model",
				score: 1,
			}),
		).toMatchObject({
			eligible: false,
			reasons: ["profile_unavailable", "cooldown", "concurrency", "quota_exhausted"],
		});
	});

	it("clears an older quota observation when the latest provider snapshot omits it", () => {
		const monitor = new AccountAvailabilityMonitor(
			() => new Date("2026-09-07T12:00:00.000Z"),
		);
		monitor.sync({
			providerHealth: [health()],
			profiles: [profile()],
			quotaUpdates: [
				{ endpointId: "endpoint", confidence: "exact", remainingFraction: 0 },
			],
		});
		expect(monitor.snapshot()[0]).toMatchObject({
			quotaConfidence: "exact",
			remainingFraction: 0,
			eligible: false,
		});

		monitor.sync({
			providerHealth: [health()],
			profiles: [profile()],
			quotaUpdates: [],
		});
		expect(monitor.snapshot()[0]).toMatchObject({
			quotaConfidence: "unknown",
			eligible: true,
		});
		expect(monitor.snapshot()[0]).not.toHaveProperty("remainingFraction");
	});

	it("normalizes malformed or unknown quota input without retaining it", () => {
		const monitor = new AccountAvailabilityMonitor();
		expect(
			monitor.applyQuotaUpdate({
				endpointId: "endpoint",
				confidence: "unknown",
				remainingFraction: Number.NaN,
				resetAt: "not-a-timestamp",
			}),
		).toEqual(
			expect.objectContaining({ quotaConfidence: "unknown", eligible: true }),
		);
		expect(monitor.snapshot()[0]).not.toHaveProperty("remainingFraction");
		expect(monitor.snapshot()[0]).not.toHaveProperty("resetAt");
	});
});
