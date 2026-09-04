import type { RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	AGENT_UNIVERSE_SYSTEM_GAP,
	layoutAgentUniverse,
} from "./agent-universe-layout";
import { projectAgentUniverse } from "./agent-universe-model";

const root: RuntimeSession = {
	id: "layout-root",
	title: "Layout root",
	kind: "agent",
	allowedTools: [],
	status: "active",
	checkpoints: [],
	createdAt: "2026-09-01T10:00:00.000Z",
	updatedAt: "2026-09-01T10:00:00.000Z",
};

function makeSessions(count: number, rootId = root.id): RuntimeSession[] {
	return [
		{ ...root, id: rootId },
		...Array.from({ length: count }, (_, index) => ({
			...root,
			id: `${rootId}-child-${String(index).padStart(2, "0")}`,
			title: `Child ${index}`,
			kind: "subagent" as const,
			parentSessionId: rootId,
			updatedAt: `2026-09-01T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
		})),
	];
}

function expectFiniteLayout(
	layout: ReturnType<typeof layoutAgentUniverse>,
): void {
	expect(Number.isFinite(layout.scale)).toBe(true);
	for (const system of layout.systems) {
		expect(Number.isFinite(system.centerX)).toBe(true);
		expect(Number.isFinite(system.centerY)).toBe(true);
		expect(system.radius).toBeGreaterThan(0);
		for (const node of system.nodeLayouts) {
			expect(Number.isFinite(node.x)).toBe(true);
			expect(Number.isFinite(node.y)).toBe(true);
			expect(node.radius).toBeGreaterThan(0);
			expect(node.orbitRadius).toBeGreaterThanOrEqual(0);
		}
	}
}

describe("agent universe layout", () => {
	it("handles a zero-sized viewport without NaN", () => {
		const layout = layoutAgentUniverse(projectAgentUniverse([root]), 0, 0);
		expectFiniteLayout(layout);
	});

	it("centers the root and keeps one to twenty workers separated", () => {
		for (const childCount of [0, 3, 20, 50]) {
			const layout = layoutAgentUniverse(
				projectAgentUniverse(makeSessions(childCount)),
				1200,
				700,
			);
			expectFiniteLayout(layout);
			const system = layout.systems[0]!;
			const rootLayout = system.nodeLayouts.find((node) => node.nodeId === root.id)!;
			expect(rootLayout.x).toBe(system.centerX);
			expect(rootLayout.y).toBe(system.centerY);
			for (let left = 0; left < system.nodeLayouts.length; left += 1) {
				for (let right = left + 1; right < system.nodeLayouts.length; right += 1) {
					const a = system.nodeLayouts[left]!;
					const b = system.nodeLayouts[right]!;
					const distance = Math.hypot(a.x - b.x, a.y - b.y);
					expect(distance).toBeGreaterThanOrEqual(a.radius + b.radius - 0.5);
				}
			}
		}
	});

	it("places direct delegates on a compact, organic root-centered orbit", () => {
		const snapshot = projectAgentUniverse(makeSessions(4));
		const system = layoutAgentUniverse(snapshot, 1200, 700).systems[0]!;
		const rootLayout = system.nodeLayouts.find((node) => node.nodeId === root.id)!;
		const workerLayouts = system.nodeLayouts.filter((node) => node.nodeId !== root.id);

		expect(system.orbitRadii).toHaveLength(1);
		const distances = workerLayouts.map((worker) =>
			Math.hypot(worker.x - rootLayout.x, worker.y - rootLayout.y),
		);
		expect(new Set(distances.map((distance) => distance.toFixed(2))).size).toBeGreaterThan(1);
		expect(new Set(workerLayouts.map((worker) => worker.angle.toFixed(2))).size).toBeGreaterThan(2);
		expect(workerLayouts.every((worker) => worker.orbitBand === 1)).toBe(true);
		expect(distances.every((distance) => distance >= system.orbitRadii[0]! - 30)).toBe(true);
	});

	it("gives working and structurally important sessions more visual weight", () => {
		const sessions = makeSessions(2).map((session) => ({
			...session,
			status: session.id.endsWith("child-00")
				? ("completed" as const)
				: ("active" as const),
		}));
		const snapshot = projectAgentUniverse(sessions);
		const layout = layoutAgentUniverse(snapshot, 1200, 700).systems[0]!;
		const completed = layout.nodeLayouts.find(
			(node) => node.nodeId === `${root.id}-child-00`,
		)!;
		const active = layout.nodeLayouts.find(
			(node) => node.nodeId === `${root.id}-child-01`,
		)!;
		const rootLayout = layout.nodeLayouts.find((node) => node.nodeId === root.id)!;
		expect(active.radius).toBeGreaterThan(completed.radius);
		expect(rootLayout.radius).toBeGreaterThan(58);
	});

	it("keeps spatial memory when a worker changes status", () => {
		const sessions = makeSessions(3).map((session) => ({
			...session,
			status: session.id.endsWith("child-00")
				? ("active" as const)
				: ("completed" as const),
		}));
		const activeLayout = layoutAgentUniverse(
			projectAgentUniverse(sessions),
			1200,
			700,
		).systems[0]!;
		const settledLayout = layoutAgentUniverse(
			projectAgentUniverse(
				sessions.map((session) =>
					session.id.endsWith("child-00")
						? { ...session, status: "completed" as const }
						: session,
				),
			),
			1200,
			700,
		).systems[0]!;

		expect(settledLayout.centerX).toBe(activeLayout.centerX);
		expect(settledLayout.centerY).toBe(activeLayout.centerY);
		expect(settledLayout.radius).toBe(activeLayout.radius);
		expect(settledLayout.nodeLayouts.map(({ nodeId, x, y, orbitRadius }) => ({ nodeId, x, y, orbitRadius }))).toEqual(
			activeLayout.nodeLayouts.map(({ nodeId, x, y, orbitRadius }) => ({ nodeId, x, y, orbitRadius })),
		);
		expect(
			activeLayout.nodeLayouts.find((node) => node.nodeId.endsWith("child-00"))!.radius,
		).toBeGreaterThan(
			settledLayout.nodeLayouts.find((node) => node.nodeId.endsWith("child-00"))!.radius,
		);
	});

	it("keeps a placed planet and its moons together at the chosen map position", () => {
		const snapshot = projectAgentUniverse(makeSessions(3));
		const automatic = layoutAgentUniverse(snapshot, 1200, 700).systems[0]!;
		const placed = layoutAgentUniverse(snapshot, 1200, 700, null, {
			[root.id]: { x: 0.8, y: 0.25 },
		}).systems[0]!;
		const automaticRoot = automatic.nodeLayouts.find((node) => node.nodeId === root.id)!;
		const placedRoot = placed.nodeLayouts.find((node) => node.nodeId === root.id)!;
		const automaticMoon = automatic.nodeLayouts.find(
			(node) => node.nodeId === `${root.id}-child-00`,
		)!;
		const placedMoon = placed.nodeLayouts.find(
			(node) => node.nodeId === `${root.id}-child-00`,
		)!;

		expect(placed.centerX).toBe(960);
		expect(placed.centerY).toBe(175);
		expect(placedRoot.x).toBe(placed.centerX);
		expect(placedRoot.y).toBe(placed.centerY);
		expect(placedMoon.x - placedRoot.x).toBeCloseTo(
			automaticMoon.x - automaticRoot.x,
			8,
		);
		expect(placedMoon.y - placedRoot.y).toBeCloseTo(
			automaticMoon.y - automaticRoot.y,
			8,
		);
	});

	it("packs multiple systems without overlapping their bounding radii", () => {
		const sessions = [
			...makeSessions(3, "system-a"),
			...makeSessions(4, "system-b"),
			...makeSessions(2, "system-c"),
		];
		const layout = layoutAgentUniverse(projectAgentUniverse(sessions), 1400, 800);
		expectFiniteLayout(layout);
		for (let left = 0; left < layout.systems.length; left += 1) {
			for (let right = left + 1; right < layout.systems.length; right += 1) {
				const a = layout.systems[left]!;
				const b = layout.systems[right]!;
				expect(Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY)).toBeGreaterThan(
					a.radius + b.radius + AGENT_UNIVERSE_SYSTEM_GAP * layout.scale - 1,
				);
			}
		}
	});

	it("keeps overflow systems out of the overview without hiding focused access", () => {
		const snapshot = projectAgentUniverse(
			Array.from({ length: 10 }, (_, index) => ({
				...root,
				id: `system-${index}`,
				title: `System ${index}`,
				updatedAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00.000Z`,
			})),
		);
		const overview = layoutAgentUniverse(snapshot, 1400, 800);
		const focusedOverflow = layoutAgentUniverse(
			snapshot,
			1400,
			800,
			snapshot.overflowSystemIds[0],
		);

		expect(overview.systems).toHaveLength(8);
		expect(focusedOverflow.systems.map((system) => system.systemId)).toEqual([
			snapshot.overflowSystemIds[0],
		]);
	});

	it("is stable when the same sessions are laid out again", () => {
		const snapshot = projectAgentUniverse(makeSessions(8));
		expect(layoutAgentUniverse(snapshot, 1000, 600)).toEqual(
			layoutAgentUniverse(snapshot, 1000, 600),
		);
	});

	it("focuses one system without mutating its deterministic node order", () => {
		const snapshot = projectAgentUniverse([
			...makeSessions(4, "system-a"),
			...makeSessions(4, "system-b"),
		]);
		const focused = layoutAgentUniverse(snapshot, 900, 600, "system-b");
		expect(focused.systems.map((system) => system.systemId)).toEqual(["system-b"]);
		expect(focused.systems[0]!.nodeLayouts.map((node) => node.nodeId)).toEqual(
			layoutAgentUniverse(snapshot, 900, 600, "system-b").systems[0]!.nodeLayouts.map(
				(node) => node.nodeId,
			),
		);
	});
});
