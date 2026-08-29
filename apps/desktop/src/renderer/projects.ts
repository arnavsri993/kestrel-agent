import type { RuntimeSession, WorkspaceGrant } from "@kestrel/shared-types";

export const PROJECT_SIDEBAR_CHAT_LIMIT = 5;

function byRecentActivity(left: RuntimeSession, right: RuntimeSession): number {
	return right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * Local projects are folder-backed in Kestrel. A session keeps the folder it
 * was created with, which gives every project a durable relationship to its
 * chats without introducing a second, competing chat store.
 */
export function projectChats(
	sessions: RuntimeSession[],
	projectPath: string,
): RuntimeSession[] {
	return sessions
		.filter((session) => session.workspaceRoot === projectPath)
		.sort(byRecentActivity);
}

export function projectChatsForSidebar(
	sessions: RuntimeSession[],
	projectPath: string,
	limit = PROJECT_SIDEBAR_CHAT_LIMIT,
): RuntimeSession[] {
	return projectChats(sessions, projectPath).slice(0, Math.max(0, limit));
}

/**
 * Keep project chats in their project section. Sessions without a configured
 * project remain in Recent tasks, as do sessions whose old folder is no longer
 * present in the configured project list.
 */
export function sessionsWithoutProject(
	sessions: RuntimeSession[],
	projects: WorkspaceGrant[],
): RuntimeSession[] {
	const projectPaths = new Set(projects.map((project) => project.path));
	return sessions
		.filter(
			(session) =>
				!session.workspaceRoot || !projectPaths.has(session.workspaceRoot),
		)
		.sort(byRecentActivity);
}

export function projectChatSummary(
	sessions: RuntimeSession[],
	projectPath: string,
): string {
	const count = projectChats(sessions, projectPath).length;
	return `${count} chat${count === 1 ? "" : "s"}`;
}
