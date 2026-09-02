import type {
	AgentState,
	RuntimeSession,
	RuntimeSessionStatus,
} from "@kestrel/shared-types";

export type AgentSessionFilter = "all" | "open" | "done";

export interface AgentSessionTreeItem {
	session: RuntimeSession;
	depth: number;
	parentTitle?: string;
}

/**
 * The runtime list is intentionally broader than the local task library. Keep
 * private, incognito, and forgotten sessions out of renderer projections that
 * are meant to be user-searchable or spatially visible.
 */
export function agentSessionIsRenderable(session: RuntimeSession): boolean {
	return (
		!session.forgottenAt &&
		session.privacyMode !== "private" &&
		session.privacyMode !== "incognito"
	);
}

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
	if (!workspaceRoot) return "";
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
			if (!agentSessionIsRenderable(session)) return false;
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

/**
 * Keep delegated work beside the task that created it without trusting the
 * persisted graph to be complete or acyclic. Missing parents become roots and
 * corrupt cycles are rendered once rather than hiding a task.
 */
export function agentSessionTreeForWorkspace(
	sessions: RuntimeSession[],
	query: string,
	filter: AgentSessionFilter,
): AgentSessionTreeItem[] {
	const visible = agentSessionsForWorkspace(sessions, query, filter);
	const visibleIds = new Set(visible.map((session) => session.id));
	// Only use the already-filtered set for lineage labels. A delegated public
	// session can outlive a private parent, but the parent title must not cross
	// the renderer's privacy boundary into the public task library.
	const byId = new Map(visible.map((session) => [session.id, session]));
	const children = new Map<string, RuntimeSession[]>();
	for (const session of visible) {
		if (!session.parentSessionId || !visibleIds.has(session.parentSessionId))
			continue;
		const siblings = children.get(session.parentSessionId) ?? [];
		siblings.push(session);
		children.set(session.parentSessionId, siblings);
	}
	for (const siblings of children.values())
		siblings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

	const tree: AgentSessionTreeItem[] = [];
	const visited = new Set<string>();
	const visit = (session: RuntimeSession, depth: number, path: Set<string>) => {
		if (visited.has(session.id) || path.has(session.id)) return;
		visited.add(session.id);
		const parent = session.parentSessionId
			? byId.get(session.parentSessionId)
			: undefined;
		tree.push({
			session,
			depth,
			...(parent ? { parentTitle: parent.title } : {}),
		});
		const nextPath = new Set(path).add(session.id);
		for (const child of children.get(session.id) ?? [])
			visit(child, Math.min(depth + 1, 3), nextPath);
	};

	for (const session of visible) {
		if (!session.parentSessionId || !visibleIds.has(session.parentSessionId))
			visit(session, 0, new Set());
	}
	for (const session of visible) visit(session, 0, new Set());
	return tree;
}
