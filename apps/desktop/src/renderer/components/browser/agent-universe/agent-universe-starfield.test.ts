import { describe, expect, it } from "vitest";
import {
	AGENT_UNIVERSE_STAR_LAYER_COUNT,
	AGENT_UNIVERSE_STARFIELD_DPR_CAP,
	AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT,
	agentUniverseStarfieldTileVariant,
	generateAgentUniverseStarPoints,
	starfieldTilePlacementsForViewport,
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

	it("uses several depth layers for a richer field", () => {
		expect(AGENT_UNIVERSE_STAR_LAYER_COUNT).toBe(7);
	});

	it("generates a dense, varied, deterministic field with a bright tail", () => {
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
		expect(first.length).toBeGreaterThan(1_000);
		expect(first.every((point) => point.radius > 0 && point.radius <= 2.7)).toBe(true);
		expect(first.every((point) => point.alpha >= 0.05 && point.alpha <= 0.96)).toBe(true);
		expect(new Set(first.map((point) => point.color)).size).toBeGreaterThan(4);
		expect(first.some((point) => point.radius > 1.5 && point.glow > 0)).toBe(true);
		const uniqueLocations = new Set(first.map((point) => `${point.x.toFixed(3)}:${point.y.toFixed(3)}`));
		expect(uniqueLocations.size).toBe(first.length);
	});

	it.each([
		{ panX: 1_918, panY: 1_352 },
		{ panX: -1_918, panY: 1_352 },
		{ panX: 1_918, panY: -1_352 },
		{ panX: -1_918, panY: -1_352 },
	])("covers an extreme camera corner without a canvas hole", ({ panX, panY }) => {
		const pixelWidth = 1_225;
		const pixelHeight = 863;
		const dpr = 1.25;
		const placements = starfieldTilePlacementsForViewport({
			pixelWidth,
			pixelHeight,
			tileWidth: 560,
			tileHeight: 560,
			transform: starfieldTransformForCamera(
				{ zoom: 2.8, panX: panX / dpr, panY: panY / dpr },
				0.86,
			),
			variantCount: AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT,
			seed: 0xdecafbad,
		});
		const transform = starfieldTransformForCamera(
			{ zoom: 2.8, panX: panX / dpr, panY: panY / dpr },
			0.86,
		);
		const scale = transform.scale;
		const transformedPanX = transform.panX * dpr;
		const transformedPanY = transform.panY * dpr;
		const xIntervals = placements
			.map((placement) => {
				const left =
					pixelWidth / 2 +
					transformedPanX +
					scale * (placement.x - pixelWidth / 2);
				return [left, left + scale * 560] as const;
			})
			.sort((left, right) => left[0] - right[0]);
		const yIntervals = placements
			.map((placement) => {
				const top =
					pixelHeight / 2 +
					transformedPanY +
					scale * (placement.y - pixelHeight / 2);
				return [top, top + scale * 560] as const;
			})
			.sort((top, bottom) => top[0] - bottom[0]);

		const assertAxisCoverage = (
			intervals: readonly (readonly [number, number])[],
			size: number,
		) => {
			let coveredUntil = 0;
			for (const [start, end] of intervals) {
				if (end <= 0 || start >= size) continue;
				expect(start).toBeLessThanOrEqual(coveredUntil + 0.001);
				coveredUntil = Math.max(coveredUntil, end);
			}
			expect(coveredUntil).toBeGreaterThanOrEqual(size - 0.001);
		};

		expect(placements.length).toBeGreaterThan(0);
		assertAxisCoverage(xIntervals, pixelWidth);
		assertAxisCoverage(yIntervals, pixelHeight);
	});

	it("selects stable but non-repeating tile variants from world coordinates", () => {
		const first = agentUniverseStarfieldTileVariant(0x13579bdf, 4, -3, 4);
		const second = agentUniverseStarfieldTileVariant(0x13579bdf, 4, -3, 4);
		const grid = new Set(
			[-2, -1, 0, 1, 2].flatMap((tileY) =>
				[-2, -1, 0, 1, 2].map((tileX) =>
					agentUniverseStarfieldTileVariant(
						0x13579bdf,
						tileX,
						tileY,
						AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT,
					),
				),
			),
		);
		expect(first).toBe(second);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThan(AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT);
		expect(grid.size).toBeGreaterThan(1);
	});

	it("keeps the starfield backing store intentionally capped", () => {
		expect(AGENT_UNIVERSE_STARFIELD_DPR_CAP).toBeLessThanOrEqual(1.25);
	});
});
