import { describe, expect, it } from "vitest";
import {
	commitAgentUniverseRootDrag,
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

	it("lets a dragged planet lead its moons and stay at its dropped position", () => {
		const state = createAgentUniversePhysicsState(initialNodes);
		state.drag = {
			nodeId: "root",
			target: { x: 240, y: 90 },
			origin: { x: 0, y: 0 },
			offset: { x: 0, y: 0 },
		};
		const displaced = step(state, 45);
		const root = displaced.nodes.find((node) => node.id === "root")!;
		const worker = displaced.nodes.find((node) => node.id === "worker-a")!;

		expect(root.x).toBeGreaterThan(100);
		expect(worker.x).toBeGreaterThan(190);
		expect(worker.y).toBeGreaterThan(-1);

		const committed = commitAgentUniverseRootDrag(displaced);
		expect(committed?.position).toEqual({ x: 240, y: 90 });
		expect(committed?.state.drag).toBeNull();
		const committedRoot = committed!.state.nodes.find((node) => node.id === "root")!;
		const committedWorker = committed!.state.nodes.find((node) => node.id === "worker-a")!;
		expect(committedRoot.x).toBe(240);
		expect(committedRoot.y).toBe(90);
		expect(committedRoot.homeX).toBe(240);
		expect(committedRoot.homeY).toBe(90);
		expect(committedWorker.homeX - committedRoot.homeX).toBe(190);
		expect(committedWorker.homeY - committedRoot.homeY).toBe(0);

		const settled = step(committed!.state, 240);
		const settledRoot = settled.nodes.find((node) => node.id === "root")!;
		const settledWorker = settled.nodes.find((node) => node.id === "worker-a")!;
		expect(Math.hypot(settledRoot.x - 240, settledRoot.y - 90)).toBeLessThan(1);
		expect(Math.hypot(settledWorker.x - committedWorker.homeX, settledWorker.y - committedWorker.homeY)).toBeLessThan(1);
	});

	it("does not commit a moon as a new planet position", () => {
		const state = createAgentUniversePhysicsState(initialNodes);
		state.drag = {
			nodeId: "worker-a",
			target: { x: 430, y: -20 },
			origin: { x: 190, y: 0 },
			offset: { x: 0, y: 0 },
		};

		expect(commitAgentUniverseRootDrag(state)).toBeUndefined();
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
