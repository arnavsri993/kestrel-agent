import { useMemo, useState } from "react";
import type { RuntimeSession, WorkspaceGrant } from "@kestrel/shared-types";
import { sessionTitleForDisplay } from "../../chat-title";
import {
	projectChatSummary,
	projectChats,
	projectChatsForSidebar,
	sessionsWithoutProject,
} from "../../projects";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import type { SidebarDestination } from "./agent-sidebar";

const MAX_SIDEBAR_CHATS = 8;

function recentChats(
	sessions: RuntimeSession[],
	projects: WorkspaceGrant[],
): RuntimeSession[] {
	return sessionsWithoutProject(sessions, projects).slice(0, MAX_SIDEBAR_CHATS);
}

function readExpandedProjects(): Record<string, boolean> {
	try {
		const stored = JSON.parse(
			localStorage.getItem("kestrel:projects-expanded") ?? "{}",
		) as unknown;
		if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
		return Object.fromEntries(
			Object.entries(stored).filter(
				(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
			),
		);
	} catch {
		return {};
	}
}

function SidebarNavItem({
	icon,
	label,
	active,
	badge,
	destination,
	onClick,
}: {
	icon: string;
	label: string;
	active?: boolean;
	badge?: number;
	destination?: SidebarDestination;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			className={`kestrel-sidebar-nav-item${active ? " active" : ""}`}
			aria-current={active ? "page" : undefined}
			aria-label={label}
			title={label}
			data-destination={destination}
			onClick={onClick}
		>
			<Icon name={icon} />
			<span>{label}</span>
			{badge ? (
				<small aria-label={`${badge} pending`}>
					{badge > 9 ? "9+" : badge}
				</small>
			) : null}
		</button>
	);
}

export function KestrelSidebar({
	activeDestination,
	activeSessionId,
	activeProjectPath,
	agentName,
	pendingApprovals,
	sessions,
	projects,
	onNewTask,
	onOpenBrowser,
	onOpenAgent,
	onOpenWriting,
	onReviewApprovals,
	onOpenCapabilities,
	onOpenProjects,
	onOpenSettings,
	onOpenProject,
	onOpenProjectChat,
	onOpenSession,
	onOpenTaskHistory,
}: {
	activeDestination: SidebarDestination;
	activeSessionId: string | null;
	activeProjectPath: string | null;
	agentName: string;
	pendingApprovals: number;
	sessions: RuntimeSession[];
	projects: WorkspaceGrant[];
	onNewTask(): void;
	onOpenBrowser(): void;
	onOpenAgent(): void;
	onOpenWriting(): void;
	onReviewApprovals(): void;
	onOpenCapabilities(): void;
	onOpenProjects(): void;
	onOpenSettings(): void;
	onOpenProject(project: WorkspaceGrant): void;
	onOpenProjectChat(project: WorkspaceGrant): void;
	onOpenSession(sessionId: string): void;
	onOpenTaskHistory(): void;
}) {
	const [collapsed, setCollapsed] = useState(
		() => localStorage.getItem("kestrel:navigation-sidebar") === "collapsed",
	);
	const [expandedProjects, setExpandedProjects] = useState(readExpandedProjects);
	const chats = useMemo(() => recentChats(sessions, projects), [projects, sessions]);

	function toggleProject(projectPath: string) {
		setExpandedProjects((current) => {
			const next = { ...current, [projectPath]: !(current[projectPath] ?? true) };
			localStorage.setItem("kestrel:projects-expanded", JSON.stringify(next));
			return next;
		});
	}

	function toggleCollapsed() {
		setCollapsed((current) => {
			const next = !current;
			localStorage.setItem(
				"kestrel:navigation-sidebar",
				next ? "collapsed" : "open",
			);
			return next;
		});
	}

	return (
		<aside
			className={`kestrel-sidebar${collapsed ? " is-collapsed" : ""}`}
			aria-label="Kestrel navigation"
			data-collapsed={collapsed}
		>
			<div className="kestrel-sidebar-drag" />
			<header className="kestrel-sidebar-header">
				<button
					type="button"
					className="kestrel-sidebar-brand"
					aria-label={`Open ${agentName} browser`}
					title={`Open ${agentName} browser`}
					onClick={onOpenBrowser}
				>
					<BrandMark className="kestrel-sidebar-brand-mark" />
					<span>Kestrel</span>
				</button>
				<div className="kestrel-sidebar-header-actions">
					<button
						type="button"
						className="kestrel-sidebar-icon-button"
						aria-label="Search capabilities and shortcuts"
						title="Search capabilities and shortcuts"
						onClick={onOpenCapabilities}
					>
						<Icon name="search" />
					</button>
					<button
						type="button"
						className="kestrel-sidebar-icon-button kestrel-sidebar-collapse"
						aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
						aria-expanded={!collapsed}
						title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
						onClick={toggleCollapsed}
					>
						<Icon name="chevron" />
					</button>
				</div>
			</header>

			<nav className="kestrel-sidebar-primary" aria-label="Primary">
				<button
					type="button"
					className="kestrel-sidebar-new-task"
					aria-label="New task"
					title="New task"
					aria-keyshortcuts="Meta+N"
					onClick={onNewTask}
				>
					<Icon name="plus" />
					<span>New task</span>
					<kbd>⌘N</kbd>
				</button>
				<SidebarNavItem
					icon="agent"
					label="Agent"
					destination="agent"
					active={activeDestination === "agent"}
					onClick={onOpenAgent}
				/>
				<SidebarNavItem
					icon="writing"
					label="Writing Studio"
					destination="writing"
					active={activeDestination === "writing"}
					onClick={onOpenWriting}
				/>
				<SidebarNavItem
					icon="approvals"
					label="Approvals"
					destination="approvals"
					badge={pendingApprovals}
					active={activeDestination === "approvals"}
					onClick={onReviewApprovals}
				/>
				<SidebarNavItem
					icon="command"
					label="Capabilities"
					destination="capabilities"
					active={activeDestination === "capabilities"}
					onClick={onOpenCapabilities}
				/>
			</nav>

			<div className="kestrel-sidebar-scroll">
				<section className="kestrel-sidebar-section" aria-labelledby="kestrel-sidebar-projects">
					<div className="kestrel-sidebar-section-heading">
						<h2 id="kestrel-sidebar-projects">Projects</h2>
						<button
							type="button"
							className="kestrel-sidebar-section-action"
							aria-label="Open all projects"
							title="Open all projects"
							onClick={onOpenProjects}
						>
							<Icon name="chevron" />
						</button>
					</div>
					{projects.length > 0 ? (
						<ul className="kestrel-sidebar-project-list">
							{projects.map((project) => {
								const previewChats = projectChatsForSidebar(sessions, project.path);
								const allProjectChats = projectChats(sessions, project.path);
								const expanded = expandedProjects[project.path] ?? true;
								return (
									<li key={project.path} className="kestrel-sidebar-project">
										<div className="kestrel-sidebar-project-row">
											<button
												type="button"
												className={`kestrel-sidebar-project-open${activeProjectPath === project.path ? " active" : ""}`}
												aria-current={activeProjectPath === project.path ? "page" : undefined}
												aria-label={`Open ${project.name} project`}
												title={`Open ${project.name} project`}
												onClick={() => onOpenProject(project)}
											>
												<Icon name="folder" />
												<span>
													<strong>{project.name}</strong>
													<small>
														{project.available === false
															? "Folder unavailable"
															: projectChatSummary(sessions, project.path)}
													</small>
												</span>
											</button>
											<button
												type="button"
												className="kestrel-sidebar-project-new"
												aria-label={`New chat in ${project.name}`}
												title={
													project.available === false
														? "Reconnect this folder in Settings before starting a chat"
														: `New chat in ${project.name}`
												}
												disabled={project.available === false}
												onClick={() => onOpenProjectChat(project)}
											>
												<Icon name="plus" />
											</button>
											<button
												type="button"
												className={`kestrel-sidebar-project-toggle${expanded ? " expanded" : ""}`}
												aria-expanded={expanded}
												aria-label={`${expanded ? "Hide" : "Show"} chats in ${project.name}`}
												title={`${expanded ? "Hide" : "Show"} chats in ${project.name}`}
												onClick={() => toggleProject(project.path)}
											>
												<Icon name="chevron" />
											</button>
										</div>
										{expanded ? (
											allProjectChats.length > 0 ? (
												<ul className="kestrel-sidebar-project-chats">
													{previewChats.map((session) => (
														<li key={session.id}>
															<button
																type="button"
																className={`kestrel-sidebar-project-chat${session.id === activeSessionId ? " active" : ""}`}
																aria-current={session.id === activeSessionId ? "page" : undefined}
																title={sessionTitleForDisplay(session.title)}
																onClick={() => onOpenSession(session.id)}
															>
																<Icon name="chat" />
																<span>{sessionTitleForDisplay(session.title)}</span>
															</button>
														</li>
													))}
													{allProjectChats.length > previewChats.length ? (
														<li>
															<button
																type="button"
																className="kestrel-sidebar-project-view-all"
																onClick={() => onOpenProject(project)}
															>
																View all {allProjectChats.length} chats
															</button>
														</li>
													) : null}
												</ul>
											) : (
												<p className="kestrel-sidebar-project-no-chats">No chats yet</p>
											)
										) : null}
									</li>
								);
							})}
						</ul>
					) : (
						<div className="kestrel-sidebar-empty">
							<p>No projects yet</p>
							<button type="button" onClick={onOpenSettings}>
								Add folders in Settings
							</button>
						</div>
					)}
				</section>

				<section className="kestrel-sidebar-section kestrel-sidebar-chats" aria-labelledby="kestrel-sidebar-chats">
					<div className="kestrel-sidebar-section-heading">
						<h2 id="kestrel-sidebar-chats">Recent tasks</h2>
						<button
							type="button"
							className="kestrel-sidebar-section-action"
							aria-label="Open all task history"
							title="Open all task history"
							onClick={onOpenTaskHistory}
						>
							<Icon name="chevron" />
						</button>
					</div>
					{chats.length > 0 ? (
						<ul>
							{chats.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										className={`kestrel-sidebar-list-item${session.id === activeSessionId ? " active" : ""}`}
										aria-current={session.id === activeSessionId ? "page" : undefined}
										title={sessionTitleForDisplay(session.title)}
										onClick={() => onOpenSession(session.id)}
									>
										<Icon name="chat" />
										<span>{sessionTitleForDisplay(session.title)}</span>
									</button>
								</li>
							))}
						</ul>
					) : (
						<div className="kestrel-sidebar-empty">
							<p>No chats yet</p>
							<button type="button" onClick={onNewTask}>
								Start a task
							</button>
						</div>
					)}
				</section>
			</div>

			<footer className="kestrel-sidebar-footer">
				<div className="kestrel-sidebar-local-status" aria-hidden="true">
					<span />
				</div>
				<SidebarNavItem
					icon="settings"
					label="Settings"
					destination="settings"
					active={activeDestination === "settings"}
					onClick={onOpenSettings}
				/>
			</footer>
		</aside>
	);
}
