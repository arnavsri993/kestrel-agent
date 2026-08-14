import type { RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	agentSessionRecency,
	agentSessionStatusLabel,
	agentSessionsForWorkspace,
	agentStateLabel,
	agentWorkspaceName,
} from "./agent-workspace";

const sessions: RuntimeSession[] = [
	{
		id: "session-old",
		title: "Plan launch",
		workspaceRoot: "/Users/person/Launch",
		allowedTools: [],
		status: "completed",
		checkpoints: [],
		createdAt: "2026-08-09T12:00:00.000Z",
		updatedAt: "2026-08-09T13:00:00.000Z",
	},
	{
		id: "session-new",
		title: "Repair checkout",
		workspaceRoot: "/Users/person/Store",
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-08-10T12:00:00.000Z",
		updatedAt: "2026-08-11T13:00:00.000Z",
	},
];

describe("agent workspace presentation", () => {
	it("uses plain-language agent and task state", () => {
		expect(agentStateLabel("waiting_approval")).toBe("Needs approval");
		expect(agentStateLabel("error")).toBe("Needs recovery");
		expect(agentSessionStatusLabel("active")).toBe("Open");
		expect(agentSessionStatusLabel("failed")).toBe("Needs recovery");
	});

	it("filters by task title or project and keeps recent work first", () => {
		expect(
			agentSessionsForWorkspace(sessions, "", "all").map(({ id }) => id),
		).toEqual(["session-new", "session-old"]);
		expect(agentSessionsForWorkspace(sessions, "launch", "all")).toHaveLength(
			1,
		);
		expect(agentSessionsForWorkspace(sessions, "store", "open")).toHaveLength(
			1,
		);
		expect(
			agentSessionsForWorkspace(sessions, "", "done").map(({ id }) => id),
		).toEqual(["session-old"]);
	});

	it("keeps project and recency labels compact", () => {
		expect(agentWorkspaceName("/Users/person/Store")).toBe("Store");
		expect(agentWorkspaceName()).toBe("Conversation only");
		const now = Date.parse("2026-08-11T14:00:00.000Z");
		expect(agentSessionRecency("2026-08-11T13:59:30.000Z", now)).toBe(
			"Just now",
		);
		expect(agentSessionRecency("2026-08-11T13:00:00.000Z", now)).toBe("1h ago");
	});
});
