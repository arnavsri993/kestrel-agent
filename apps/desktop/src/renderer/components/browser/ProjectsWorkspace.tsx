import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Project, RuntimeSession } from "@kestrel/shared-types";
import { agentSessionRecency } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { projectChats } from "../../projects";
import {
	DEFAULT_PROJECT_APPEARANCE,
	projectColorValue,
	type ProjectAppearanceMap,
} from "../../project-appearance";
import { Icon } from "../Icon";
import { PageFrame } from "../ui";
import "./surface-pages.css";

function ProjectMark({
	project,
	appearances,
}: {
	project: Project;
	appearances: ProjectAppearanceMap;
}) {
	const appearance = appearances[project.path] ?? DEFAULT_PROJECT_APPEARANCE;
	return (
		<span
			className="projects-workspace-project-mark"
			style={
				{
					"--project-color": projectColorValue(appearance.color),
				} as CSSProperties
			}
			aria-hidden="true"
		>
			<Icon name={appearance.icon} />
		</span>
	);
}

export function ProjectsWorkspace({
	projects,
	sessions,
	activeProjectId,
	projectAppearances,
	onNewChat,
	onOpenSession,
	onOpenProjectSettings,
	onOpenConnections,
	onCreateProject,
}: {
	projects: Project[];
	sessions: RuntimeSession[];
	activeProjectId: string | null;
	projectAppearances: ProjectAppearanceMap;
	onNewChat(project: Project): void;
	onOpenSession(sessionId: string): void;
	onOpenProjectSettings(project: Project): void;
	onOpenConnections(): void;
	onCreateProject(): void;
}) {
	const selectedProject =
		projects.find((project) => project.id === activeProjectId) ?? projects[0];
	const [query, setQuery] = useState("");

	useEffect(() => {
		setQuery("");
	}, [selectedProject?.id]);

	const chats = useMemo(() => {
		if (!selectedProject) return [];
		const needle = query.trim().toLocaleLowerCase();
		return projectChats(sessions, selectedProject).filter(
			(session) =>
				!needle ||
				sessionTitleForDisplay(session.title)
					.toLocaleLowerCase()
					.includes(needle),
		);
	}, [query, selectedProject, sessions]);

	return (
		<main
			className="projects-workspace"
			aria-labelledby="projects-workspace-title"
		>
			<PageFrame
				as="div"
				measure="wide"
			>
				{selectedProject ? (
					<div className="projects-workspace-home">
						<header className="projects-workspace-header">
							<div className="projects-workspace-heading">
								<ProjectMark
									project={selectedProject}
									appearances={projectAppearances}
								/>
								<div>
									<span className="eyebrow">Project</span>
									<h1 id="projects-workspace-title">{selectedProject.name}</h1>
									<p>
										{selectedProject.instructions?.trim()
											? "Project instructions apply to conversations here."
											: "Conversations here share this project's local context."}
									</p>
								</div>
							</div>
							<div className="projects-workspace-actions">
								<button
									type="button"
									className="button secondary"
									onClick={() => onOpenProjectSettings(selectedProject)}
								>
									<Icon name="settings" />
									Settings
								</button>
								<button
									type="button"
									className="button primary"
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
							</div>
						</header>

						{selectedProject.instructions?.trim() ? (
							<section
								className="projects-workspace-instructions"
								aria-labelledby="projects-workspace-instructions-title"
							>
								<h2 id="projects-workspace-instructions-title">
									Project instructions
								</h2>
								<p>{selectedProject.instructions}</p>
							</section>
						) : null}

						<section
							className="projects-workspace-conversations"
							aria-labelledby="projects-workspace-chats-title"
						>
							<header className="projects-workspace-chats-heading">
								<div>
									<h2 id="projects-workspace-chats-title">Chats</h2>
									<p>Each conversation keeps its own transcript.</p>
								</div>
								<label className="projects-workspace-search">
									<Icon name="search" />
									<span className="sr-only">
										Search chats in {selectedProject.name}
									</span>
									<input
										type="search"
										value={query}
										placeholder="Search chats…"
										onChange={(event) => setQuery(event.target.value)}
									/>
								</label>
							</header>

							{chats.length > 0 ? (
								<ul className="projects-workspace-chat-list">
									{chats.map((session) => (
										<li key={session.id}>
											<button
												type="button"
												className="projects-workspace-chat"
												aria-label={sessionTitleForDisplay(session.title)}
												onClick={() => onOpenSession(session.id)}
											>
												<strong>
													{sessionTitleForDisplay(session.title)}
												</strong>
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
									<h3>
										{query
											? "No matching chats"
											: "No chats in this project yet"}
									</h3>
									<p>
										{query
											? "Try a different search."
											: selectedProject.available === false
												? "Reconnect the folder in Settings before starting new work."
												: "Start a new chat to create the first conversation here."}
									</p>
									{query ? (
										<button
											type="button"
											className="quiet-link"
											onClick={() => setQuery("")}
										>
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
									) : (
										<button
											type="button"
											className="quiet-link"
											onClick={onOpenConnections}
										>
											Open Settings
										</button>
									)}
								</div>
							)}
						</section>
					</div>
				) : (
					<section className="projects-workspace-empty projects-workspace-no-projects">
						<h1 id="projects-workspace-title">No projects yet</h1>
						<p>
							Add a local project folder to keep related conversations and their
							shared context together.
						</p>
						<button
							type="button"
							className="button primary"
							onClick={onCreateProject}
						>
							<Icon name="plus" />
							Create project
						</button>
					</section>
				)}
			</PageFrame>
		</main>
	);
}
