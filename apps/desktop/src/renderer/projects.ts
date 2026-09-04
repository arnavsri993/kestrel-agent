import type { Project, RuntimeSession } from "@kestrel/shared-types";

export const PROJECT_SIDEBAR_CHAT_LIMIT = 5;

type ProjectLike = {
	path: string;
	id?: string | undefined;
};

function byRecentActivity(left: RuntimeSession, right: RuntimeSession): number {
	return right.updatedAt.localeCompare(left.updatedAt);
}

function projectReference(project: ProjectLike | string): {
	id?: string;
	path: string;
} {
	return typeof project === "string"
		? { path: project }
		: { path: project.path, ...(project.id ? { id: project.id } : {}) };
}

/**
 * Project membership prefers the stable ID and retains a path fallback for
 * sessions written before project IDs existed.
 */
export function projectChats(
	sessions: RuntimeSession[],
	project: ProjectLike | string,
): RuntimeSession[] {
	const reference = projectReference(project);
	return sessions
		.filter(
			(session) =>
				(reference.id && session.projectId === reference.id) ||
				(!session.projectId && session.workspaceRoot === reference.path),
		)
		.sort(byRecentActivity);
}

export function projectChatsForSidebar(
	sessions: RuntimeSession[],
	project: ProjectLike | string,
	limit = PROJECT_SIDEBAR_CHAT_LIMIT,
): RuntimeSession[] {
	return projectChats(sessions, project).slice(0, Math.max(0, limit));
}

/**
 * Keep assigned chats in their project section. Sessions without a configured
 * project, and sessions whose old folder is no longer known, remain global.
 */
export function sessionsWithoutProject(
	sessions: RuntimeSession[],
	projects: ProjectLike[],
): RuntimeSession[] {
	const projectIds = new Set(
		projects.flatMap((project) => (project.id ? [project.id] : [])),
	);
	const projectPaths = new Set(projects.map((project) => project.path));
	return sessions
		.filter(
			(session) =>
				!(session.projectId
					? projectIds.has(session.projectId)
					: Boolean(session.workspaceRoot && projectPaths.has(session.workspaceRoot))),
		)
		.sort(byRecentActivity);
}

export function projectChatSummary(
	sessions: RuntimeSession[],
	project: ProjectLike | string,
): string {
	const count = projectChats(sessions, project).length;
	return `${count} chat${count === 1 ? "" : "s"}`;
}

export function projectFromPath(
	projects: Project[],
	path: string | undefined,
): Project | undefined {
	return path ? projects.find((project) => project.path === path) : undefined;
}
