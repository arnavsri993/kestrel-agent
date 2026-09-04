import { describe, expect, it } from "vitest";
import {
	generateAgentUniverseStarPoints,
	starfieldTransformForCamera,
} from "./AgentUniverseStarfield";

describe("agent universe starfield camera attachment", () => {
	it("moves and scales each depth layer with the map camera", () => {
		expect(
			starfieldTransformForCamera(
				{ zoom: 1.8, panX: 120, panY: -60 },
				0.5,
			),
		).toEqual({ scale: 1.4, panX: 60, panY: -30 });
	});

	it("keeps the ambient plane covered when zooming out", () => {
		expect(
			starfieldTransformForCamera(
				{ zoom: 0.72, panX: 80, panY: 40 },
				0.5,
			),
		).toEqual({ scale: 1, panX: 40, panY: 20 });
	});

	it("generates many tiny deterministic points with organic clustering", () => {
		const first = generateAgentUniverseStarPoints(
			{ density: 1, seed: 0x12ab34cd },
			1_200,
			700,
			1,
		);
		const second = generateAgentUniverseStarPoints(
			{ density: 1, seed: 0x12ab34cd },
			1_200,
			700,
			1,
		);
		expect(first).toEqual(second);
		expect(first.length).toBeGreaterThan(250);
		expect(first.every((point) => point.radius > 0 && point.radius <= 1.5)).toBe(true);
		expect(first.every((point) => point.alpha >= 0.14 && point.alpha <= 0.62)).toBe(true);
		const uniqueLocations = new Set(first.map((point) => `${point.x.toFixed(3)}:${point.y.toFixed(3)}`));
		expect(uniqueLocations.size).toBe(first.length);
	});
});
