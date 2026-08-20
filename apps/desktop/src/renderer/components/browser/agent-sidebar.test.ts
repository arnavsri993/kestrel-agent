import type { RuntimeSession } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	recentSidebarSessions,
	sidebarActiveDestination,
	sidebarApprovalsNavTarget,
	sidebarReviewTarget,
	sidebarReviewVisible,
} from "./agent-sidebar";

function session(
	id: string,
	updatedAt: string,
	title = id,
): RuntimeSession {
	return {
		id,
		title,
		allowedTools: [],
		status: "active",
		checkpoints: [],
		createdAt: "2026-08-10T12:00:00.000Z",
		updatedAt,
	};
}

describe("recent sidebar sessions", () => {
	it("omits Recent when there are no sessions", () => {
		expect(recentSidebarSessions([])).toEqual([]);
	});

	it("keeps the three most recently updated sessions", () => {
		const sessions = [
			session("oldest", "2026-08-11T10:00:00.000Z", "Oldest"),
			session("newest", "2026-08-14T10:00:00.000Z", "Newest"),
			session("middle", "2026-08-12T10:00:00.000Z", "Middle"),
			session("fourth", "2026-08-13T10:00:00.000Z", "Fourth"),
		];
		expect(recentSidebarSessions(sessions).map(({ id }) => id)).toEqual([
			"newest",
			"fourth",
			"middle",
		]);
	});
});

describe("sidebar review visibility", () => {
	it("shows Review for an in-thread runtime gate", () => {
		expect(
			sidebarReviewVisible({
				agentState: "waiting_approval",
				pendingCount: 0,
			}),
		).toBe(true);
	});

	it("shows Review for snapshot-only pending approvals", () => {
		expect(
			sidebarReviewVisible({ agentState: "idle", pendingCount: 2 }),
		).toBe(true);
	});

	it("hides Review when nothing needs a decision", () => {
		expect(
			sidebarReviewVisible({ agentState: "working", pendingCount: 0 }),
		).toBe(false);
	});
});

describe("sidebar approval routing", () => {
	it("sends Review to the in-thread gate when runtime is waiting", () => {
		expect(
			sidebarReviewTarget({
				runtimeWaiting: true,
				snapshotPendingCount: 0,
			}),
		).toBe("thread");
		expect(
			sidebarReviewTarget({
				runtimeWaiting: true,
				snapshotPendingCount: 1,
			}),
		).toBe("thread");
	});

	it("sends Review to Approvals when only the snapshot queue has items", () => {
		expect(
			sidebarReviewTarget({
				runtimeWaiting: false,
				snapshotPendingCount: 1,
			}),
		).toBe("approvals");
	});

	it("keeps Approvals on the in-thread gate when a runtime tool is waiting", () => {
		expect(
			sidebarApprovalsNavTarget({
				runtimeWaiting: true,
				snapshotPendingCount: 1,
			}),
		).toBe("thread");
	});

	it("focuses the in-thread gate from Approvals when the queue is empty", () => {
		expect(
			sidebarApprovalsNavTarget({
				runtimeWaiting: true,
				snapshotPendingCount: 0,
			}),
		).toBe("thread");
	});

	it("still opens Approvals when nothing is waiting", () => {
		expect(
			sidebarApprovalsNavTarget({
				runtimeWaiting: false,
				snapshotPendingCount: 0,
			}),
		).toBe("approvals");
	});
});

describe("sidebar footer destination", () => {
	it("keeps the four primary destinations", () => {
		expect(sidebarActiveDestination("browser")).toBe("browser");
		expect(sidebarActiveDestination("agent")).toBe("agent");
		expect(sidebarActiveDestination("approvals")).toBe("approvals");
		expect(sidebarActiveDestination("settings")).toBe("settings");
		expect(sidebarActiveDestination("kestrel://settings")).toBe("settings");
		expect(sidebarActiveDestination("kestrel://history")).toBe("browser");
	});

	it("maps secondary surfaces to Browser", () => {
		expect(sidebarActiveDestination("history")).toBe("browser");
		expect(sidebarActiveDestination("downloads")).toBe("browser");
		expect(sidebarActiveDestination("commands")).toBe("browser");
		expect(sidebarActiveDestination("memory")).toBe("browser");
	});
});
