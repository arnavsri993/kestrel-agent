import type { AgentRun, RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	agentUniverseSearchMatches,
	appendAgentUniverseActivity,
	projectAgentUniverse,
	stableAgentAngle,
} from "./agent-universe-model";

const baseSession: RuntimeSession = {
	id: "session-root",
	title: "Main session",
	workspaceRoot: "/Users/person/Workbench",
	allowedTools: ["workspace.read"],
	status: "active",
	checkpoints: [],
	createdAt: "2026-09-01T10:00:00.000Z",
	updatedAt: "2026-09-01T10:00:00.000Z",
};

function session(
	id: string,
	title: string,
	parentSessionId?: string,
	status: RuntimeSession["status"] = "active",
): RuntimeSession {
	return {
		...baseSession,
		id,
		title,
		status,
		...(parentSessionId ? { parentSessionId } : {}),
		updatedAt: `2026-09-01T10:${String(id.length).padStart(2, "0")}:00.000Z`,
	};
}

describe("agent universe projection", () => {
	it("returns no systems for an empty runtime", () => {
		const result = projectAgentUniverse([]);
		expect(result).toMatchObject({ systems: [], nodes: [], edges: [], sessionCount: 0 });
	});

	it("uses each top-level runtime session as a truthful system root", () => {
		const result = projectAgentUniverse([
			{ ...baseSession, title: "Main session" },
			session("session-second", "Second system"),
		]);
		expect(result.systems.map((system) => system.name).sort()).toEqual([
			"General",
			"Second system",
		]);
		expect(result.systems.every((system) => system.rootNodeId === system.nodes[0]?.id || system.nodes.some((node) => node.id === system.rootNodeId))).toBe(true);
	});

	it("keeps every real system while reserving eight planet slots for the overview", () => {
		const result = projectAgentUniverse(
			Array.from({ length: 10 }, (_, index) => ({
				...baseSession,
				id: `planet-system-${index}`,
				title: `Planet system ${index}`,
				updatedAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00.000Z`,
			})),
		);

		expect(result.systems).toHaveLength(10);
		expect(result.overviewSystemIds).toHaveLength(8);
		expect(result.overflowSystemIds).toHaveLength(2);
		expect([
			...result.overviewSystemIds,
			...result.overflowSystemIds,
		]).toEqual(result.systems.map((system) => system.id));
		expect(result.sessionCount).toBe(10);
	});

	it("keeps delegated depth and real parent edges", () => {
		const result = projectAgentUniverse([
			baseSession,
			session("session-child", "Research", "session-root"),
			session("session-grandchild", "Notes", "session-child"),
		]);
		const system = result.systems[0]!;
		expect(system.nodes.map((node) => [node.id, node.depth])).toEqual([
			["session-root", 0],
			["session-child", 1],
			["session-grandchild", 2],
		]);
		expect(system.edges.map((edge) => [edge.sourceId, edge.targetId])).toEqual([
			["session-root", "session-child"],
			["session-child", "session-grandchild"],
		]);
	});

	it("makes an orphan visible as its own system instead of dropping it", () => {
		const result = projectAgentUniverse([
			baseSession,
			session("session-orphan", "Orphan", "missing-parent"),
		]);
		expect(result.systems.map((system) => system.rootNodeId).sort()).toEqual([
			"session-orphan",
			"session-root",
		]);
	});

	it("breaks a corrupt cycle deterministically while retaining every session", () => {
		const result = projectAgentUniverse([
			session("cycle-a", "Cycle A", "cycle-b"),
			session("cycle-b", "Cycle B", "cycle-a"),
			session("cycle-child", "Child", "cycle-b"),
		]);
		expect(result.systems).toHaveLength(1);
		expect(result.sessionCount).toBe(3);
		expect(result.systems[0]!.rootNodeId).toBe("cycle-a");
		expect(result.edges).toEqual([
			expect.objectContaining({ sourceId: "cycle-a", targetId: "cycle-b" }),
			expect.objectContaining({ sourceId: "cycle-b", targetId: "cycle-child" }),
		]);
	});

	it("filters private, incognito, and forgotten sessions from the renderer", () => {
		const result = projectAgentUniverse([
			baseSession,
			{ ...session("private", "Private"), privacyMode: "private" },
			{ ...session("incognito", "Incognito"), privacyMode: "incognito" },
			{ ...session("forgotten", "Forgotten"), forgottenAt: "2026-09-01T11:00:00.000Z" },
		]);
		expect(result.sessionCount).toBe(1);
		expect(result.nodes.map((node) => node.id)).toEqual(["session-root"]);
	});

	it("keeps identity, positions inputs, and unknown routing fields stable", () => {
		const input = [baseSession, session("session-child", "Child", "session-root")];
		const first = projectAgentUniverse(input);
		const second = projectAgentUniverse(input);
		expect(second).toEqual(first);
		expect(first.nodes[0]).not.toHaveProperty("model");
		expect(first.nodes[0]).not.toHaveProperty("provider");
		expect(first.nodes[0]).not.toHaveProperty("importance");
		const statusUpdate = projectAgentUniverse([
			{ ...baseSession, status: "completed", updatedAt: baseSession.updatedAt },
			session("session-child", "Child", "session-root"),
		]);
		expect(statusUpdate.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
		expect(stableAgentAngle("session-child")).toBe(stableAgentAngle("session-child"));
	});

	it("uses only supplied run routing details", () => {
		const run: AgentRun = {
			id: "run-child",
			sessionId: "session-child",
			model: "local-model",
			providerIds: ["ollama"],
			status: "completed",
			turn: 1,
			createdAt: "2026-09-01T10:00:00.000Z",
			updatedAt: "2026-09-01T10:01:00.000Z",
		};
		const result = projectAgentUniverse(
			[baseSession, session("session-child", "Child", "session-root")],
			{ runsBySession: new Map([["session-child", [run]]]) },
		);
		expect(result.nodes.find((node) => node.id === "session-child")?.latestRun).toEqual(run);
	});

	it("counts actual pending runs instead of open session records", () => {
		const running: AgentRun = {
			id: "run-root",
			sessionId: "session-root",
			model: "local-model",
			providerIds: ["ollama"],
			status: "running",
			turn: 1,
			createdAt: "2026-09-01T10:00:00.000Z",
			updatedAt: "2026-09-01T10:01:00.000Z",
		};
		const waiting: AgentRun = {
			...running,
			id: "run-child",
			sessionId: "session-child",
			status: "waiting_approval",
		};
		const result = projectAgentUniverse(
			[baseSession, session("session-child", "Child", "session-root")],
			{
				runsBySession: new Map([
					["session-root", [running]],
					["session-child", [waiting]],
				]),
			},
		);
		expect(result.systems[0]?.activeTaskCount).toBe(2);
	});

	it("searches actual names and workspaces without changing the projection", () => {
		const result = projectAgentUniverse([
			baseSession,
			session("session-child", "Research", "session-root"),
		]);
		const matches = agentUniverseSearchMatches(result, "workbench");
		expect(matches.systemIds).toContain("session-root");
		expect(matches.nodeIds).toEqual(new Set(["session-root", "session-child"]));
	});

	it("coalesces repetitive activity into a bounded real-event buffer", () => {
		const event = {
			id: "event-1",
			type: "tool.started" as const,
			sessionId: "session-child",
			payload: {},
			createdAt: "2026-09-01T10:00:00.000Z",
		};
		const next = appendAgentUniverseActivity([], event);
		expect(appendAgentUniverseActivity(next, { ...event, id: "event-2" })).toEqual(next);
		expect(appendAgentUniverseActivity(next, { ...event, id: "event-3", type: "tool.completed" })).toHaveLength(2);
		expect(
			appendAgentUniverseActivity([], {
				...event,
				id: "event-memory",
				type: "group-memory.updated",
			}),
		).toMatchObject([{ type: "group-memory.updated", sessionId: event.sessionId }]);
	});
});
