import type { AgentState, RuntimeSession } from "@kestrel/shared-types";
import { useMemo, useState } from "react";
import {
	type AgentSessionFilter,
	agentSessionRecency,
	agentSessionStatusLabel,
	agentSessionTreeForWorkspace,
	agentStateLabel,
	agentWorkspaceName,
} from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { SurfaceBackButton } from "./SurfaceBackButton";

const filters: Array<{ id: AgentSessionFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "open", label: "Open" },
	{ id: "done", label: "Completed" },
];

export function AgentWorkspace({
	sessions,
	activeSessionId,
	agentState,
	pendingApprovals,
	onNewTask,
	onOpenSession,
	onOpenApprovals,
	onOpenWork,
	onBack,
}: {
	sessions: RuntimeSession[];
	activeSessionId: string | null;
	agentState: AgentState;
	pendingApprovals: number;
	onNewTask(): void;
	onOpenSession(sessionId: string): void;
	onOpenApprovals(): void;
	onOpenWork(): void;
	onBack?(): void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<AgentSessionFilter>("all");
	const visibleSessions = useMemo(
		() => agentSessionTreeForWorkspace(sessions, query, filter),
		[filter, query, sessions],
	);
	const openCount = sessions.filter((session) =>
		["active", "waiting"].includes(session.status),
	).length;

	return (
		<main className="agent-workspace" aria-labelledby="agent-workspace-title">
			<header className="agent-workspace-header">
				{onBack && <SurfaceBackButton onBack={onBack} />}
				<div className="agent-workspace-heading">
					<span className="agent-workspace-mark" aria-hidden="true">
						<BrandMark />
					</span>
					<div>
						<h1 id="agent-workspace-title" tabIndex={-1}>
							Agent Workspace
						</h1>
					</div>
				</div>
				<button type="button" className="button primary" onClick={onNewTask}>
					<Icon name="agent" />
					New task
				</button>
			</header>

			<section className="agent-workspace-status" aria-label="Agent status">
				<div>
					<span className={`agent-dot ${agentState}`} aria-hidden="true" />
					<span>
						<small>Agent</small>
						<strong>{agentStateLabel(agentState)}</strong>
					</span>
				</div>
				<div>
					<Icon name="work" />
					<span>
						<small>Tasks</small>
						<strong>{openCount} open</strong>
					</span>
				</div>
				<button type="button" onClick={onOpenApprovals}>
					<Icon name="approvals" />
					<span>
						<small>Approvals</small>
						<strong>
							{pendingApprovals
								? `${pendingApprovals} pending`
								: "None pending"}
						</strong>
					</span>
					<Icon name="chevron" />
				</button>
				<button type="button" onClick={onOpenWork}>
					<Icon name="work" />
					<span>
						<small>Work</small>
						<strong>Goals and runs</strong>
					</span>
					<Icon name="chevron" />
				</button>
			</section>

			<section
				className="agent-task-library"
				aria-labelledby="agent-task-library-title"
			>
				<header>
					<div>
						<h2 id="agent-task-library-title">Tasks</h2>
					</div>
					<label className="agent-task-search">
						<Icon name="search" />
						<span className="sr-only">Find a task</span>
						<input
							type="search"
							value={query}
							placeholder="Search tasks…"
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className="agent-task-filters" aria-label="Filter tasks">
						{filters.map((item) => (
							<button
								type="button"
								key={item.id}
								aria-pressed={filter === item.id}
								onClick={() => setFilter(item.id)}
							>
								{item.label}
							</button>
						))}
					</div>
				</header>

				{visibleSessions.length ? (
					<ul className="agent-task-list">
						{visibleSessions.map(({ session, depth, parentTitle }) => {
							const active = session.id === activeSessionId;
							const workspaceName = agentWorkspaceName(session.workspaceRoot);
							const lineage = parentTitle
								? `Derived from ${sessionTitleForDisplay(parentTitle)} · ${workspaceName}`
								: workspaceName;
							return (
								<li key={session.id}>
									<button
										type="button"
										className={active ? "active" : ""}
										style={
											depth > 0
												? {
														paddingInlineStart: `calc(18px + ${depth * 24}px)`,
													}
												: undefined
										}
										aria-current={active ? "page" : undefined}
										aria-label={`${sessionTitleForDisplay(session.title)}, ${agentSessionStatusLabel(session.status)}, ${lineage}`}
										onClick={() => onOpenSession(session.id)}
									>
										<span
											className={`agent-task-state ${session.status}`}
											aria-hidden="true"
										/>
										<span className="agent-task-copy">
											<strong>{sessionTitleForDisplay(session.title)}</strong>
											<small>{lineage}</small>
										</span>
										<span className="agent-task-meta">
											<strong>{agentSessionStatusLabel(session.status)}</strong>
											<time dateTime={session.updatedAt}>
												{agentSessionRecency(session.updatedAt)}
											</time>
										</span>
										<Icon name="chevron" />
									</button>
								</li>
							);
						})}
					</ul>
				) : (
					<div className="agent-task-empty">
						<Icon name={query ? "search" : "agent"} />
						<h3>
							{query
								? "No matching tasks"
								: sessions.length
									? `No ${filter === "done" ? "completed" : filter} tasks`
									: "No tasks yet"}
						</h3>
						<p>
							{query
								? "Try a different search."
								: sessions.length
									? "Switch filters to see the rest."
									: "Tasks you start will appear here with their project and state."}
						</p>
						{query ? (
							<button
								type="button"
								className="quiet-link"
								onClick={() => setQuery("")}
							>
								Clear search
							</button>
						) : !sessions.length ? (
							<button
								type="button"
								className="button primary"
								onClick={onNewTask}
							>
								Start a task
							</button>
						) : null}
					</div>
				)}
			</section>
		</main>
	);
}
