import type { AgentState, RuntimeSession } from "@kestrel/shared-types";
import { parseKestrelAppPage } from "../../../utility/browser-app-pages";

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
	const appPage = parseKestrelAppPage(page)?.id ?? page;
	if (appPage === "agent" || appPage === "approvals" || appPage === "settings") {
		return appPage;
	}
	return "browser";
}
