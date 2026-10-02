import type { RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { agentWorkspaceListItems } from "./AgentWorkspaceList";
import { projectAgentUniverse } from "./agent-universe-model";

function session(
	id: string,
	title: string,
	kind: "agent" | "subagent",
	parentSessionId?: string,
): RuntimeSession {
	return {
		id,
		title,
		kind,
		...(parentSessionId ? { parentSessionId } : {}),
		workspaceRoot: "/Users/example/Flight Planner",
		allowedTools: [],
		status: id === "research" ? "waiting" : "active",
		checkpoints: [],
		createdAt: "2026-10-01T10:00:00.000Z",
		updatedAt: id === "research"
			? "2026-10-01T12:00:00.000Z"
			: "2026-10-01T11:00:00.000Z",
	};
}

describe("agentWorkspaceListItems", () => {
	const snapshot = projectAgentUniverse([
		session("travel", "Travel coordinator", "agent"),
		session("research", "Compare train routes", "subagent", "travel"),
		session("writing", "Writing partner", "agent"),
	]);

	it("keeps every agent and delegated task in recent-system order", () => {
		const items = agentWorkspaceListItems(snapshot, "");
		expect(items.map((item) => item.system.name)).toEqual([
			"Travel coordinator",
			"Writing partner",
		]);
		expect(items[0]?.nodes.map((node) => node.name)).toEqual([
			"Travel coordinator",
			"Compare train routes",
		]);
	});

	it("finds a delegated task without hiding its owning agent", () => {
		const [item] = agentWorkspaceListItems(snapshot, "train routes");
		expect(item?.system.name).toBe("Travel coordinator");
		expect(item?.nodes.map((node) => node.name)).toEqual([
			"Compare train routes",
		]);
	});

	it("searches workspace and status text", () => {
		expect(agentWorkspaceListItems(snapshot, "Flight Planner")).toHaveLength(2);
		expect(agentWorkspaceListItems(snapshot, "Waiting")[0]?.nodes.map((node) => node.id)).toEqual(["research"]);
		expect(agentWorkspaceListItems(snapshot, "missing")).toEqual([]);
	});
});
