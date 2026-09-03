import { describe, expect, it } from "vitest";
import {
	createAgentUniversePhysicsState,
	reconcileAgentUniversePhysicsState,
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

	it("keeps existing bodies on their rendered frame while homes change", () => {
		const state = createAgentUniversePhysicsState(initialNodes);
		const worker = state.nodes.find((node) => node.id === "worker-a")!;
		worker.x = 236;
		worker.y = 14;
		worker.vx = 18;
		worker.vy = -6;

		const reconciled = reconcileAgentUniversePhysicsState(state, [
			{ id: "root", x: 60, y: 24, radius: 110, isRoot: true },
			{ id: "worker-a", parentId: "root", x: 250, y: 88, radius: 38 },
			{ id: "worker-b", parentId: "root", x: 72, y: 214, radius: 36 },
		]);
		const reconciledWorker = reconciled.nodes.find(
			(node) => node.id === "worker-a",
		)!;

		expect(reconciledWorker.x).toBe(236);
		expect(reconciledWorker.y).toBe(14);
		expect(reconciledWorker.vx).toBe(18);
		expect(reconciledWorker.homeX).toBe(250);
		expect(reconciledWorker.homeY).toBe(88);

		const firstFrame = stepAgentUniversePhysics(reconciled, { dt: 1 / 60 });
		const root = firstFrame.nodes.find((node) => node.id === "root")!;
		expect(root.x).toBeGreaterThan(0);
		expect(root.x).toBeLessThan(60);
		expect(firstFrame.nodes.find((node) => node.id === "worker-a")!.x).not.toBe(250);
	});
});
