import { useMemo, useState } from "react";
import type { RuntimeSession, WorkspaceGrant } from "@kestrel/shared-types";
import { sessionTitleForDisplay } from "../../chat-title";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import type { SidebarDestination } from "./agent-sidebar";

const MAX_SIDEBAR_CHATS = 8;

function recentChats(sessions: RuntimeSession[]): RuntimeSession[] {
	return [...sessions]
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.slice(0, MAX_SIDEBAR_CHATS);
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
	onOpenSettings,
	onOpenProject,
	onOpenSession,
	onOpenTaskHistory,
}: {
	activeDestination: SidebarDestination;
	activeSessionId: string | null;
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
	onOpenSettings(): void;
	onOpenProject(project: WorkspaceGrant): void;
	onOpenSession(sessionId: string): void;
	onOpenTaskHistory(): void;
}) {
	const [collapsed, setCollapsed] = useState(
		() => localStorage.getItem("kestrel:navigation-sidebar") === "collapsed",
	);
	const chats = useMemo(() => recentChats(sessions), [sessions]);

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
					<h2 id="kestrel-sidebar-projects">Projects</h2>
					{projects.length > 0 ? (
						<ul>
							{projects.map((project) => (
								<li key={project.path}>
									<button
										type="button"
										className="kestrel-sidebar-list-item"
										title={`Start a task in ${project.name}`}
										onClick={() => onOpenProject(project)}
									>
										<Icon name="work" />
										<span>{project.name}</span>
									</button>
								</li>
							))}
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
