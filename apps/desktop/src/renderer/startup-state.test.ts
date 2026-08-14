import type { CoreResponse, WorkspaceSnapshot } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	loadInitialDesktopState,
	startupFailureMessage,
} from "./startup-state";

describe("desktop startup state", () => {
	it("surfaces a rejected snapshot request instead of leaving the app loading forever", async () => {
		await expect(
			loadInitialDesktopState(async () => {
				throw new Error("utility process unavailable");
			}),
		).rejects.toThrow("utility process unavailable");
	});

	it("keeps a verified workspace usable when saved-chat loading fails", async () => {
		const workspace = { productName: "Kestrel" } as WorkspaceSnapshot;
		const snapshot = { ok: true, snapshot: workspace } as CoreResponse;
		const state = await loadInitialDesktopState(async (request) => {
			if (request.type === "snapshot") return snapshot;
			throw new Error("saved chat storage unavailable");
		});

		expect(state.snapshot).toBe(workspace);
		expect(state.sessions).toEqual([]);
	});

	it("turns unknown startup failures into an actionable message", () => {
		expect(startupFailureMessage(new Error("core crashed"))).toBe(
			"Kestrel's local core could not start: core crashed",
		);
		expect(startupFailureMessage(undefined)).toBe(
			"Kestrel's local core could not start. Try again.",
		);
	});
});
