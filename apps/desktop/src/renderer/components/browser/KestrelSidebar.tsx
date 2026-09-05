import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Project, RuntimeSession } from "@kestrel/shared-types";
import { sessionTitleForDisplay } from "../../chat-title";
import {
	projectChats,
	projectChatsForSidebar,
	sessionsWithoutProject,
} from "../../projects";
import {
	DEFAULT_PROJECT_APPEARANCE,
	projectColorValue,
	type ProjectAppearance,
	type ProjectAppearanceMap,
} from "../../project-appearance";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import type { SidebarDestination } from "./agent-sidebar";

const MAX_SIDEBAR_CHATS = 8;
const PROJECT_EXPANSION_DURATION_MS = 160;
const PROJECT_EXPANSION_SWITCH_DELAY_MS = PROJECT_EXPANSION_DURATION_MS + 80;
const PROJECT_EXPANDED_STORAGE_KEY = "kestrel:project-expanded";

type ContextMenuState =
	| { kind: "project"; id: string; top: number; left: number }
	| { kind: "chat"; id: string; top: number; left: number };

function readExpandedProjectId(projects: Project[]): string | null {
	try {
		const current = localStorage.getItem(PROJECT_EXPANDED_STORAGE_KEY);
		if (current && projects.some((project) => project.id === current))
			return current;
		const legacy = JSON.parse(
			localStorage.getItem("kestrel:projects-expanded") ?? "{}",
		) as unknown;
		if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
			return null;
		const expandedPath = Object.entries(legacy).find(
			([path, expanded]) => expanded === true && projects.some((project) => project.path === path),
		)?.[0];
		return projects.find((project) => project.path === expandedPath)?.id ?? null;
	} catch {
		return null;
	}
}

function persistExpandedProjectId(projectId: string | null): void {
	try {
		if (projectId) localStorage.setItem(PROJECT_EXPANDED_STORAGE_KEY, projectId);
		else localStorage.removeItem(PROJECT_EXPANDED_STORAGE_KEY);
	} catch {
		// Navigation state is helpful but never blocks a project action.
	}
}

function clampContextMenuPosition(top: number, left: number): { top: number; left: number } {
	return {
		top: Math.max(8, Math.min(top, window.innerHeight - 280)),
		left: Math.max(8, Math.min(left, window.innerWidth - 236)),
	};
}

function ProjectBadge({ appearance }: { appearance: ProjectAppearance }) {
	return (
		<span
			className="kestrel-sidebar-project-badge"
			style={{ "--project-color": projectColorValue(appearance.color) } as CSSProperties}
			aria-hidden="true"
		>
			<Icon name={appearance.icon} />
		</span>
	);
}

function SidebarNavItem({
	icon,
	label,
	active,
	destination,
	onClick,
}: {
	icon: string;
	label: string;
	active?: boolean;
	destination: SidebarDestination;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			className={`kestrel-sidebar-row kestrel-sidebar-nav-item${active ? " active" : ""}`}
			aria-current={active ? "page" : undefined}
			aria-label={label}
			title={label}
			data-destination={destination}
			onClick={onClick}
		>
			<Icon name={icon} />
			<span>{label}</span>
		</button>
	);
}

function SidebarContextMenu({
	menu,
	project,
	chat,
	projects,
	projectAppearances,
	onClose,
	onOpenProject,
	onNewProjectChat,
	onOpenProjectSettings,
	onOpenSession,
	onMoveSession,
}: {
	menu: ContextMenuState;
	project?: Project;
	chat?: RuntimeSession;
	projects: Project[];
	projectAppearances: ProjectAppearanceMap;
	onClose(): void;
	onOpenProject(project: Project): void;
	onNewProjectChat(project: Project): void;
	onOpenProjectSettings(project: Project): void;
	onOpenSession(sessionId: string): void;
	onMoveSession(sessionId: string, projectId: string | null): void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
	}, []);

	function action(run: () => void) {
		onClose();
		run();
	}

	return (
		<div
			ref={menuRef}
			className="kestrel-sidebar-context-menu"
			role="menu"
			style={{ top: menu.top, left: menu.left }}
			onContextMenu={(event) => event.preventDefault()}
		>
			{menu.kind === "project" && project ? (
				<>
					<button type="button" role="menuitem" onClick={() => action(() => onOpenProject(project))}>
						<Icon name="folder" />
						<span>Open project</span>
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={project.available === false}
						onClick={() => action(() => onNewProjectChat(project))}
					>
						<Icon name="plus" />
						<span>New chat</span>
					</button>
					<div className="kestrel-sidebar-context-menu-divider" role="separator" />
					<button type="button" role="menuitem" onClick={() => action(() => onOpenProjectSettings(project))}>
						<Icon name="settings" />
						<span>Project settings</span>
					</button>
				</>
			) : chat ? (
				<>
					<button type="button" role="menuitem" onClick={() => action(() => onOpenSession(chat.id))}>
						<Icon name="chat" />
						<span>Open chat</span>
					</button>
					<div className="kestrel-sidebar-context-menu-label">Move to project</div>
					{projects.length > 0 ? (
						projects.map((target) => (
							<button
								type="button"
								role="menuitem"
								key={target.id}
								disabled={target.id === chat.projectId || target.available === false}
								onClick={() => action(() => onMoveSession(chat.id, target.id))}
							>
								<ProjectBadge
									appearance={
										projectAppearances[target.path] ?? DEFAULT_PROJECT_APPEARANCE
									}
								/>
								<span>{target.name}</span>
							</button>
						))
					) : (
						<span className="kestrel-sidebar-context-menu-empty">No projects yet</span>
					)}
					{chat.projectId ? (
						<button type="button" role="menuitem" onClick={() => action(() => onMoveSession(chat.id, null))}>
							<Icon name="arrow" />
							<span>Remove from project</span>
						</button>
					) : null}
				</>
			) : null}
		</div>
	);
}

export function KestrelSidebar({
	activeDestination,
	activeSessionId,
	activeProjectId,
	agentName,
	sessions,
	projects,
	projectAppearances,
	onNewTask,
	onOpenBrowser,
	onOpenAgent,
	onOpenCapabilities,
	onOpenSettings,
	onCreateProject,
	onOpenProject,
	onOpenProjectChat,
	onOpenProjectSettings,
	onOpenSession,
	onMoveSession,
}: {
	activeDestination: SidebarDestination;
	activeSessionId: string | null;
	activeProjectId: string | null;
	agentName: string;
	sessions: RuntimeSession[];
	projects: Project[];
	projectAppearances: ProjectAppearanceMap;
	onNewTask(): void;
	onOpenBrowser(): void;
	onOpenAgent(): void;
	onOpenCapabilities(): void;
	onOpenSettings(): void;
	onCreateProject(): void;
	onOpenProject(project: Project): void;
	onOpenProjectChat(project: Project): void;
	onOpenProjectSettings(project: Project): void;
	onOpenSession(sessionId: string): void;
	onMoveSession(sessionId: string, projectId: string | null): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [collapsed, setCollapsed] = useState(
		() => localStorage.getItem("kestrel:navigation-sidebar") === "collapsed",
	);
	const [expandedProjectId, setExpandedProjectId] = useState<string | null>(() =>
		readExpandedProjectId(projects),
	);
	const expandedProjectIdRef = useRef(expandedProjectId);
	const expansionTimerRef = useRef<number | null>(null);
	const pendingExpandedProjectIdRef = useRef<string | null>(null);
	const manuallyCollapsedProjectIdRef = useRef<string | null>(null);
	const [visibleProjectChats, setVisibleProjectChats] = useState<Record<string, number>>({});
	const [globalChatLimit, setGlobalChatLimit] = useState(MAX_SIDEBAR_CHATS);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

	const chats = useMemo(
		() => sessionsWithoutProject(sessions, projects).slice(0, globalChatLimit),
		[globalChatLimit, projects, sessions],
	);
	const allChats = useMemo(() => sessionsWithoutProject(sessions, projects), [projects, sessions]);

	function cancelPendingProjectExpansion() {
		if (expansionTimerRef.current !== null) {
			window.clearTimeout(expansionTimerRef.current);
			expansionTimerRef.current = null;
		}
		pendingExpandedProjectIdRef.current = null;
	}

	function commitExpandedProjectId(projectId: string | null) {
		expandedProjectIdRef.current = projectId;
		setExpandedProjectId(projectId);
		persistExpandedProjectId(projectId);
	}

	function selectExpandedProject(projectId: string) {
		const current = expandedProjectIdRef.current;
		const next = current === projectId ? null : projectId;
		cancelPendingProjectExpansion();
		manuallyCollapsedProjectIdRef.current = next ? null : projectId;
		if (current && next && current !== next) {
			pendingExpandedProjectIdRef.current = next;
			commitExpandedProjectId(null);
			// Keep the durable preference aligned with the user's choice while the
			// outgoing project finishes its short collapse animation.
			persistExpandedProjectId(next);
			expansionTimerRef.current = window.setTimeout(
				finishPendingProjectExpansion,
				reducedMotion ? 0 : PROJECT_EXPANSION_SWITCH_DELAY_MS,
			);
			return;
		}
		commitExpandedProjectId(next);
	}

	function finishPendingProjectExpansion() {
		expansionTimerRef.current = null;
		const pending = pendingExpandedProjectIdRef.current;
		pendingExpandedProjectIdRef.current = null;
		if (pending && projects.some((project) => project.id === pending))
			commitExpandedProjectId(pending);
	}

	useEffect(() => {
		if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
			if (pendingExpandedProjectIdRef.current === activeProjectId) return;
			if (manuallyCollapsedProjectIdRef.current === activeProjectId) return;
			if (expandedProjectIdRef.current !== activeProjectId)
				commitExpandedProjectId(activeProjectId);
		}
	}, [activeProjectId, projects]);

	useEffect(() => {
		if (projects.length === 0) return;
		if (pendingExpandedProjectIdRef.current) {
			if (projects.some((project) => project.id === pendingExpandedProjectIdRef.current))
				return;
			cancelPendingProjectExpansion();
		}
		const current = expandedProjectIdRef.current;
		if (current && projects.some((project) => project.id === current)) return;
		const persisted = readExpandedProjectId(projects);
		if (persisted) commitExpandedProjectId(persisted);
	}, [projects]);

	useEffect(() => {
		if (expandedProjectId && !projects.some((project) => project.id === expandedProjectId)) {
			cancelPendingProjectExpansion();
			commitExpandedProjectId(null);
		}
	}, [expandedProjectId, projects]);

	useEffect(() => () => cancelPendingProjectExpansion(), []);

	useEffect(() => {
		if (!contextMenu) return;
		function closeOnOutsidePointer(event: PointerEvent) {
			if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return;
			setContextMenu(null);
		}
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				setContextMenu(null);
			}
		}
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [contextMenu]);

	function appearanceForProject(project: Project): ProjectAppearance {
		return projectAppearances[project.path] ?? DEFAULT_PROJECT_APPEARANCE;
	}

	function openProjectContextMenu(event: ReactMouseEvent, project: Project) {
		event.preventDefault();
		setContextMenu({
			kind: "project",
			id: project.id,
			...clampContextMenuPosition(event.clientY, event.clientX),
		});
	}

	function openChatContextMenu(event: ReactMouseEvent, chat: RuntimeSession) {
		event.preventDefault();
		setContextMenu({
			kind: "chat",
			id: chat.id,
			...clampContextMenuPosition(event.clientY, event.clientX),
		});
	}

	function openContextMenuFromKeyboard(
		event: ReactKeyboardEvent,
		kind: ContextMenuState["kind"],
		id: string,
		current: HTMLElement,
	) {
		if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
		event.preventDefault();
		const rect = current.getBoundingClientRect();
		setContextMenu({
			kind,
			id,
			...clampContextMenuPosition(rect.bottom + 4, rect.left + 8),
		});
	}

	function setExpanded(projectId: string) {
		selectExpandedProject(projectId);
	}

	function toggleCollapsed() {
		setCollapsed((current) => {
			const next = !current;
			localStorage.setItem("kestrel:navigation-sidebar", next ? "collapsed" : "open");
			return next;
		});
	}

	const contextProject = contextMenu?.kind === "project"
		? projects.find((project) => project.id === contextMenu.id)
		: undefined;
	const contextChat = contextMenu?.kind === "chat"
		? sessions.find((session) => session.id === contextMenu.id)
		: undefined;

	return (
		<aside
			className={`kestrel-sidebar${collapsed ? " is-collapsed" : ""}`}
			aria-label="Kestrel navigation"
			data-collapsed={collapsed}
			data-active-destination={activeDestination}
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
						aria-label="Open command center"
						title="Open command center (⌘K)"
						onClick={onOpenCapabilities}
					>
						<Icon name="search" />
					</button>
					<button
						type="button"
						className="kestrel-sidebar-icon-button"
						aria-label="Open settings"
						title="Settings"
						onClick={onOpenSettings}
					>
						<Icon name="settings" />
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

			<button
				type="button"
				className="kestrel-sidebar-row kestrel-sidebar-new-task"
				aria-label="New chat"
				title="New chat"
				aria-keyshortcuts="Meta+N"
				onClick={onNewTask}
			>
				<Icon name="plus" />
				<span>New chat</span>
				<kbd>⌘N</kbd>
			</button>
			<nav className="kestrel-sidebar-primary" aria-label="Primary">
				<SidebarNavItem
					icon="agent"
					label="Agent"
					destination="agent"
					active={activeDestination === "agent"}
					onClick={onOpenAgent}
				/>
			</nav>

			<div className="kestrel-sidebar-scroll">
				<section className="kestrel-sidebar-section" aria-labelledby="kestrel-sidebar-projects">
					<div className="kestrel-sidebar-section-heading">
						<h2 id="kestrel-sidebar-projects">Projects</h2>
						<button
							type="button"
							className="kestrel-sidebar-section-action"
							aria-label="Create project"
							title="Create project"
							onClick={onCreateProject}
						>
							<Icon name="plus" />
						</button>
					</div>
					{projects.length > 0 ? (
						<ul className="kestrel-sidebar-project-list">
							{projects.map((project) => {
								const allProjectChats = projectChats(sessions, project);
								const expanded = expandedProjectId === project.id;
								const limit = visibleProjectChats[project.id] ?? 5;
								const previewChats = projectChatsForSidebar(sessions, project, limit);
								return (
									<li key={project.id} className="kestrel-sidebar-project">
										<button
											type="button"
											className={`kestrel-sidebar-row kestrel-sidebar-project-open${activeProjectId === project.id ? " active" : ""}`}
											aria-current={activeProjectId === project.id ? "page" : undefined}
											aria-expanded={expanded}
											aria-controls={`kestrel-sidebar-project-chats-${project.id}`}
											aria-label={`${expanded ? "Collapse" : "Open"} ${project.name} project`}
											title={`${expanded ? "Collapse" : "Open"} ${project.name}`}
											onClick={() => {
												setExpanded(project.id);
												onOpenProject(project);
											}}
											onContextMenu={(event) => openProjectContextMenu(event, project)}
											onKeyDown={(event) => openContextMenuFromKeyboard(event, "project", project.id, event.currentTarget)}
										>
											<ProjectBadge appearance={appearanceForProject(project)} />
											<span>{project.name}</span>
											<Icon name="chevron" />
										</button>
										<AnimatePresence initial={false}>
											{expanded ? (
												<motion.div
													key={`${project.id}-chats`}
													id={`kestrel-sidebar-project-chats-${project.id}`}
													className="kestrel-sidebar-project-chat-group"
													role="group"
													aria-label={`Chats in ${project.name}`}
													initial={reducedMotion ? false : { height: 0, opacity: 0 }}
													animate={{ height: "auto", opacity: 1 }}
													exit={{ height: 0, opacity: 0 }}
													transition={{
														duration: reducedMotion ? 0 : PROJECT_EXPANSION_DURATION_MS / 1000,
														ease: [0.25, 1, 0.35, 1],
													}}
													style={{ overflow: "hidden" }}
												>
													{allProjectChats.length > 0 ? (
														<ul className="kestrel-sidebar-project-chats">
															{previewChats.map((session) => (
																<li key={session.id}>
																	<button
																		type="button"
																		className={`kestrel-sidebar-row kestrel-sidebar-project-chat${session.id === activeSessionId ? " active" : ""}`}
																		aria-current={session.id === activeSessionId ? "page" : undefined}
																		title={sessionTitleForDisplay(session.title)}
																		onClick={() => onOpenSession(session.id)}
																		onContextMenu={(event) => openChatContextMenu(event, session)}
																		onKeyDown={(event) => openContextMenuFromKeyboard(event, "chat", session.id, event.currentTarget)}
																	>
																		<span>{sessionTitleForDisplay(session.title)}</span>
																	</button>
																</li>
															))}
															{allProjectChats.length > previewChats.length ? (
																<li>
																	<button
																		type="button"
																		className="kestrel-sidebar-project-view-all"
																		title={`Show more chats in ${project.name}`}
																		onClick={() => setVisibleProjectChats((current) => ({ ...current, [project.id]: previewChats.length + 5 }))}
																	>
																		<span>Show more</span>
																		<Icon name="chevron" aria-hidden="true" />
																	</button>
																</li>
															) : null}
														</ul>
													) : (
														<p className="kestrel-sidebar-project-no-chats">No chats yet</p>
													)}
												</motion.div>
											) : null}
										</AnimatePresence>
									</li>
								);
							})}
						</ul>
					) : (
						<div className="kestrel-sidebar-empty">
							<p>No projects yet</p>
							<button type="button" onClick={onCreateProject}>Create project</button>
						</div>
					)}
				</section>

				<section className="kestrel-sidebar-section kestrel-sidebar-chats" aria-labelledby="kestrel-sidebar-chats">
					<div className="kestrel-sidebar-section-heading">
						<h2 id="kestrel-sidebar-chats">Chats</h2>
					</div>
					{chats.length > 0 ? (
						<ul>
							{chats.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										className={`kestrel-sidebar-row kestrel-sidebar-list-item${session.id === activeSessionId ? " active" : ""}`}
										aria-current={session.id === activeSessionId ? "page" : undefined}
										title={sessionTitleForDisplay(session.title)}
										onClick={() => onOpenSession(session.id)}
										onContextMenu={(event) => openChatContextMenu(event, session)}
										onKeyDown={(event) => openContextMenuFromKeyboard(event, "chat", session.id, event.currentTarget)}
									>
										<span>{sessionTitleForDisplay(session.title)}</span>
									</button>
								</li>
							))}
						</ul>
					) : allChats.length > 0 ? null : (
						<div className="kestrel-sidebar-empty"><p>No chats yet</p></div>
					)}
					{allChats.length > chats.length ? (
						<button type="button" className="kestrel-sidebar-view-more" onClick={() => setGlobalChatLimit((current) => current + MAX_SIDEBAR_CHATS)}>
							Show more
						</button>
					) : null}
				</section>
			</div>

			{contextMenu && (contextProject || contextChat) ? (
				<div ref={contextMenuRef}>
					<SidebarContextMenu
						menu={contextMenu}
						{...(contextProject ? { project: contextProject } : {})}
						{...(contextChat ? { chat: contextChat } : {})}
						projects={projects}
						projectAppearances={projectAppearances}
						onClose={() => setContextMenu(null)}
						onOpenProject={onOpenProject}
						onNewProjectChat={onOpenProjectChat}
						onOpenProjectSettings={onOpenProjectSettings}
						onOpenSession={onOpenSession}
						onMoveSession={onMoveSession}
					/>
				</div>
			) : null}

		</aside>
	);
}
