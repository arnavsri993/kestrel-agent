import { describe, expect, it } from "vitest";
import { evaluateRoutingFixtures, ROUTING_EVALUATION_FIXTURES } from "./evaluation";

describe("offline intelligent routing evaluation", () => {
	it("covers representative tasks with inspectable deterministic evidence", () => {
		const first = evaluateRoutingFixtures();
		const second = evaluateRoutingFixtures();
		expect(first).toHaveLength(ROUTING_EVALUATION_FIXTURES.length);
		expect(first.map((item) => item.id)).toEqual(
			ROUTING_EVALUATION_FIXTURES.map((item) => item.id),
		);
		expect(first.map((item) => item.selectedRoute.modelId)).toEqual(
			second.map((item) => item.selectedRoute.modelId),
		);
		expect(first.map((item) => item.taskProfile.type)).toEqual(
			ROUTING_EVALUATION_FIXTURES.map((item) => item.expectedTaskType),
		);
		for (const [index, result] of first.entries()) {
			const fixture = ROUTING_EVALUATION_FIXTURES[index]!;
			expect(result.taskProfile.type).toBeTruthy();
			expect(result.candidates.length).toBeGreaterThan(0);
			expect(result.candidates.some((candidate) => candidate.selected)).toBe(true);
			expect(result.expectedReason.length).toBeGreaterThan(10);
			expect(result.routerReasons.length).toBeGreaterThan(0);
			if (fixture.expectSelectedProviderIds) {
				expect(fixture.expectSelectedProviderIds).toContain(
					result.selectedRoute.providerId,
				);
			}
			if (fixture.forbidSelectedProviderIds) {
				expect(fixture.forbidSelectedProviderIds).not.toContain(
					result.selectedRoute.providerId,
				);
			}
			if (fixture.expectReasoningLevels) {
				expect(fixture.expectReasoningLevels).toContain(
					result.selectedRoute.reasoningLevel,
				);
			}
		}
	});

	it("prefers Luna-class efficiency over frontier Sol for mid-difficulty work", () => {
		const results = evaluateRoutingFixtures(
			ROUTING_EVALUATION_FIXTURES.filter((fixture) =>
				["react-bug", "near-equivalent-mid", "rewrite"].includes(fixture.id),
			),
		);
		const byId = Object.fromEntries(results.map((item) => [item.id, item]));
		expect(byId.rewrite?.selectedRoute.providerId).not.toBe("frontier-sol");
		expect(byId["react-bug"]?.selectedRoute.providerId).toBe("luna-efficient");
		expect(byId["near-equivalent-mid"]?.selectedRoute.providerId).toBe(
			"luna-efficient",
		);
		expect(byId["typescript-architecture"]).toBeUndefined();
	});
});
