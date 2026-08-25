import { describe, expect, it } from "vitest";
import {
	activeWindowControlIndex,
	calculateWindowControlMotion,
	centeredWindowControlsTop,
	type WindowControlBounds,
} from "./window-controls-motion";

function bounds(left: number): WindowControlBounds {
	return {
		left,
		top: 10,
		width: 24,
		height: 24,
		right: left + 24,
		bottom: 34,
	};
}

describe("window control motion", () => {
	it("centers the control group within each top-bar height", () => {
		expect(centeredWindowControlsTop(0, 36, 28)).toBe(4);
		expect(centeredWindowControlsTop(0, 48, 28)).toBe(10);
		expect(centeredWindowControlsTop(8, 48, 28)).toBe(18);
		expect(centeredWindowControlsTop(0, 72, 28)).toBe(22);
		expect(centeredWindowControlsTop(0, 76, 28)).toBe(24);
	});

	it("keeps changing as the pointer moves inside one control", () => {
		const target = bounds(10);
		const left = calculateWindowControlMotion({ x: 14, y: 22 }, target);
		const center = calculateWindowControlMotion({ x: 22, y: 22 }, target);
		const right = calculateWindowControlMotion({ x: 30, y: 22 }, target);

		expect(left.isInside).toBe(true);
		expect(right.isInside).toBe(true);
		expect(left.tilt).toBeLessThan(0);
		expect(center.tilt).toBe(0);
		expect(right.tilt).toBeGreaterThan(0);
		expect(left.triangleX).toBeLessThan(center.triangleX);
		expect(center.triangleX).toBeLessThan(right.triangleX);
	});

	it("deepens the fill inside the target and rests outside the reveal radius", () => {
		const target = bounds(10);
		const inside = calculateWindowControlMotion({ x: 22, y: 22 }, target);
		const outside = calculateWindowControlMotion({ x: 220, y: 220 }, target);

		expect(inside.fillShade).toBe(0.16);
		expect(inside.iconOpacity).toBeGreaterThan(0.9);
		expect(outside.fillShade).toBe(0);
		expect(outside.iconOpacity).toBe(0);
		expect(outside.controlScale).toBe(1);
		expect(outside.lift).toBe(-0);
	});

	it("hands the active state to the nearest control", () => {
		const controls = [bounds(10), bounds(35), bounds(60)];
		const nearFirst = controls.map((target) =>
			calculateWindowControlMotion({ x: 22, y: 22 }, target),
		);
		const nearLast = controls.map((target) =>
			calculateWindowControlMotion({ x: 72, y: 22 }, target),
		);
		const farAway = controls.map((target) =>
			calculateWindowControlMotion({ x: 220, y: 220 }, target),
		);

		expect(activeWindowControlIndex(nearFirst)).toBe(0);
		expect(activeWindowControlIndex(nearLast)).toBe(2);
		expect(activeWindowControlIndex(farAway)).toBe(-1);
	});

	it("keeps travel, tilt, scale, and shade within restrained bounds", () => {
		const target = bounds(10);
		for (let x = -80; x <= 120; x += 4) {
			for (let y = -80; y <= 120; y += 4) {
				const motion = calculateWindowControlMotion({ x, y }, target);
				expect(Math.abs(motion.tilt)).toBeLessThanOrEqual(5.5);
				expect(Math.abs(motion.triangleX)).toBeLessThanOrEqual(0.8);
				expect(Math.abs(motion.triangleY)).toBeLessThanOrEqual(0.55);
				expect(motion.controlScale).toBeLessThanOrEqual(1.045);
				expect(motion.fillShade).toBeLessThanOrEqual(0.16);
			}
		}
	});
});
