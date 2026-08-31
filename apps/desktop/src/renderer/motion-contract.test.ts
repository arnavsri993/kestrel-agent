import { describe, expect, it } from "vitest";
import {
	clampAgentPanelWidth,
	KESTREL_CRITICAL_SPRING,
	projectedPanelWidth,
	springDampingRatio,
	springStep,
} from "./motion-contract";

describe("renderer motion contract", () => {
	it("keeps the primary physical spring near critical damping", () => {
		expect(springDampingRatio(KESTREL_CRITICAL_SPRING)).toBeGreaterThanOrEqual(0.95);
		expect(springDampingRatio(KESTREL_CRITICAL_SPRING)).toBeLessThanOrEqual(1.08);
	});

	it("clamps the agent rail to useful content and viewport bounds", () => {
		expect(clampAgentPanelWidth(120, 1440)).toBe(288);
		expect(clampAgentPanelWidth(800, 1440)).toBe(520);
		expect(clampAgentPanelWidth(500, 800)).toBe(352);
	});

	it("projects release velocity without leaving the allowed range", () => {
		expect(projectedPanelWidth(336, 500, 1440)).toBe(376);
		expect(projectedPanelWidth(336, -2000, 1440)).toBe(288);
	});

	it("settles toward a target without crossing it under critical damping", () => {
		let position = 336;
		let velocity = 0;
		for (let frame = 0; frame < 90; frame += 1) {
			const next = springStep(position, velocity, 420, 1 / 60);
			position = next.position;
			velocity = next.velocity;
			expect(position).toBeLessThanOrEqual(420.01);
		}
		expect(position).toBeCloseTo(420, 1);
	});
});
