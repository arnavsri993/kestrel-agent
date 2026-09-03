import { describe, expect, it } from "vitest";
import {
	agentUniverseCameraMotionSettled,
	createAgentUniverseCameraMotionState,
	stepAgentUniverseCameraMotion,
} from "./agent-universe-camera-motion";

describe("agent universe camera motion", () => {
	it("moves through intermediate frames before reaching a new target", () => {
		const start = createAgentUniverseCameraMotionState({
			zoom: 1,
			panX: 0,
			panY: 0,
		});
		const target = { zoom: 1.3, panX: 420, panY: -180 };
		const first = stepAgentUniverseCameraMotion(start, target, 1 / 60);

		expect(first.camera.panX).toBeGreaterThan(0);
		expect(first.camera.panX).toBeLessThan(target.panX);
		expect(first.camera.panY).toBeLessThan(0);
		expect(first.camera.panY).toBeGreaterThan(target.panY);
		expect(first.camera.zoom).toBeGreaterThan(start.camera.zoom);
		expect(first.camera.zoom).toBeLessThan(target.zoom);
		expect(agentUniverseCameraMotionSettled(first, target)).toBe(false);
	});

	it("settles without crossing a target at normal frame cadence", () => {
		const target = { zoom: 1.3, panX: 420, panY: -180 };
		let state = createAgentUniverseCameraMotionState({
			zoom: 1,
			panX: 0,
			panY: 0,
		});
		let previous = state.camera;
		for (let frame = 0; frame < 120; frame += 1) {
			state = stepAgentUniverseCameraMotion(state, target, 1 / 60);
			expect(state.camera.panX).toBeGreaterThanOrEqual(previous.panX - 0.001);
			expect(state.camera.panY).toBeLessThanOrEqual(previous.panY + 0.001);
			expect(state.camera.zoom).toBeGreaterThanOrEqual(previous.zoom - 0.001);
			previous = state.camera;
			if (agentUniverseCameraMotionSettled(state, target)) break;
		}

		expect(agentUniverseCameraMotionSettled(state, target)).toBe(true);
		expect(state.camera).toEqual(target);
	});

	it("interrupts from the rendered frame rather than the old target", () => {
		const firstTarget = { zoom: 1.3, panX: 420, panY: -180 };
		let state = createAgentUniverseCameraMotionState({
			zoom: 1,
			panX: 0,
			panY: 0,
		});
		for (let frame = 0; frame < 8; frame += 1) {
			state = stepAgentUniverseCameraMotion(state, firstTarget, 1 / 60);
		}

		const interruptedAt = state.camera;
		const secondTarget = { zoom: 0.82, panX: -220, panY: 140 };
		const resumed = stepAgentUniverseCameraMotion(state, secondTarget, 1 / 60);

		expect(resumed.camera.panX).not.toBe(secondTarget.panX);
		expect(resumed.camera.panY).not.toBe(secondTarget.panY);
		expect(Math.abs(resumed.camera.panX - interruptedAt.panX)).toBeLessThan(120);
		expect(Math.abs(resumed.camera.panY - interruptedAt.panY)).toBeLessThan(120);
	});

	it("uses the target immediately when reduced motion is requested", () => {
		const target = { zoom: 1.3, panX: 420, panY: -180 };
		const state = stepAgentUniverseCameraMotion(
			createAgentUniverseCameraMotionState({ zoom: 1, panX: 0, panY: 0 }),
			target,
			1 / 60,
			true,
		);

		expect(state.camera).toEqual(target);
		expect(agentUniverseCameraMotionSettled(state, target)).toBe(true);
	});
});
