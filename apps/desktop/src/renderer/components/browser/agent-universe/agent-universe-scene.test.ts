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

const overflowRoots = Array.from({ length: 10 }, (_, index) => ({
		id: `overflow-system-${index}`,
		title: `Overflow system ${index}`,
		allowedTools: [],
		status: "active" as const,
		checkpoints: [],
		createdAt: "2026-09-01T10:00:00.000Z",
		updatedAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00.000Z`,
	}));
const overflowSnapshot = projectAgentUniverse([
	...overflowRoots,
	{
		...overflowRoots[0]!,
		id: "overflow-system-0-child",
		title: "Delegated moon",
		parentSessionId: "overflow-system-0",
		updatedAt: "2026-09-01T11:00:00.000Z",
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
			onOverflowSystemActivate: () => undefined,
		}),
	);
}

function overflowMarkup(): string {
	return renderToStaticMarkup(
		createElement(AgentUniverseScene, {
			snapshot: overflowSnapshot,
			focusedSystemId: null,
			selectedNodeId: null,
			query: "",
			activities: [],
			reducedMotion: false,
			systemColors: {},
			contextRunsLoading: false,
			contextGroupMemoryLoading: false,
			onSystemColorChange: () => undefined,
			onNodeActivate: () => undefined,
			onBackgroundClick: () => undefined,
			onCloseContext: () => undefined,
			onOpenSession: () => undefined,
			onOverflowSystemActivate: () => undefined,
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

	it("renders planetary surface cues and an honest overflow affordance", () => {
		const rendered = overflowMarkup();
		expect(rendered).toContain("agent-universe-planet-sheen");
		expect(rendered).toContain("agent-universe-moon-orbit");
		expect(rendered).toContain("Open beyond the 8 planet slots");
		expect(rendered.match(/data-system-id=/g)?.length ?? 0).toBe(8);
	});
});
