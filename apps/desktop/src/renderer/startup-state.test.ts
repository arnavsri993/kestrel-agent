import type {
	CoreResponse,
	RuntimeSession,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	createStartupSnapshotGate,
	loadInitialDesktopState,
	startupFailureMessage,
} from "./startup-state";

describe("desktop startup state", () => {
	it("publishes the verified snapshot while saved sessions are still loading", async () => {
		const workspace = { productName: "Kestrel" } as WorkspaceSnapshot;
		let finishSessions!: (response: CoreResponse) => void;
		const sessions = new Promise<CoreResponse>((resolve) => { finishSessions = resolve; });
		const published: WorkspaceSnapshot[] = [];
		let finished = false;
		const loading = loadInitialDesktopState(
			async (request) => request.type === "snapshot"
				? ({ ok: true, snapshot: workspace } as CoreResponse)
				: sessions,
			(snapshot) => published.push(snapshot),
		).then((state) => { finished = true; return state; });
		await Promise.resolve();
		expect(published).toEqual([workspace]);
		expect(finished).toBe(false);
		finishSessions({ ok: false, error: "sessions unavailable" } as CoreResponse);
		expect((await loading).sessionsLoadError).toBe("sessions unavailable");
	});

	it("does not replace a newer snapshot event with the initial response", async () => {
		const old = { productName: "old" } as WorkspaceSnapshot;
		const newer = { productName: "new" } as WorkspaceSnapshot;
		let finishSnapshot!: (response: CoreResponse) => void;
		const pending = new Promise<CoreResponse>((resolve) => { finishSnapshot = resolve; });
		const published: WorkspaceSnapshot[] = [];
		const gate = createStartupSnapshotGate((snapshot) => published.push(snapshot));
		const loading = loadInitialDesktopState(
			async (request) => request.type === "snapshot"
				? pending
				: ({ ok: true, sessions: [] } as CoreResponse),
			gate.initial,
		);
		gate.event(newer);
		finishSnapshot({ ok: true, snapshot: old } as CoreResponse);
		await loading;
		expect(published).toEqual([newer]);
	});

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
		expect(state.selectedSessionId).toBeNull();
	});

	it("records a rejected session list separately from a rejected workspace snapshot", async () => {
		const workspace = { productName: "Kestrel" } as WorkspaceSnapshot;
		const state = await loadInitialDesktopState(async (request) => {
			if (request.type === "snapshot")
				return { ok: true, snapshot: workspace } as CoreResponse;
			return { ok: false, error: "runtime unavailable" } as CoreResponse;
		});

		expect(state.snapshot).toBe(workspace);
		expect(state.sessions).toEqual([]);
		expect(state.sessionsLoadError).toBe("runtime unavailable");
	});

	it("restores only a returned, non-forgotten selected conversation", async () => {
		const workspace = { productName: "Kestrel" } as WorkspaceSnapshot;
		const sessions = [
			{
				id: "session-kept",
				title: "Kept",
				allowedTools: [],
				status: "active",
				checkpoints: [],
				createdAt: "2026-08-31T10:00:00.000Z",
				updatedAt: "2026-08-31T10:00:00.000Z",
			},
			{
				id: "session-forgotten",
				title: "Forgotten",
				allowedTools: [],
				status: "active",
				checkpoints: [],
				createdAt: "2026-08-31T09:00:00.000Z",
				updatedAt: "2026-08-31T09:00:00.000Z",
				forgottenAt: "2026-08-31T11:00:00.000Z",
			},
		] as RuntimeSession[];
		const state = await loadInitialDesktopState(async (request) => {
			if (request.type === "snapshot")
				return { ok: true, snapshot: workspace } as CoreResponse;
			return {
				ok: true,
				sessions,
				selectedSessionId: "session-forgotten",
			} as CoreResponse;
		});
		expect(state.selectedSessionId).toBeNull();

		const restored = await loadInitialDesktopState(async (request) =>
			request.type === "snapshot"
				? ({ ok: true, snapshot: workspace } as CoreResponse)
				: ({ ok: true, sessions, selectedSessionId: "session-kept" } as CoreResponse),
		);
		expect(restored.selectedSessionId).toBe("session-kept");
	});

	it("turns unknown startup failures into an actionable message", () => {
		expect(startupFailureMessage(new Error("core crashed"))).toBe(
			"Kestrel's local core could not start: core crashed. Quit Kestrel completely and reopen it to retry.",
		);
		expect(startupFailureMessage(undefined)).toBe(
			"Kestrel's local core could not start. Quit the app completely and reopen it to retry.",
		);
	});
});
