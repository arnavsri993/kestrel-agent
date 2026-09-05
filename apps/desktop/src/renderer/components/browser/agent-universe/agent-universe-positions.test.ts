import { describe, expect, it } from "vitest";
import {
	normalizedAgentUniversePositionForPoint,
	readAgentUniverseSystemPositions,
	writeAgentUniverseSystemPositions,
} from "./agent-universe-positions";

describe("agent universe placements", () => {
	it("normalizes a dropped point so it survives a viewport resize", () => {
		expect(
			normalizedAgentUniversePositionForPoint({ x: 480, y: 210 }, 1200, 700),
		).toEqual({ x: 0.4, y: 0.3 });
	});

	it("bounds persisted coordinates without blocking an off-edge drop", () => {
		expect(
			normalizedAgentUniversePositionForPoint(
				{ x: -10_000, y: 10_000 },
				1_000,
				1_000,
			),
		).toEqual({ x: -3, y: 4 });
	});

	it("is safe when local storage is unavailable during static rendering", () => {
		expect(readAgentUniverseSystemPositions()).toEqual({});
		expect(() =>
			writeAgentUniverseSystemPositions({
				agent: { x: 0.5, y: 0.5 },
			}),
		).not.toThrow();
	});
});
