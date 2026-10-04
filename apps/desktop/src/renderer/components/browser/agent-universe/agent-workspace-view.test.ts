import { describe, expect, it } from "vitest";
import {
	AGENT_WORKSPACE_VIEW_STORAGE_KEY,
	readAgentWorkspaceView,
	writeAgentWorkspaceView,
} from "./agent-workspace-view";

describe("agent workspace view preference", () => {
	it("starts in the approachable list view when no preference exists", () => {
		expect(readAgentWorkspaceView({ getItem: () => null })).toBe("list");
		expect(readAgentWorkspaceView({ getItem: () => "unexpected" })).toBe("list");
	});

	it("restores and saves the optional map view", () => {
		const values = new Map<string, string>([[AGENT_WORKSPACE_VIEW_STORAGE_KEY, "map"]]);
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		expect(readAgentWorkspaceView(storage)).toBe("map");
		writeAgentWorkspaceView("list", storage);
		expect(readAgentWorkspaceView(storage)).toBe("list");
	});

	it("falls back safely when storage is unavailable", () => {
		expect(readAgentWorkspaceView({ getItem: () => { throw new Error("blocked"); } })).toBe("list");
		expect(() => writeAgentWorkspaceView("map", { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
	});
});
