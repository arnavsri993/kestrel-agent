import { describe, expect, it } from "vitest";
import { starfieldTransformForCamera } from "./AgentUniverseStarfield";

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
});
