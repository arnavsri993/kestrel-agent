import type { AgentRun, RuntimeSession } from "@kestrel/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentWorkOverview } from "./AgentWorkOverview";
import { projectAgentUniverse } from "./agent-universe-model";

const root: RuntimeSession = {
	id: "root",
	title: "Coordinator",
	kind: "agent",
	workspaceRoot: "/Users/person/Kestrel",
	allowedTools: [],
	status: "active",
	checkpoints: [],
	createdAt: "2026-10-08T16:00:00.000Z",
	updatedAt: "2026-10-08T17:00:00.000Z",
};

const child: RuntimeSession = {
	...root,
	id: "worker",
	title: "Research",
	kind: "subagent",
	parentSessionId: root.id,
	updatedAt: "2026-10-08T17:15:00.000Z",
};

const completedRun: AgentRun = {
	id: "run-root",
	sessionId: root.id,
	model: "local-model",
	providerIds: ["local"],
	status: "completed",
	turn: 3,
	createdAt: "2026-10-08T16:30:00.000Z",
	updatedAt: "2026-10-08T17:00:00.000Z",
};

function render(query = "", runsError = "") {
	const snapshot = projectAgentUniverse([root, child], {
		runsBySession: new Map([[root.id, [completedRun]]]),
	});
	return renderToStaticMarkup(
		<AgentWorkOverview
			snapshot={snapshot}
			query={query}
			runsError={runsError}
			onOpenSession={() => undefined}
			onOpenSettings={() => undefined}
			onRetry={() => undefined}
		/>,
	);
}

describe("AgentWorkOverview", () => {
	it("uses separate accessible controls for the root, settings, and child", () => {
		const markup = render();
		expect(markup).toContain('aria-label="Open Coordinator"');
		expect(markup).toContain('aria-label="Open Coordinator settings"');
		expect(markup).toContain('aria-label="Open delegated work Research"');
		expect(markup).toContain("1 delegated task");
		expect(markup).toContain("Run finished");
		expect(markup.toLocaleLowerCase()).not.toContain("verified");
	});

	it("opens delegated disclosure when search matched its child", () => {
		const markup = render("research");
		expect(markup).toContain("<details");
		expect(markup).toContain(" open=\"\"");
		expect(markup).toContain("Coordinator");
		expect(markup).toContain("Research");
	});

	it("announces failed refreshes and labels cached status as last known", () => {
		const markup = render("", "offline");
		expect(markup).toContain('role="status"');
		expect(markup).toContain("Run status is unavailable");
		expect(markup).toContain("Last known: Run finished");
		expect(markup).toContain(">Retry<");
	});
});
