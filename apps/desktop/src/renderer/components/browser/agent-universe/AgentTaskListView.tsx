import type { RuntimeSession } from "@kestrel/shared-types";
import { useMemo, type CSSProperties } from "react";
import {
	agentSessionRecency,
	agentSessionIsRenderable,
	agentSessionStatusLabel,
	agentSessionTreeForWorkspace,
	agentWorkspaceName,
	type AgentSessionFilter,
} from "../../../agent-workspace";
import { sessionTitleForDisplay } from "../../../chat-title";
import { Button, EmptyState } from "../../ui";
import { Icon } from "../../Icon";

const filters: Array<{ id: AgentSessionFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "open", label: "Open" },
	{ id: "done", label: "Completed" },
];

export function AgentTaskListView({
	sessions,
	query,
	filter,
	activeSessionId,
	onFilterChange,
	onNewTask,
	onOpenSession,
}: {
	sessions: RuntimeSession[];
	query: string;
	filter: AgentSessionFilter;
	activeSessionId: string | null;
	onFilterChange(filter: AgentSessionFilter): void;
	onNewTask(): void;
	onOpenSession(sessionId: string): void;
}) {
	const visibleSessions = useMemo(
		() => agentSessionTreeForWorkspace(sessions, query, filter),
		[filter, query, sessions],
	);
	const hasRenderableSessions = useMemo(
		() => sessions.some(agentSessionIsRenderable),
		[sessions],
	);

	return (
		<section className="agent-universe-list" aria-labelledby="agent-list-title">
			<header className="agent-universe-list-header">
				<div>
					<p className="agent-universe-list-eyebrow">Exact runtime history</p>
					<h2 id="agent-list-title">Task library</h2>
				</div>
				<div className="agent-universe-list-filters" aria-label="Filter tasks">
					{filters.map((item) => (
						<button
							type="button"
							key={item.id}
							aria-pressed={filter === item.id}
							onClick={() => onFilterChange(item.id)}
						>
							{item.label}
						</button>
					))}
				</div>
			</header>

			{visibleSessions.length ? (
				<ul className="agent-universe-task-list">
					{visibleSessions.map(({ session, depth, parentTitle }) => {
						const active = session.id === activeSessionId;
						const workspaceName = agentWorkspaceName(session.workspaceRoot);
						const lineage = parentTitle
							? `From ${sessionTitleForDisplay(parentTitle)}${workspaceName ? ` · ${workspaceName}` : ""}`
							: workspaceName;
						return (
							<li key={session.id}>
								<button
									type="button"
									className={`agent-universe-task-row${active ? " is-active" : ""}`}
									style={{ "--task-depth": depth } as CSSProperties}
									aria-current={active ? "page" : undefined}
									aria-label={`${sessionTitleForDisplay(session.title)}, ${agentSessionStatusLabel(session.status)}${lineage ? `, ${lineage}` : ""}`}
									onClick={() => onOpenSession(session.id)}
								>
									<span className={`agent-task-state ${session.status}`} aria-hidden="true" />
									<span className="agent-universe-task-copy">
										<strong>{sessionTitleForDisplay(session.title)}</strong>
										{lineage ? <small>{lineage}</small> : null}
									</span>
									<span className="agent-universe-task-meta">
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
				<EmptyState
					className="agent-universe-list-empty"
						title={
							query
								? "No matching tasks"
								: filter === "done"
									? "No completed tasks"
									: filter === "open"
										? "No open tasks"
										: "No tasks yet"
					}
					detail={
						query
							? "Try a different search."
							: hasRenderableSessions
								? "Switch filters to see the rest."
								: "Tasks you start will appear here with their project and state."
					}
					action={
						!hasRenderableSessions && !query ? (
							<Button variant="solid" onClick={onNewTask}>
								Start a task
							</Button>
						) : undefined
					}
				/>
			)}
		</section>
	);
}
