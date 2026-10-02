import { describe, expect, it } from "vitest";
import {
	parseCodexAccountUsageSnapshot,
	codexAvailabilityResetAt,
	CodexAppServerProvider,
} from "./codex-app-server";
import {
	usageWindowsFromCodex,
	ProviderUsageCollector,
	providerUsageLabel,
} from "./provider-usage";
import { ProviderPool } from "./provider-pool";
import { createAccountModelProviders } from "./account-providers";
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
		expect(codexAvailabilityResetAt(snapshot)).toBe(
			new Date(2_000_000_000 * 1_000).toISOString(),
		);
	});

	it("prefers legacy Codex windows over another named bucket", () => {
		const snapshot = parseCodexAccountUsageSnapshot({
			rateLimitsByLimitId: {
				other: { primary: { usedPercent: 100, windowDurationMins: 300 } },
			},
			rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } },
		});
		expect(snapshot.primary?.usedPercent).toBe(12);
		expect(snapshot.rateLimitReached).toBe(false);
	});

	it("uses another named bucket only when Codex and legacy windows are absent", () => {
		const snapshot = parseCodexAccountUsageSnapshot({
			rateLimitsByLimitId: {
				other: { primary: { usedPercent: 37, windowDurationMins: 300 } },
			},
		});
		expect(snapshot.primary?.usedPercent).toBe(37);
	});

	it("waits for all exhausted windows and declines unknown reset times", () => {
		const first = new Date(Date.now() + 60_000).toISOString();
		const last = new Date(Date.now() + 120_000).toISOString();
		const primary = { usedPercent: 100, resetsAt: first };
		const secondary = { usedPercent: 100, resetsAt: last };
		expect(codexAvailabilityResetAt({ rateLimitReached: true, primary, updatedAt: first })).toBe(first);
		expect(codexAvailabilityResetAt({ rateLimitReached: true, secondary, updatedAt: first })).toBe(last);
		expect(codexAvailabilityResetAt({ rateLimitReached: true, primary, secondary, updatedAt: first })).toBe(last);
		expect(codexAvailabilityResetAt({ rateLimitReached: true, primary, secondary: { usedPercent: 100 }, updatedAt: first })).toBeUndefined();
		expect(codexAvailabilityResetAt({ rateLimitReached: true, primary: { usedPercent: 100, resetsAt: "bad" }, updatedAt: first })).toBeUndefined();
		expect(codexAvailabilityResetAt({ rateLimitReached: true, primary: { usedPercent: 100, resetsAt: new Date(Date.now() - 1000).toISOString() }, updatedAt: first })).toBeUndefined();
		expect(codexAvailabilityResetAt({ rateLimitReached: true, primary: { usedPercent: 90, resetsAt: first }, updatedAt: first })).toBeUndefined();
		expect(codexAvailabilityResetAt({ rateLimitReached: false, primary, updatedAt: first })).toBeUndefined();
	});

	it("authoritative recovery drops missing synthetic quota fields", () => {
		const previous = parseCodexAccountUsageSnapshot({
			ordinaryUsageAllowed: false,
			rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } },
		});
		const recovered = parseCodexAccountUsageSnapshot(
			{ rateLimits: {} }, undefined, previous, true,
		);
		expect(recovered.rateLimitReached).toBe(false);
		expect(recovered.ordinaryUsageAllowed).toBeUndefined();
		expect(recovered.primary).toBeUndefined();
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

	it("reads OpenClaw-style rateLimitsByLimitId.codex buckets", () => {
		const snapshot = parseCodexAccountUsageSnapshot({
			ordinaryUsageAllowed: true,
			rateLimitsByLimitId: {
				codex: {
					primary: {
						usedPercent: 42,
						windowDurationMins: 300,
						resetsAt: 2_000_000_000,
					},
					secondary: {
						usedPercent: 17,
						windowDurationMins: 10_080,
						resetsAt: 2_000_100_000,
					},
					planType: "plus",
				},
			},
		});
		expect(usageWindowsFromCodex(snapshot)).toEqual([
			{
				label: "5-hour",
				usedPercent: 42,
				windowDurationMins: 300,
				resetsAt: new Date(2_000_000_000 * 1_000).toISOString(),
			},
			{
				label: "Weekly",
				usedPercent: 17,
				windowDurationMins: 10_080,
				resetsAt: new Date(2_000_100_000 * 1_000).toISOString(),
			},
		]);
		expect(snapshot.plan).toBe("plus");
	});
});

describe("Account-backed Codex usage identity", () => {
	it("keeps CodexAppServerProvider instanceof after account attach", () => {
		const [provider] = createAccountModelProviders([
			{
				id: "account-codex-a",
				providerId: "codex",
				adapter: "codex-app-server",
				displayName: "user@example.test — Main",
				authTransport: "oauth",
				enabled: true,
				profilePath: "/tmp/kestrel-codex-profile-a",
			},
		]);
		expect(provider).toBeInstanceOf(CodexAppServerProvider);
		expect(provider?.account?.displayName).toBe("user@example.test — Main");
		expect(providerUsageLabel(provider!)).toBe("user@example.test — Main");
	});

	it("keeps an unprobed provider unverified instead of reporting it ready", async () => {
		const provider: ModelProvider = {
			id: "account-unprobed",
			poolId: "openai",
			defaultModel: "default",
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
				throw new Error("not used");
			},
		};
		const collector = new ProviderUsageCollector(new ProviderPool([provider]));

		await expect(collector.collect()).resolves.toMatchObject([
			{
				providerId: "account-unprobed",
				providerPoolId: "openai",
				status: "unknown",
				statusDetail: "Availability has not been verified",
			},
		]);
	});

	it("polls each Codex account home independently", async () => {
		const snapshots = new Map<string, ReturnType<typeof parseCodexAccountUsageSnapshot>>([
			[
				"account-a",
				parseCodexAccountUsageSnapshot({
					rateLimits: {
						primary: { usedPercent: 11, windowDurationMins: 300 },
						secondary: { usedPercent: 21, windowDurationMins: 10_080 },
						planType: "plus",
					},
				}),
			],
			[
				"account-b",
				parseCodexAccountUsageSnapshot({
					rateLimits: {
						primary: { usedPercent: 71, windowDurationMins: 300 },
						secondary: { usedPercent: 81, windowDurationMins: 10_080 },
						planType: "team",
					},
				}),
			],
		]);
		const providers = ["account-a", "account-b"].map((id) => {
			const provider = new CodexAppServerProvider({ id, poolId: "codex" });
			provider.readRateLimits = async () => snapshots.get(id)!;
			provider.lastRateLimits = () => undefined;
			return provider;
		});
		const collector = new ProviderUsageCollector(new ProviderPool(providers));
		const rows = await collector.collect();
		expect(rows).toHaveLength(2);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ providerId: "account-a", providerPoolId: "codex" }),
				expect.objectContaining({ providerId: "account-b", providerPoolId: "codex" }),
			]),
		);
		expect(rows.find((row) => row.providerId === "account-a")?.windows).toEqual([
			{ label: "5-hour", usedPercent: 11, windowDurationMins: 300 },
			{ label: "Weekly", usedPercent: 21, windowDurationMins: 10_080 },
		]);
		expect(rows.find((row) => row.providerId === "account-b")?.windows).toEqual([
			{ label: "5-hour", usedPercent: 71, windowDurationMins: 300 },
			{ label: "Weekly", usedPercent: 81, windowDurationMins: 10_080 },
		]);
	});
});

describe("ProviderPool markUnavailable", () => {
	it("records the cooldown for an explicitly selected endpoint without calling it", async () => {
		let calls = 0;
		const provider: ModelProvider = {
			id: "selected",
			defaultModel: "test",
			capabilities: { streaming: false, tools: false, images: false, audio: false, documents: false, video: false, local: false },
			async complete() {
				calls += 1;
				throw new Error("unexpected call");
			},
		};
		const now = new Date("2026-07-29T12:00:00.000Z");
		const pool = new ProviderPool([provider], () => now);
		pool.markUnavailable("selected", "rate_limit", new Date("2026-07-29T12:01:00.000Z"));
		await expect(pool.complete(
			{ model: "test", messages: [{ role: "user", content: textContent("hi") }] },
			{ providerIds: ["selected"], automaticRouting: false },
		)).rejects.toMatchObject({
			attempts: [{ providerId: "selected", status: "failed", error: "Provider temporarily unavailable (rate_limit) until 2026-07-29T12:01:00.000Z." }],
		});
		expect(calls).toBe(0);
	});

	it("fresh usage recovery restores automatic routing", async () => {
		let nowMs = Date.now();
		let calls = 0;
		let exhausted = true;
		const provider = new CodexAppServerProvider({ id: "codex-account", poolId: "codex" });
		provider.readRateLimits = async () => parseCodexAccountUsageSnapshot({
			rateLimits: { primary: { usedPercent: exhausted ? 100 : 25, windowDurationMins: 300, resetsAt: Math.floor((nowMs + 600_000) / 1000) } },
		});
		provider.lastRateLimits = () => undefined;
		provider.complete = async () => {
			calls += 1;
			return { providerId: provider.id, model: "test", text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
		};
		const pool = new ProviderPool([provider], () => new Date(nowMs));
		const collector = new ProviderUsageCollector(pool, () => new Date(nowMs));
		await collector.collect();
		expect(pool.health()[0]?.unhealthyReason).toBe("rate_limit");
		expect(calls).toBe(0);
		exhausted = false;
		nowMs += 61_000;
		await collector.collect();
		expect(pool.health()[0]?.unhealthyReason).toBeUndefined();
		await pool.complete({ model: "auto", messages: [{ role: "user", content: textContent("hi") }] }, { providerIds: ["codex-account"], automaticRouting: true });
		expect(calls).toBe(1);
	});

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
