import type {
	AgentState,
	RuntimeSession,
	RuntimeSessionStatus,
} from "@kestrel/shared-types";

export type AgentSessionFilter = "all" | "open" | "done";

const OPEN_SESSION_STATUSES = new Set<RuntimeSessionStatus>([
	"active",
	"waiting",
]);

export function agentStateLabel(state: AgentState): string {
	return {
		idle: "Ready",
		observing: "Reading",
		working: "Working",
		waiting_approval: "Needs approval",
		paused: "Paused",
		offline: "Offline",
		error: "Needs recovery",
		updating: "Updating",
	}[state];
}

export function agentSessionStatusLabel(status: RuntimeSessionStatus): string {
	return {
		active: "Open",
		waiting: "Waiting",
		completed: "Completed",
		cancelled: "Cancelled",
		failed: "Needs recovery",
	}[status];
}

export function agentWorkspaceName(workspaceRoot?: string): string {
	if (!workspaceRoot) return "Conversation only";
	const segments = workspaceRoot.split(/[\\/]/).filter(Boolean);
	return segments.at(-1) ?? workspaceRoot;
}

export function agentSessionRecency(
	updatedAt: string,
	now = Date.now(),
): string {
	const updated = Date.parse(updatedAt);
	if (!Number.isFinite(updated)) return "Unknown";
	const elapsedMinutes = Math.max(0, Math.floor((now - updated) / 60_000));
	if (elapsedMinutes < 1) return "Just now";
	if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `${elapsedHours}h ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	if (elapsedDays < 7) return `${elapsedDays}d ago`;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		...(new Date(updated).getFullYear() !== new Date(now).getFullYear()
			? { year: "numeric" as const }
			: {}),
	}).format(new Date(updated));
}

export function agentSessionsForWorkspace(
	sessions: RuntimeSession[],
	query: string,
	filter: AgentSessionFilter,
): RuntimeSession[] {
	const needle = query.trim().toLocaleLowerCase();
	return [...sessions]
		.filter((session) => {
			if (filter === "open" && !OPEN_SESSION_STATUSES.has(session.status))
				return false;
			if (filter === "done" && OPEN_SESSION_STATUSES.has(session.status))
				return false;
			if (!needle) return true;
			return [session.title, session.workspaceRoot ?? ""]
				.join(" ")
				.toLocaleLowerCase()
				.includes(needle);
		})
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
