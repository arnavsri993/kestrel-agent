import type { AgentRun, RuntimeSession } from "@kestrel/shared-types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentWorkspaceList, agentWorkspaceListItems } from "./AgentWorkspaceList";
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

describe("delegated task disclosure", () => {
	const sessions = [
		session("travel", "Travel coordinator", "agent"),
		session("pending", "Task needing approval", "subagent", "travel"),
		session("done", "Completed research", "subagent", "travel"),
	];
	function markup(status: AgentRun["status"], query = "") {
		const run = (id: string, state: AgentRun["status"]): AgentRun => ({
			id: `run-${id}`, sessionId: id, model: "synthetic-fixture", providerIds: ["fixture"],
			status: state, turn: 1, createdAt: "2026-10-03T23:00:00.000Z", updatedAt: "2026-10-03T23:01:00.000Z",
		});
		return renderToStaticMarkup(createElement(AgentWorkspaceList, {
			snapshot: projectAgentUniverse(sessions, { runsBySession: new Map([
				["pending", [run("pending", status)]], ["done", [run("done", "completed")]],
			]) }), query, emptyState: null,
			onOpenSession() {}, onOpenSettings() {}, onClearSearch() {},
		}));
	}
	it.each(["running", "waiting_approval", "waiting_input", "failed"] as const)(
		"keeps %s delegated work visible beside a closed history", (status) => {
			const html = markup(status);
			expect(html.indexOf("Task needing approval")).toBeLessThan(html.indexOf("<details"));
			expect(html.indexOf("Completed research")).toBeGreaterThan(html.indexOf("<details"));
			expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
		});
	it("shows the completed run status instead of the still-open conversation status", () => {
		expect(markup("completed")).toContain("Completed · Updated");
		expect(markup("completed")).not.toContain("Open · Updated");
	});
	it("reveals matching delegated work directly when searching", () => {
		const html = markup("completed", "Completed research");
		expect(html).toContain("Completed research");
		expect(html).not.toContain("Task needing approval");
		expect(html).not.toContain("<details");
	});
});
