import type { ReactNode } from "react";
import {
	agentSessionRecency,
	agentSessionStatusLabel,
} from "../../../agent-workspace";
import { Icon } from "../../Icon";
import type {
	AgentNodeProjection,
	AgentSystemProjection,
	AgentUniverseSnapshot,
} from "./agent-universe-model";
import {
	agentUniverseRunIsPending,
	agentUniverseRunStatusLabel,
} from "./agent-universe-model";

export interface AgentWorkspaceListItem {
	system: AgentSystemProjection;
	nodes: AgentNodeProjection[];
}

function searchableNodeText(node: AgentNodeProjection): string {
	return [
		node.name,
		node.workspaceName ?? "",
		agentSessionStatusLabel(node.status),
		node.latestRun?.workingTaskId ?? "",
		node.latestRun ? agentUniverseRunStatusLabel(node.latestRun.status) : "",
	]
		.join(" ")
		.toLocaleLowerCase();
}

export function agentWorkspaceListItems(
	snapshot: AgentUniverseSnapshot,
	query: string,
): AgentWorkspaceListItem[] {
	const needle = query.trim().toLocaleLowerCase();
	return snapshot.systems.flatMap((system) => {
		const systemMatches = [system.name, system.workspaceName ?? ""]
			.join(" ")
			.toLocaleLowerCase()
			.includes(needle);
		const nodes = needle
			? system.nodes.filter((node) => searchableNodeText(node).includes(needle))
			: system.nodes;
		if (needle && !systemMatches && nodes.length === 0) return [];
		return [{ system, nodes: systemMatches ? system.nodes : nodes }];
	});
}

function statusForNode(node: AgentNodeProjection): {
	label: string;
	tone: string;
} {
	if (node.latestRun && agentUniverseRunIsPending(node.latestRun.status)) {
		return {
			label: agentUniverseRunStatusLabel(node.latestRun.status),
			tone: node.latestRun.status,
		};
	}
	return {
		label: agentSessionStatusLabel(node.status),
		tone: node.status,
	};
}

function AgentTaskRow({
	node,
	onOpenSession,
}: {
	node: AgentNodeProjection;
	onOpenSession(sessionId: string): void;
}) {
	const status = statusForNode(node);
	return (
		<li className="agent-workspace-list-task">
			<button type="button" onClick={() => onOpenSession(node.id)}>
				<span
					className={`agent-workspace-list-status-dot is-${status.tone}`}
					aria-hidden="true"
				/>
				<span className="agent-workspace-list-task-copy">
					<strong>{node.name}</strong>
					<small>
						{status.label} · Updated {agentSessionRecency(node.updatedAt)}
					</small>
				</span>
				<Icon name="chevron" />
			</button>
		</li>
	);
}

export function AgentWorkspaceList({
	snapshot,
	query,
	emptyState,
	loadingState,
	errorState,
	onOpenSession,
	onOpenSettings,
	onClearSearch,
}: {
	snapshot: AgentUniverseSnapshot;
	query: string;
	emptyState: ReactNode;
	loadingState?: ReactNode;
	errorState?: ReactNode;
	onOpenSession(sessionId: string): void;
	onOpenSettings(sessionId: string): void;
	onClearSearch(): void;
}) {
	if (loadingState) return <div className="agent-workspace-list-state">{loadingState}</div>;
	if (errorState) return <div className="agent-workspace-list-state">{errorState}</div>;
	if (snapshot.systems.length === 0)
		return <div className="agent-workspace-list-state">{emptyState}</div>;

	const items = agentWorkspaceListItems(snapshot, query);
	if (items.length === 0) {
		return (
			<section className="agent-workspace-list-state" aria-labelledby="agent-search-empty-title">
				<div className="agent-workspace-search-empty">
					<Icon name="search" />
					<h2 id="agent-search-empty-title">No matching agents or tasks</h2>
					<p>Try a different name, workspace, or status.</p>
					<button type="button" onClick={onClearSearch}>Clear search</button>
				</div>
			</section>
		);
	}

	return (
		<section className="agent-workspace-list" aria-label="Agents and delegated tasks">
			<div className="agent-workspace-list-heading">
				<div>
					<h2>{query.trim() ? "Search results" : "Your agents"}</h2>
					<p>
						{query.trim()
							? `${items.length} matching agent${items.length === 1 ? "" : "s"}`
							: "Open an agent to continue its conversation or review delegated work."}
					</p>
				</div>
				<span>{snapshot.sessionCount} total session{snapshot.sessionCount === 1 ? "" : "s"}</span>
			</div>
			<div className="agent-workspace-list-groups">
				{items.map(({ system, nodes }) => {
					const root = system.nodes.find((node) => node.id === system.rootNodeId);
					if (!root) return null;
					const delegated = nodes.filter((node) => node.id !== root.id);
					const status = statusForNode(root);
					const delegatedCount = system.nodes.length - 1;
					return (
						<article className="agent-workspace-list-group" key={system.id}>
							<div className="agent-workspace-list-agent">
								<button
									type="button"
									className="agent-workspace-list-agent-open"
									onClick={() => onOpenSession(root.id)}
								>
									<span className="agent-workspace-list-agent-mark" aria-hidden="true">
										<Icon name="agent" />
										<span className={`agent-workspace-list-status-dot is-${status.tone}`} />
									</span>
									<span className="agent-workspace-list-agent-copy">
										<span className="agent-workspace-list-agent-title">
											<strong>{system.name}</strong>
											<span>{status.label}</span>
										</span>
										<small>
											{system.workspaceName ? `${system.workspaceName} · ` : ""}
											{delegatedCount > 0
												? `${delegatedCount} delegated task${delegatedCount === 1 ? "" : "s"} · `
												: "No delegated tasks · "}
											Updated {agentSessionRecency(system.lastActivityAt)}
										</small>
									</span>
									<span className="agent-workspace-list-open-label">
										Open <Icon name="arrow" />
									</span>
								</button>
								<button
									type="button"
									className="agent-workspace-list-settings"
									aria-label={`Open settings for ${system.name}`}
									onClick={() => onOpenSettings(root.id)}
								>
									<Icon name="settings" />
								</button>
							</div>
							{delegated.length > 0 ? (
								<ul className="agent-workspace-list-tasks" aria-label={`Delegated tasks for ${system.name}`}>
									{delegated.map((node) => (
										<AgentTaskRow key={node.id} node={node} onOpenSession={onOpenSession} />
									))}
								</ul>
							) : null}
						</article>
					);
				})}
			</div>
		</section>
	);
}
