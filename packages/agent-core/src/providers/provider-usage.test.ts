import { describe, expect, it } from "vitest";
import {
	parseCodexAccountUsageSnapshot,
	earliestCodexResetAt,
} from "./codex-app-server";
import { usageWindowsFromCodex } from "./provider-usage";
import { ProviderPool } from "./provider-pool";
import { ModelProviderError, textContent, type ModelProvider } from "./types";

describe("Codex usage snapshot parsing", () => {
	it("classifies real primary/secondary windows and detects exhaustion", () => {
		const snapshot = parseCodexAccountUsageSnapshot(
			{
				ordinaryUsageAllowed: false,
				rateLimits: {
					primary: {
						usedPercent: 100,
						windowDurationMins: 300,
						resetsAt: 2_000_000_000,
					},
					secondary: {
						usedPercent: 80,
						windowDurationMins: 10_080,
						resetsAt: 2_000_100_000,
					},
					planType: "pro",
				},
			},
			{ account: { type: "chatgpt", email: "user@example.test" } },
		);
		expect(snapshot).toMatchObject({
			email: "user@example.test",
			plan: "pro",
			ordinaryUsageAllowed: false,
			rateLimitReached: true,
		});
		expect(usageWindowsFromCodex(snapshot).map((window) => window.label)).toEqual([
			"5-hour",
			"Weekly",
		]);
		expect(earliestCodexResetAt(snapshot)).toBe(
			new Date(2_000_000_000 * 1_000).toISOString(),
		);
	});

	it("merges sparse rate-limit notifications without clearing known windows", () => {
		const previous = parseCodexAccountUsageSnapshot({
			ordinaryUsageAllowed: true,
			rateLimits: {
				primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 },
				secondary: {
					usedPercent: 5,
					windowDurationMins: 10_080,
					resetsAt: 2_000_100_000,
				},
			},
		});
		const merged = parseCodexAccountUsageSnapshot(
			{
				rateLimits: {
					primary: { usedPercent: 90, windowDurationMins: 300 },
				},
			},
			undefined,
			previous,
		);
		expect(merged.primary?.usedPercent).toBe(90);
		expect(merged.secondary?.usedPercent).toBe(5);
		expect(merged.ordinaryUsageAllowed).toBe(true);
	});

	it("does not invent 5-hour or weekly labels for unknown durations", () => {
		const snapshot = parseCodexAccountUsageSnapshot({
			rateLimits: {
				primary: { usedPercent: 20, windowDurationMins: 45 },
			},
		});
		expect(usageWindowsFromCodex(snapshot)).toEqual([
			{
				label: "45-minute",
				usedPercent: 20,
				windowDurationMins: 45,
			},
		]);
	});
});

describe("ProviderPool markUnavailable", () => {
	it("skips exhausted providers during automatic routing", async () => {
		const healthy: ModelProvider = {
			id: "healthy",
			defaultModel: "ok",
			capabilities: {
				streaming: false,
				tools: false,
				images: false,
				audio: false,
				documents: false,
				video: false,
				local: false,
			},
			async complete() {
				return {
					providerId: "healthy",
					model: "ok",
					text: "ok",
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					finishReason: "stop",
				};
			},
		};
		const exhausted: ModelProvider = {
			id: "exhausted",
			defaultModel: "busy",
			capabilities: healthy.capabilities,
			async complete() {
				throw new ModelProviderError("should not run", "exhausted", true, 429);
			},
		};
		const pool = new ProviderPool([exhausted, healthy]);
		pool.markUnavailable("exhausted", "rate_limit", Date.now() + 60_000);
		const result = await pool.complete(
			{
				model: "auto",
				messages: [{ role: "user", content: textContent("hi") }],
			},
			{
				providerIds: ["exhausted", "healthy"],
				automaticRouting: true,
			},
		);
		expect(result.result.providerId).toBe("healthy");
		expect(pool.health()[0]).toMatchObject({
			providerId: "exhausted",
			unhealthyReason: "rate_limit",
		});
	});
});
