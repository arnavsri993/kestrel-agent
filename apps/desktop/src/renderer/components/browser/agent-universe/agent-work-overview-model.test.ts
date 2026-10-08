import type { AgentRun, RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { projectAgentUniverse } from "./agent-universe-model";
import {
	buildAgentWorkOverview,
	type AgentWorkGroupId,
} from "./agent-work-overview-model";

const now = Date.parse("2026-10-08T18:00:00.000Z");

function session(
	id: string,
	title: string,
	options: Partial<RuntimeSession> = {},
): RuntimeSession {
	return {
		id,
		title,
		kind: "agent",
		workspaceRoot: "/Users/person/Kestrel",
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-10-08T16:00:00.000Z",
		updatedAt: "2026-10-08T17:00:00.000Z",
		...options,
	};
}

function run(
	sessionId: string,
	status: AgentRun["status"],
	updatedAt = "2026-10-08T17:00:00.000Z",
): AgentRun {
	return {
		id: `run-${sessionId}-${status}`,
		sessionId,
		model: "local-model",
		providerIds: ["local"],
		status,
		turn: 2,
		createdAt: "2026-10-08T16:30:00.000Z",
		updatedAt,
	};
}

function overview(
	sessions: RuntimeSession[],
	runs: AgentRun[] = [],
	query = "",
	options: { runsLoading?: boolean; runsError?: string } = {},
) {
	const runsBySession = new Map<string, AgentRun[]>();
	for (const item of runs) {
		const entries = runsBySession.get(item.sessionId) ?? [];
		entries.push(item);
		runsBySession.set(item.sessionId, entries);
	}
	return buildAgentWorkOverview(
		projectAgentUniverse(sessions, { runsBySession }),
		query,
		{ ...options, now },
	);
}

function itemsIn(groups: ReturnType<typeof overview>, id: AgentWorkGroupId) {
	return groups.find((group) => group.id === id)!.items;
}

describe("agent work overview model", () => {
	it("keeps an active reusable session with no run in Ready", () => {
		const groups = overview([session("root", "Coordinator")]);
		expect(itemsIn(groups, "ready")).toEqual([
			expect.objectContaining({
				id: "root",
				statusLabel: "Ready",
			}),
		]);
		expect(itemsIn(groups, "working")).toHaveLength(0);
	});

	it("falls back to terminal and attention session status when no run exists", () => {
		const groups = overview([
			session("waiting", "Waiting agent", { status: "waiting" }),
			session("failed", "Failed agent", { status: "failed" }),
			session("completed", "Completed agent", { status: "completed" }),
			session("cancelled", "Cancelled agent", { status: "cancelled" }),
		]);

		expect(itemsIn(groups, "needs-attention")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "waiting", statusLabel: "Needs input" }),
				expect.objectContaining({ id: "failed", statusLabel: "Needs recovery" }),
			]),
		);
		expect(itemsIn(groups, "finished")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "completed",
					statusLabel: "Session finished",
				}),
				expect.objectContaining({ id: "cancelled", statusLabel: "Cancelled" }),
			]),
		);
		expect(JSON.stringify(groups).toLocaleLowerCase()).not.toContain("verified");
	});

	it("treats an active session's latest completed run as finished only", () => {
		const groups = overview(
			[session("root", "Coordinator", { status: "active" })],
			[run("root", "completed")],
		);
		const item = itemsIn(groups, "finished")[0]!;
		expect(item.statusLabel).toBe("Run finished");
		expect(JSON.stringify(item).toLocaleLowerCase()).not.toContain("verified");
		expect(JSON.stringify(item).toLocaleLowerCase()).not.toContain("delivered");
	});

	it("lets child work outrank a finished root", () => {
		const sessions = [
			session("root", "Coordinator"),
			session("worker", "Research", {
				kind: "subagent",
				parentSessionId: "root",
			}),
		];
		const working = overview(sessions, [
			run("root", "completed", "2026-10-08T16:50:00.000Z"),
			run("worker", "running"),
		]);
		expect(itemsIn(working, "working")[0]).toMatchObject({
			id: "root",
			statusLabel: "Delegated work is working",
		});

		const attention = overview(sessions, [
			run("root", "completed", "2026-10-08T16:50:00.000Z"),
			run("worker", "waiting_approval"),
		]);
		expect(itemsIn(attention, "needs-attention")[0]).toMatchObject({
			id: "root",
			statusLabel: "Delegated work: needs approval",
		});
	});

	it("lets a no-run child session raise its owner and keeps child ownership", () => {
		const sessions = [
			session("root", "Coordinator", { status: "completed" }),
			session("waiting-child", "Waiting research", {
				kind: "subagent",
				parentSessionId: "root",
				status: "waiting",
			}),
			session("failed-child", "Failed review", {
				kind: "subagent",
				parentSessionId: "root",
				status: "failed",
				updatedAt: "2026-10-08T17:30:00.000Z",
			}),
		];
		const groups = overview(sessions);
		const owner = itemsIn(groups, "needs-attention")[0]!;
		expect(owner).toMatchObject({
			id: "root",
			statusLabel: "Delegated work: needs recovery",
			delegatedCount: 2,
		});
		expect(owner.children).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "waiting-child",
					statusLabel: "Needs input",
				}),
				expect.objectContaining({
					id: "failed-child",
					statusLabel: "Needs recovery",
				}),
			]),
		);
	});

	it("reports loading, unavailable, and cached stale status honestly", () => {
		const sessions = [
			session("cached", "Cached"),
			session("unknown", "Unknown", { status: "failed" }),
		];
		const loading = overview(sessions, [], "", { runsLoading: true });
		expect(itemsIn(loading, "ready")[0]).toMatchObject({
			id: "cached",
			statusLabel: "Checking status",
		});
		expect(itemsIn(loading, "needs-attention")[0]).toMatchObject({
			id: "unknown",
			statusLabel: "Checking status",
		});

		const unavailable = overview(sessions, [run("cached", "running")], "", {
			runsError: "offline",
		});
		expect(itemsIn(unavailable, "working")[0]).toMatchObject({
			statusLabel: "Last known: Working",
			statusStale: true,
		});
		expect(itemsIn(unavailable, "needs-attention")[0]).toMatchObject({
			id: "unknown",
			statusLabel: "Status unavailable",
			statusStale: false,
		});
	});

	it("retains an owner and reveals only the matching child for child search", () => {
		const groups = overview(
			[
				session("root", "Coordinator"),
				session("research", "Market research", {
					kind: "subagent",
					parentSessionId: "root",
				}),
				session("review", "Code review", {
					kind: "subagent",
					parentSessionId: "root",
				}),
			],
			[],
			"market",
		);
		const item = itemsIn(groups, "ready")[0]!;
		expect(item).toMatchObject({
			id: "root",
			delegatedCount: 2,
			revealChildren: true,
		});
		expect(item.children.map((child) => child.id)).toEqual(["research"]);
	});

	it("keeps cancellation distinct from successful run finish language", () => {
		const groups = overview(
			[session("root", "Coordinator")],
			[run("root", "cancelled")],
		);
		expect(itemsIn(groups, "finished")[0]).toMatchObject({
			statusLabel: "Cancelled",
		});
	});
});
