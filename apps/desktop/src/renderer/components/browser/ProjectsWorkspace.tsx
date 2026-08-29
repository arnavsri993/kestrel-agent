import type { RuntimeSession, WorkspaceGrant } from "@kestrel/shared-types";
import { useEffect, useMemo, useState } from "react";
import { agentSessionRecency, agentSessionStatusLabel } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import {
	projectChatSummary,
	projectChats,
	sessionsWithoutProject,
} from "../../projects";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

export function ProjectsWorkspace({
	projects,
	sessions,
	activeProjectPath,
	onSelectProject,
	onNewChat,
	onOpenSession,
	onOpenSettings,
}: {
	projects: WorkspaceGrant[];
	sessions: RuntimeSession[];
	activeProjectPath: string | null;
	onSelectProject(projectPath: string): void;
	onNewChat(project: WorkspaceGrant): void;
	onOpenSession(sessionId: string): void;
	onOpenSettings(): void;
}) {
	const selectedProject =
		projects.find((project) => project.path === activeProjectPath) ?? projects[0];
	const [query, setQuery] = useState("");

	useEffect(() => {
		setQuery("");
	}, [selectedProject?.path]);

	const chats = useMemo(() => {
		if (!selectedProject) return [];
		const needle = query.trim().toLocaleLowerCase();
		return projectChats(sessions, selectedProject.path).filter((session) => {
			if (!needle) return true;
			return [session.title, agentSessionStatusLabel(session.status)]
				.join(" ")
				.toLocaleLowerCase()
				.includes(needle);
		});
	}, [query, selectedProject, sessions]);

	const projectChatCount = selectedProject
		? projectChats(sessions, selectedProject.path).length
		: 0;
	const configuredChatCount = sessionsWithoutProject(sessions, projects).length;

	return (
		<main className="projects-workspace" aria-labelledby="projects-workspace-title">
			<div className="page-frame">
				<header className="projects-workspace-header">
					<div className="projects-workspace-heading">
						<span className="projects-workspace-mark" aria-hidden="true">
							<BrandMark />
						</span>
						<div>
							<h1 id="projects-workspace-title" tabIndex={-1}>
								Projects
							</h1>
							<p>Keep related chats together with the local context they share.</p>
						</div>
					</div>
				</header>

				{projects.length > 0 && selectedProject ? (
					<div className="projects-workspace-layout">
						<nav
							className="projects-workspace-directory"
							aria-label="Projects"
						>
							<div className="projects-workspace-section-heading">
								<div>
									<span className="eyebrow">Workspace</span>
									<h2>Projects</h2>
								</div>
								<span className="projects-workspace-count">
									{projects.length}
								</span>
							</div>
							<ul>
								{projects.map((project) => {
									const selected = project.path === selectedProject.path;
									return (
										<li key={project.path}>
											<button
												type="button"
												className={`projects-workspace-project-option${selected ? " selected" : ""}`}
												aria-current={selected ? "page" : undefined}
												onClick={() => onSelectProject(project.path)}
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
												<Icon name="chevron" />
											</button>
										</li>
									);
								})}
							</ul>
							{configuredChatCount > 0 ? (
								<p className="projects-workspace-standalone-note">
									{configuredChatCount} recent chat
									{configuredChatCount === 1 ? "" : "s"} without a project
								</p>
							) : null}
						</nav>

						<section
							className="projects-workspace-detail"
							aria-labelledby="selected-project-title"
						>
							<header className="projects-workspace-detail-header">
								<div>
									<span className="eyebrow">Project</span>
									<h2 id="selected-project-title">{selectedProject.name}</h2>
									<p>
										Each chat keeps its own transcript while sharing this project&apos;s
										local folder context.
									</p>
								</div>
								<button
									type="button"
									className="button primary projects-workspace-new-chat"
									disabled={selectedProject.available === false}
									title={
										selectedProject.available === false
											? "Reconnect this folder in Settings before starting a chat"
											: `Start a new chat in ${selectedProject.name}`
									}
									onClick={() => onNewChat(selectedProject)}
								>
									<Icon name="plus" />
									New chat
								</button>
							</header>

							<div className="projects-workspace-context">
								<Icon
									name={selectedProject.available === false ? "warning" : "folder"}
								/>
								<span>
									<strong>
										{selectedProject.available === false
											? "Folder unavailable"
											: "Local folder context available"}
									</strong>
									<small>
										{selectedProject.available === false
											? "Saved chats remain available to read. Reconnect the folder in Settings to continue working."
											: "New chats in this project use the folder grant and its checked-in guidance."
									}
									</small>
								</span>
								{selectedProject.available === false ? (
									<button type="button" onClick={onOpenSettings}>
										Open Settings
									</button>
								) : null}
							</div>

							<div className="projects-workspace-chats-heading">
								<div>
									<span className="eyebrow">
										{projectChatCount} chat{projectChatCount === 1 ? "" : "s"}
									</span>
									<h3>Chats</h3>
									<p>Start one chat per outcome so the work stays focused.</p>
								</div>
								<label className="projects-workspace-search">
									<Icon name="search" />
									<span className="sr-only">Search chats in {selectedProject.name}</span>
									<input
										type="search"
										value={query}
										placeholder="Search chats…"
										onChange={(event) => setQuery(event.target.value)}
									/>
								</label>
							</div>

							{chats.length > 0 ? (
								<ul className="projects-workspace-chat-list">
									{chats.map((session) => (
										<li key={session.id}>
											<button
												type="button"
												className="projects-workspace-chat"
												aria-label={`${sessionTitleForDisplay(session.title)}, ${agentSessionStatusLabel(session.status)}`}
												onClick={() => onOpenSession(session.id)}
											>
												<span
													className={`projects-workspace-chat-state ${session.status}`}
													aria-hidden="true"
												/>
												<span className="projects-workspace-chat-copy">
													<strong>{sessionTitleForDisplay(session.title)}</strong>
													<small>{agentSessionStatusLabel(session.status)}</small>
												</span>
												<time dateTime={session.updatedAt}>
													{agentSessionRecency(session.updatedAt)}
												</time>
												<Icon name="chevron" />
											</button>
										</li>
									))}
								</ul>
							) : (
								<div className="projects-workspace-empty">
									<Icon name={query ? "search" : "chat"} />
									<h4>{query ? "No matching chats" : "No chats in this project yet"}</h4>
									<p>
										{query
											? "Try a different search."
											: selectedProject.available === false
												? "Reconnect the folder in Settings before starting new work."
												: "Start a new chat to create the first focused outcome here."}
									</p>
									{query ? (
										<button type="button" className="quiet-link" onClick={() => setQuery("")}>
											Clear search
										</button>
									) : selectedProject.available !== false ? (
										<button
											type="button"
											className="button primary"
											onClick={() => onNewChat(selectedProject)}
										>
											<Icon name="plus" />
											New chat
										</button>
									) : null}
								</div>
							)}
						</section>
					</div>
				) : (
					<section className="projects-workspace-empty projects-workspace-no-projects">
						<Icon name="folder" />
						<h2>No projects yet</h2>
						<p>
							Add a local project folder to keep related chats and their shared context
							together.
						</p>
						<button type="button" className="button primary" onClick={onOpenSettings}>
							Add project folder
						</button>
					</section>
				)}
			</div>
		</main>
	);
}
