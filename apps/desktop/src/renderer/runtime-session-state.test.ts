import type { RuntimeEvent, RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	availableWorkspaceGrants,
	runtimeRunScope,
	runtimeSessionsAfterEvent,
	runtimeTaskWorkspace,
	shouldPreserveActiveRun,
} from "./runtime-session-state";

function session(id: string, updatedAt: string): RuntimeSession {
	return {
		id,
		title: id,
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-07-22T15:00:00.000Z",
		updatedAt,
	};
}

function messageEvent(
	sessionId: string,
	sessionUpdatedAt: unknown,
): RuntimeEvent {
	return {
		id: `event-${sessionId}`,
		type: "message.appended",
		sessionId,
		messageId: `message-${sessionId}`,
		payload: { role: "assistant", sessionUpdatedAt },
		createdAt: "2026-07-22T16:03:00.000Z",
	};
}

describe("runtime session state", () => {
	it("updates cached recency from safe message event metadata", () => {
		const recent = session("recent", "2026-07-22T16:02:00.000Z");
		const older = session("older", "2026-07-22T16:01:00.000Z");
		const sessions = [recent, older];

		const next = runtimeSessionsAfterEvent(
			sessions,
			messageEvent("older", "2026-07-22T16:03:00.000Z"),
		);

		expect(next).not.toBe(sessions);
		expect(sessions[1]!.updatedAt).toBe("2026-07-22T16:01:00.000Z");
		expect(next.find((item) => item.id === "older")?.updatedAt).toBe(
			"2026-07-22T16:03:00.000Z",
		);
		expect(
			next
				.slice()
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
				.map((item) => item.id),
		).toEqual(["older", "recent"]);
	});

	it("ignores stale, invalid, unknown, and unrelated runtime events", () => {
		const sessions = [session("known", "2026-07-22T16:02:00.000Z")];
		expect(
			runtimeSessionsAfterEvent(
				sessions,
				messageEvent("known", "2026-07-22T16:01:00.000Z"),
			),
		).toBe(sessions);
		expect(
			runtimeSessionsAfterEvent(
				sessions,
				messageEvent("known", "not-a-timestamp"),
			),
		).toBe(sessions);
		expect(
			runtimeSessionsAfterEvent(
				sessions,
				messageEvent("unknown", "2026-07-22T16:03:00.000Z"),
			),
		).toBe(sessions);
		expect(
			runtimeSessionsAfterEvent(sessions, {
				...messageEvent("known", "2026-07-22T16:03:00.000Z"),
				type: "session.updated",
			}),
		).toBe(sessions);
	});

	it("keeps unavailable grants visible to settings but out of task choices", () => {
		const available = {
			path: "/projects/available",
			name: "available",
			available: true,
		};
		const unavailable = {
			path: "/projects/unavailable",
			name: "unavailable",
			available: false,
		};
		expect(availableWorkspaceGrants([available, unavailable])).toEqual([
			available,
		]);
	});

	it("does not borrow a draft workspace for a conversation-only session", () => {
		expect(
			runtimeTaskWorkspace({
				activeSessionId: "session-conversation-only",
				draftWorkspaceRoot: "/projects/available",
			}),
		).toBeUndefined();
		expect(
			runtimeTaskWorkspace({
				activeSessionId: null,
				draftWorkspaceRoot: "/projects/available",
			}),
		).toBe("/projects/available");
	});

	it("moves run controls into the background when the user switches chats", () => {
		expect(
			runtimeRunScope({
				busy: true,
				streamSessionId: "session-a",
				activeSessionId: "session-a",
				hasOptimisticNewTask: false,
			}),
		).toBe("active");
		expect(
			runtimeRunScope({
				busy: true,
				streamSessionId: "session-a",
				activeSessionId: "session-b",
				hasOptimisticNewTask: false,
			}),
		).toBe("background");
	});

	it("distinguishes an optimistic new task from idle state", () => {
		expect(
			runtimeRunScope({
				busy: true,
				streamSessionId: null,
				activeSessionId: null,
				hasOptimisticNewTask: true,
			}),
		).toBe("active");
		expect(
			runtimeRunScope({
				busy: false,
				streamSessionId: null,
				activeSessionId: null,
				hasOptimisticNewTask: false,
			}),
		).toBe("idle");
	});

	it("preserves the optimistic turn when a newly created session becomes active", () => {
		expect(
			shouldPreserveActiveRun({
				streamId: "stream-new",
				streamSessionId: "session-new",
				activeSessionId: "session-new",
			}),
		).toBe(true);
		expect(
			runtimeRunScope({
				busy: true,
				streamSessionId: "session-new",
				activeSessionId: "session-new",
				hasOptimisticNewTask: true,
			}),
		).toBe("active");
	});
});
