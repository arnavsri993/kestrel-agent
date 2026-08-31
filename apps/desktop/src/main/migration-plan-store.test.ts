import type { MigrationPlan } from "@kestrel/agent-core";
import { describe, expect, it } from "vitest";
import {
	migrationPlanPreview,
	PendingMigrationPlanStore,
} from "./migration-plan-store";

function plan(): MigrationPlan {
	return {
		createdAt: "2026-08-31T12:00:00.000Z",
		targetRoot: "/safe-target",
		items: [
			{
				product: "openclaw",
				category: "instructions",
				sourceRoot: "/private-source",
				sourcePath: "AGENTS.md",
				destinationPath: "imports/openclaw/AGENTS.md",
				bytes: 12,
				sha256: "a".repeat(64),
				status: "ready",
			},
		],
		warnings: ["settings were sanitized"],
		translations: [
			{
				product: "openclaw",
				sourceRoot: "/private-source",
				sourcePath: "openclaw.json",
				sourceSha256: "b".repeat(64),
				destinationPath: "imports/openclaw/.translated/openclaw.json.json",
				values: { unsafeSetting: "must-not-reach-renderer" },
				sha256: "c".repeat(64),
			},
		],
		reviewItems: [
			{
				product: "openclaw",
				sourcePath: "cron/jobs.json",
				kind: "automation",
				count: 1,
				status: "review-required",
			},
		],
	};
}

describe("pending migration plans", () => {
	it("keeps filesystem paths and sanitized values out of the renderer preview", () => {
		const preview = migrationPlanPreview(plan());
		expect(preview).toEqual({
			targetRoot: "/safe-target",
			items: [
				{
					category: "instructions",
					sourcePath: "AGENTS.md",
					status: "ready",
				},
			],
			translatedSettings: 1,
			warnings: ["settings were sanitized"],
			reviewItems: [
				{
					product: "openclaw",
					sourcePath: "cron/jobs.json",
					kind: "automation",
					count: 1,
					status: "review-required",
				},
			],
		});
		expect(JSON.stringify(preview)).not.toContain("private-source");
		expect(JSON.stringify(preview)).not.toContain("must-not-reach-renderer");
	});

	it("binds a plan to one window, expires it, and consumes it only once", () => {
		let now = 1_000;
		const store = new PendingMigrationPlanStore(() => now, 100);
		const sourcePlan = plan();
		const id = store.create(41, sourcePlan);
		expect(() => store.consume(42, id)).toThrow(
			"does not belong to this window",
		);
		expect(store.consume(41, id)).toBe(sourcePlan);
		expect(() => store.consume(41, id)).toThrow("review expired");

		const expiringId = store.create(41, sourcePlan);
		now += 100;
		expect(() => store.consume(41, expiringId)).toThrow("review expired");
	});
});
