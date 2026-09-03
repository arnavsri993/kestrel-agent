import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentUniverseScene } from "./AgentUniverseScene";
import { projectAgentUniverse } from "./agent-universe-model";

const snapshot = projectAgentUniverse([
	{
		id: "scene-root",
		title: "Main circle",
		workspaceRoot: "/Users/person/Workbench",
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-09-01T10:00:00.000Z",
		updatedAt: "2026-09-01T10:00:00.000Z",
	},
	{
		id: "scene-worker",
		title: "Research",
		parentSessionId: "scene-root",
		workspaceRoot: "/Users/person/Workbench",
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-09-01T10:01:00.000Z",
		updatedAt: "2026-09-01T10:01:00.000Z",
	},
	{
		id: "scene-worker-2",
		title: "Review",
		parentSessionId: "scene-root",
		workspaceRoot: "/Users/person/Workbench",
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-09-01T10:02:00.000Z",
		updatedAt: "2026-09-01T10:02:00.000Z",
	},
]);

function markup(reducedMotion = false): string {
	return renderToStaticMarkup(
		createElement(AgentUniverseScene, {
			snapshot,
			focusedSystemId: null,
			selectedNodeId: null,
			query: "",
			activities: [],
			reducedMotion,
			systemColors: {},
			contextRunsLoading: false,
			contextGroupMemoryLoading: false,
			onSystemColorChange: () => undefined,
			onNodeActivate: () => undefined,
			onBackgroundClick: () => undefined,
			onCloseContext: () => undefined,
			onOpenSession: () => undefined,
		}),
	);
}

describe("agent universe circle surface", () => {
	it("renders node bodies as true SVG circles", () => {
		const rendered = markup();
		expect(rendered).toContain("agent-universe-core-rim");
		expect(rendered).toContain("agent-universe-worker-rim");
		expect(rendered.match(/agent-universe-core-rim/g)?.length ?? 0).toBe(1);
		expect(rendered.match(/agent-universe-worker-rim/g)?.length ?? 0).toBe(2);
		expect(rendered).not.toContain("data-physics-blob");
		expect(rendered).not.toContain("agent-universe-blob");
});

	it("keeps hierarchy links and reduced-motion state in the rendered surface", () => {
		const rendered = markup(true);
		expect(rendered).toContain("agent-universe-delegation-link");
		expect(rendered).toContain("data-edge-id");
		expect(rendered).toContain("agent-universe-scene is-reduced-motion");
	});
});
