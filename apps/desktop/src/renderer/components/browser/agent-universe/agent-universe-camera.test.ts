import { describe, expect, it } from "vitest";
import {
	cameraForWorldTarget,
	cameraTransform,
	DEFAULT_AGENT_UNIVERSE_CAMERA,
	panAgentUniverseCamera,
	zoomAgentUniverseCameraAtPoint,
} from "./agent-universe-camera";

describe("agent universe camera", () => {
	it("keeps a focused world point under the requested screen anchor", () => {
		const camera = cameraForWorldTarget(
			{ x: 240, y: 180 },
			800,
			500,
			1.8,
			{ x: 0.36, y: 0.5 },
		);
		const screenX = 400 + camera.panX + camera.zoom * (240 - 400);
		const screenY = 250 + camera.panY + camera.zoom * (180 - 250);
		expect(screenX).toBeCloseTo(288);
		expect(screenY).toBeCloseTo(250);
	});

	it("zooms around the pointer instead of the viewport origin", () => {
		const point = { x: 120, y: 90 };
		const next = zoomAgentUniverseCameraAtPoint(
			DEFAULT_AGENT_UNIVERSE_CAMERA,
			2,
			point,
			800,
			500,
		);
		const screenX = 400 + next.panX + next.zoom * (point.x - 400);
		const screenY = 250 + next.panY + next.zoom * (point.y - 250);
		expect(screenX).toBeCloseTo(point.x);
		expect(screenY).toBeCloseTo(point.y);
	});

	it("bounds direct manipulation without making the camera non-finite", () => {
		const next = panAgentUniverseCamera(
			{ zoom: 2, panX: 0, panY: 0 },
			{ x: 10_000, y: -10_000 },
			800,
			500,
		);
		expect(next.panX).toBeLessThanOrEqual(800 * (0.78 + 2 * 0.42));
		expect(next.panY).toBeGreaterThanOrEqual(-500 * (0.78 + 2 * 0.42));
		expect(Object.values(next).every(Number.isFinite)).toBe(true);
	});

	it("produces a deterministic SVG transform", () => {
		expect(cameraTransform(DEFAULT_AGENT_UNIVERSE_CAMERA, 800, 500)).toBe(
			"translate(400 250) scale(1) translate(-400 -250)",
		);
	});
});
