import { describe, expect, it } from "vitest";
import {
	createAgentUniversePhysicsState,
	stepAgentUniversePhysics,
	type AgentUniversePhysicsState,
} from "./agent-universe-physics";

const initialNodes = [
	{ id: "root", x: 0, y: 0, radius: 110, isRoot: true },
	{ id: "worker-a", parentId: "root", x: 190, y: 0, radius: 38 },
	{ id: "worker-b", parentId: "root", x: 0, y: 190, radius: 36 },
] as const;

function step(state: AgentUniversePhysicsState, frames: number): AgentUniversePhysicsState {
	let current = state;
	for (let index = 0; index < frames; index += 1) {
		current = stepAgentUniversePhysics(current, { dt: 1 / 60 });
	}
	return current;
}

describe("agent universe local physics", () => {
	it("leaves a settled, non-overlapping scaffold still even when bodies are nearby", () => {
		const state = createAgentUniversePhysicsState([
			{ id: "root", x: 0, y: 0, radius: 70, isRoot: true },
			{ id: "worker", parentId: "root", x: 108, y: 0, radius: 30 },
		]);
		const after = stepAgentUniversePhysics(state, { dt: 1 / 60 });

		expect(after.nodes.map(({ x, y, vx, vy }) => ({ x, y, vx, vy }))).toEqual(
			state.nodes.map(({ x, y, vx, vy }) => ({ x, y, vx, vy })),
		);
	});

	it("lets the dragged worker leave its rest position while neighbours lean into the vacancy", () => {
		const state = createAgentUniversePhysicsState(initialNodes);
		state.drag = {
			nodeId: "worker-a",
			target: { x: 430, y: -20 },
			origin: { x: 190, y: 0 },
			offset: { x: 0, y: 0 },
		};
		const after = step(state, 45);
		const dragged = after.nodes.find((node) => node.id === "worker-a")!;
		const neighbour = after.nodes.find((node) => node.id === "worker-b")!;

		expect(dragged.x).toBeGreaterThan(250);
		expect(neighbour.x).toBeGreaterThan(0);
		expect(neighbour.y).toBeLessThan(190);
	});

	it("returns the worker to its parent and comes to rest after release", () => {
		const state = createAgentUniversePhysicsState(initialNodes);
		state.drag = {
			nodeId: "worker-a",
			target: { x: 430, y: -20 },
			origin: { x: 190, y: 0 },
			offset: { x: 0, y: 0 },
		};
		let displaced = step(state, 45);
		displaced.drag = null;
		const settled = step(displaced, 240);
		const worker = settled.nodes.find((node) => node.id === "worker-a")!;

		expect(Math.hypot(worker.x - worker.homeX, worker.y - worker.homeY)).toBeLessThan(1);
		expect(Math.hypot(worker.vx, worker.vy)).toBeLessThan(1);
	});
});
