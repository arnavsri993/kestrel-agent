import type {
	MemoryRecord,
	ProviderUsageWindow,
	RuntimeSession,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	homeWidgetMemories,
	matchingOpenSiteTab,
	memoryConfirmationLabel,
	recentWidgetSessions,
	usageResetLabel,
	usageSnapshotStale,
	usageWindowsForWidget,
} from "./home-widget-content";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function session(
	id: string,
	status: RuntimeSession["status"],
	updatedAt: string,
	overrides: Partial<RuntimeSession> = {},
): RuntimeSession {
	return {
		id,
		title: `Task ${id}`,
		allowedTools: [],
		status,
		checkpoints: [],
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt,
		...overrides,
	};
}

function memory(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id,
		type: "semantic",
		content: `Memory ${id}`,
		structuredData: {},
		sourceIds: [],
		sourceType: "conversation",
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-06T00:00:00.000Z",
		confidence: 0.5,
		importance: 0.5,
		sensitivity: "personal",
		status: "active",
		entityIds: [],
		userConfirmed: false,
		inferred: true,
		...overrides,
	};
}

describe("recentWidgetSessions", () => {
	it("filters private, forgotten, child, archived, and cancelled sessions before ranking", () => {
		const input = [
			session("completed", "completed", "2026-10-07T11:59:00.000Z"),
			session("active", "active", "2026-10-07T11:00:00.000Z"),
			session("failed", "failed", "2026-10-07T10:00:00.000Z"),
			session("waiting-old", "waiting", "2026-10-07T08:00:00.000Z"),
			session("waiting-new", "waiting", "2026-10-07T09:00:00.000Z"),
			session("private", "waiting", "2026-10-07T12:00:00.000Z", { privacyMode: "private" }),
			session("forgotten", "waiting", "2026-10-07T12:00:00.000Z", { forgottenAt: "2026-10-07T11:00:00.000Z" }),
			session("child", "waiting", "2026-10-07T12:00:00.000Z", { parentSessionId: "waiting-new" }),
			session("archived", "waiting", "2026-10-07T12:00:00.000Z", { specialistDefinition: { key: "reviewer", name: "Reviewer", purpose: "Reviews code", instructions: "Review", enabled: true, archived: true } }),
			session("cancelled", "cancelled", "2026-10-07T12:00:00.000Z"),
		];
		const originalIds = input.map((item) => item.id);

		expect(recentWidgetSessions(input, 10).map((item) => item.id)).toEqual([
			"waiting-new",
			"waiting-old",
			"failed",
			"active",
			"completed",
		]);
		expect(input.map((item) => item.id)).toEqual(originalIds);
	});

	it("deduplicates IDs after deterministic status, date, and ID ranking", () => {
		const input = [
			session("duplicate", "completed", "2026-10-07T12:00:00.000Z"),
			session("duplicate", "waiting", "2026-10-01T00:00:00.000Z"),
			session("b", "waiting", "2026-10-07T11:00:00.000Z"),
			session("a", "waiting", "2026-10-07T11:00:00.000Z"),
		];
		const result = recentWidgetSessions(input, 3);
		expect(result.map((item) => item.id)).toEqual(["a", "b", "duplicate"]);
		expect(result.at(-1)?.status).toBe("waiting");
		expect(recentWidgetSessions(input, Number.NaN)).toEqual([]);
	});
});

describe("homeWidgetMemories", () => {
	it("filters non-displayable and expired memories without mutating input", () => {
		const input = [
			memory("public", { sensitivity: "public" }),
			memory("sensitive", { sensitivity: "sensitive" }),
			memory("restricted", { sensitivity: "restricted" }),
			memory("inactive", { status: "superseded" }),
			memory("archived-at", { archivedAt: "2026-10-06T00:00:00.000Z" }),
			memory("archived-layer", { layer: "archived" }),
			memory("expired", { validUntil: "2026-10-07T11:59:59.000Z" }),
			memory("invalid-expiry", { validUntil: "not-a-date" }),
			memory("future", { validUntil: "2026-10-07T12:00:01.000Z" }),
		];
		const originalIds = input.map((item) => item.id);

		expect(homeWidgetMemories(input, 20, NOW).map((item) => item.id)).toEqual([
			"future",
			"public",
		]);
		expect(input.map((item) => item.id)).toEqual(originalIds);
	});

	it("ranks confirmation, importance, relevance, confidence, recency, and ID in order", () => {
		const input = [
			memory("unconfirmed-important", { importance: 1, relevanceScore: 1, confidence: 1 }),
			memory("confirmed-low", { userConfirmed: true, importance: 0.1 }),
			memory("confirmed-high", { confirmationStatus: "explicit", importance: 0.9, relevanceScore: 0.2 }),
			memory("confirmed-relevant", { confirmationStatus: "provider_confirmed", importance: 0.9, relevanceScore: 0.8, confidence: 0.4 }),
			memory("confirmed-confident-b", { confirmationStatus: "user_confirmed", importance: 0.9, relevanceScore: 0.8, confidence: 0.9, updatedAt: "2026-10-06T10:00:00.000Z" }),
			memory("confirmed-confident-a", { confirmationStatus: "user_confirmed", importance: 0.9, relevanceScore: 0.8, confidence: 0.9, updatedAt: "2026-10-06T10:00:00.000Z" }),
		];

		expect(homeWidgetMemories(input, 10, NOW).map((item) => item.id)).toEqual([
			"confirmed-confident-a",
			"confirmed-confident-b",
			"confirmed-relevant",
			"confirmed-high",
			"confirmed-low",
			"unconfirmed-important",
		]);
		expect(homeWidgetMemories(input, 2, NOW)).toHaveLength(2);
	});

	it("labels only real confirmation evidence as confirmed", () => {
		expect(memoryConfirmationLabel(memory("user", { userConfirmed: true }))).toBe("Confirmed");
		expect(memoryConfirmationLabel(memory("explicit", { confirmationStatus: "explicit" }))).toBe("Confirmed");
		expect(memoryConfirmationLabel(memory("provider", { confirmationStatus: "provider_confirmed" }))).toBe("Confirmed");
		expect(memoryConfirmationLabel(memory("suggested", { confirmationStatus: "suggested" }))).toBe("Inferred");
		expect(memoryConfirmationLabel(memory("inferred", { confirmationStatus: "inferred" }))).toBe("Inferred");
	});
});

describe("usage helpers", () => {
	it("orders real durations first, recognizes fallback labels, and preserves unknown order", () => {
		const windows: ProviderUsageWindow[] = [
			{ label: "Mystery A", usedPercent: 1 },
			{ label: "Weekly", usedPercent: 2 },
			{ label: "5-hour misleading label", usedPercent: 3, windowDurationMins: 10_080 },
			{ label: "Weekly misleading label", usedPercent: 4, windowDurationMins: 300 },
			{ label: "5-hour", usedPercent: 5 },
			{ label: "Mystery B", usedPercent: 6 },
			{ label: "Short unknown", usedPercent: 7, windowDurationMins: 60 },
		];
		const result = usageWindowsForWidget(windows);
		expect(result.map((item) => item.usedPercent)).toEqual([4, 5, 2, 3, 1, 6, 7]);
		expect(windows.map((item) => item.usedPercent)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("formats reset labels without inventing output for absent or invalid dates", () => {
		expect(usageResetLabel(undefined, NOW)).toBeUndefined();
		expect(usageResetLabel("not-a-date", NOW)).toBeUndefined();
		expect(usageResetLabel("2026-10-07T12:00:00.000Z", NOW)).toBe("Reset due");
		expect(usageResetLabel("2026-10-07T12:01:00.000Z", NOW)).toBe("Resets in 1m");
		expect(usageResetLabel("2026-10-07T13:01:00.000Z", NOW)).toBe("Resets in 1h 1m");
		expect(usageResetLabel("2026-10-08T13:00:00.000Z", NOW)).toBe("Resets in 1d 1h");
	});

	it("marks invalid and older-than-five-minute snapshots stale", () => {
		expect(usageSnapshotStale("not-a-date", NOW)).toBe(true);
		expect(usageSnapshotStale("2026-10-07T11:54:59.999Z", NOW)).toBe(true);
		expect(usageSnapshotStale("2026-10-07T11:55:00.000Z", NOW)).toBe(false);
		expect(usageSnapshotStale("2026-10-07T12:01:00.000Z", NOW)).toBe(false);
	});
});

describe("matchingOpenSiteTab", () => {
	it("matches only an exact normalized URL while ignoring hashes", () => {
		const tabs = [
			{ id: "origin-only", url: "https://example.com/" },
			{ id: "query-differs", url: "https://example.com/path?q=2" },
			{ id: "malformed", url: "not a url" },
			{ id: "exact-first", url: "https://example.com/path?q=1#current" },
			{ id: "exact-second", url: "https://EXAMPLE.com:443/path?q=1#other" },
		];
		const originalIds = tabs.map((tab) => tab.id);

		expect(
			matchingOpenSiteTab("https://EXAMPLE.com:443/path?q=1#saved", tabs)?.id,
		).toBe("exact-first");
		expect(matchingOpenSiteTab("https://example.com/path?q=3", tabs)).toBeUndefined();
		expect(matchingOpenSiteTab("not a url", tabs)).toBeUndefined();
		expect(tabs.map((tab) => tab.id)).toEqual(originalIds);
	});
});
