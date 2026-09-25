import { describe, expect, it } from "vitest";
import {
	LocalProductAnalytics,
	assertContentFreeProperties,
	retentionFormulas,
} from "./index";

describe("local product analytics", () => {
	it("records content-free events and rejects unsafe property keys", () => {
		const analytics = new LocalProductAnalytics({ maxEvents: 10 });
		analytics.record({
			name: "first_run_completed",
			occurredAt: "2026-09-21T12:00:00.000Z",
			installationId: "install-fixture-001",
			properties: { channel: "development" },
		});
		expect(analytics.totals()).toMatchObject({
			events: 1,
			byName: { first_run_completed: 1 },
		});
		expect(() =>
			assertContentFreeProperties({ prompt: "secret" }),
		).toThrow(/content-free/);
		expect(analytics.retentionSketch()).toEqual({
			activeInstallationDays: 1,
			status: "local_only",
		});
		expect(retentionFormulas().DAU).toMatch(/opt-in export only/);
	});
});
