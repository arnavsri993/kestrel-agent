import { describe, expect, it } from "vitest";
import { PresenceManager } from "./presence";

describe("ephemeral client presence", () => {
	it("deduplicates stable identities, marks idle clients, and expires them without network metadata", () => {
		let now = new Date("2026-07-23T10:00:00.000Z");
		const presence = new PresenceManager(() => now);
		presence.beacon({
			instanceId: "ui-stable",
			mode: "ui",
			version: "0.1.0",
			reason: "desktop window",
		});
		now = new Date("2026-07-23T10:00:30.000Z");
		presence.beacon({
			instanceId: "ui-stable",
			mode: "ui",
			version: "0.1.0",
			reason: "desktop window",
		});
		expect(presence.list()).toMatchObject([
			{
				instanceId: "ui-stable",
				status: "active",
				firstSeenAt: "2026-07-23T10:00:00.000Z",
			},
		]);
		expect(JSON.stringify(presence.list())).not.toMatch(/host|address|ip/i);

		now = new Date("2026-07-23T10:01:31.000Z");
		expect(presence.list()[0]?.status).toBe("idle");
		now = new Date("2026-07-23T10:05:30.000Z");
		expect(presence.list()).toEqual([]);
	});

	it("rejects churn modes and invalid identities", () => {
		const presence = new PresenceManager();
		expect(() => presence.beacon({ instanceId: "bad id", mode: "ui" })).toThrow(
			"instance ID",
		);
		expect(() =>
			presence.beacon({ instanceId: "cli-1", mode: "cli" as "ui" }),
		).toThrow("mode");
	});
});
