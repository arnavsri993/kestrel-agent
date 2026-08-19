import type { AgentState, RuntimeSession } from "@kestrel/shared-types";

export const SIDEBAR_RECENT_LIMIT = 3;

export type SidebarDestination = "browser" | "agent" | "approvals" | "settings";
export type SidebarApprovalSurface = "thread" | "approvals";

export function recentSidebarSessions(
	sessions: RuntimeSession[],
): RuntimeSession[] {
	return [...sessions]
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.slice(0, SIDEBAR_RECENT_LIMIT);
}

export function sidebarReviewVisible(input: {
	agentState: AgentState;
	pendingCount: number;
}): boolean {
	return input.agentState === "waiting_approval" || input.pendingCount > 0;
}

export function sidebarReviewTarget(input: {
	runtimeWaiting: boolean;
	snapshotPendingCount: number;
}): SidebarApprovalSurface {
	if (input.runtimeWaiting) return "thread";
	if (input.snapshotPendingCount > 0) return "approvals";
	return "approvals";
}

export function sidebarApprovalsNavTarget(input: {
	runtimeWaiting: boolean;
	snapshotPendingCount: number;
}): SidebarApprovalSurface {
	if (input.snapshotPendingCount > 0) return "approvals";
	if (input.runtimeWaiting) return "thread";
	return "approvals";
}

export function sidebarActiveDestination(page: string): SidebarDestination {
	if (page === "agent" || page === "approvals" || page === "settings") {
		return page;
	}
	return "browser";
}
