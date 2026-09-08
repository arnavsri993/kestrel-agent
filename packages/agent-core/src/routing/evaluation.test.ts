import { describe, expect, it } from "vitest";
import { evaluateRoutingFixtures, ROUTING_EVALUATION_FIXTURES } from "./evaluation";

describe("offline intelligent routing evaluation", () => {
	it("covers representative tasks with inspectable deterministic evidence", () => {
		const first = evaluateRoutingFixtures();
		const second = evaluateRoutingFixtures();
		expect(first).toHaveLength(11);
		expect(first.map((item) => item.id)).toEqual(ROUTING_EVALUATION_FIXTURES.map((item) => item.id));
		expect(first.map((item) => item.selectedRoute.modelId)).toEqual(second.map((item) => item.selectedRoute.modelId));
		expect(first.map((item) => item.taskProfile.type)).toEqual(
			ROUTING_EVALUATION_FIXTURES.map((item) => item.expectedTaskType),
		);
		for (const result of first) {
			expect(result.taskProfile.type).toBeTruthy();
			expect(result.candidates.length).toBeGreaterThan(0);
			expect(result.candidates.some((candidate) => candidate.selected)).toBe(true);
			expect(result.expectedReason.length).toBeGreaterThan(10);
			expect(result.routerReasons.length).toBeGreaterThan(0);
		}
	});
});
