import { useMemo } from "react";
import { Icon } from "../../Icon";
import type { AgentUniverseSnapshot } from "./agent-universe-model";
import {
	buildAgentWorkOverview,
	type AgentWorkOverviewChild,
} from "./agent-work-overview-model";
import "./agent-work-overview.css";

export interface AgentWorkOverviewProps {
	snapshot: AgentUniverseSnapshot;
	query: string;
	runsLoading?: boolean;
	runsError?: string;
	onOpenSession(id: string): void;
	onOpenSettings(id: string): void;
	onRetry?(): void;
}

function AgentWorkMetadata({
	statusLabel,
	workspaceName,
	recency,
	updatedAt,
	statusStale,
}: Pick<
	AgentWorkOverviewChild,
	"statusLabel" | "workspaceName" | "recency" | "updatedAt" | "statusStale"
>) {
	return (
		<span className="agent-work-overview-metadata">
			<span className="agent-work-overview-status" data-stale={statusStale || undefined}>
				{statusLabel}
			</span>
			<span aria-hidden="true">·</span>
			<span>{workspaceName}</span>
			<span aria-hidden="true">·</span>
			<time dateTime={updatedAt}>{recency}</time>
		</span>
	);
}

export function AgentWorkOverview({
	snapshot,
	query,
	runsLoading = false,
	runsError = "",
	onOpenSession,
	onOpenSettings,
	onRetry,
}: AgentWorkOverviewProps) {
	const groups = useMemo(
		() => buildAgentWorkOverview(snapshot, query, { runsLoading, runsError }),
		[snapshot, query, runsLoading, runsError],
	);
	const visibleItemCount = groups.reduce(
		(count, group) => count + group.items.length,
		0,
	);

	return (
		<div className="agent-work-overview" aria-label="Agent work overview">
			{runsError ? (
				<div className="agent-work-overview-notice" role="status">
					<span>
						Run status is unavailable. Cached statuses are marked as last known.
					</span>
					{onRetry ? (
						<button type="button" onClick={onRetry}>
							Retry
						</button>
					) : null}
				</div>
			) : runsLoading ? (
				<p className="agent-work-overview-notice" role="status">
					Refreshing run status. Cached statuses are marked as last known.
				</p>
			) : null}

			{visibleItemCount === 0 ? (
				<p className="agent-work-overview-empty" role="status">
					{query.trim() ? "No agents match this search." : "No agents yet."}
				</p>
			) : (
				groups.map((group) =>
					group.items.length > 0 ? (
						<section
							className="agent-work-overview-group"
							key={group.id}
							aria-labelledby={`agent-work-group-${group.id}`}
						>
							<h2 id={`agent-work-group-${group.id}`}>{group.label}</h2>
							<ul className="agent-work-overview-list">
								{group.items.map((item) => (
									<li className="agent-work-overview-item" key={item.id}>
										<div className="agent-work-overview-row">
											<button
												type="button"
												className="agent-work-overview-open"
												aria-label={`Open ${item.name}`}
												data-agent-session-id={item.id}
												onClick={() => onOpenSession(item.id)}
											>
												<span className="agent-work-overview-name">{item.name}</span>
												<AgentWorkMetadata {...item} />
											</button>
											<button
												type="button"
												className="agent-work-overview-settings"
												aria-label={`Open ${item.name} settings`}
												title={`${item.name} settings`}
												onClick={() => onOpenSettings(item.id)}
											>
												<Icon name="settings" />
											</button>
										</div>

										{item.delegatedCount > 0 ? (
											<details
												className="agent-work-overview-delegated"
												open={item.revealChildren || undefined}
											>
												<summary>
													{item.delegatedCount} delegated task
													{item.delegatedCount === 1 ? "" : "s"}
												</summary>
												<ul>
													{item.children.map((child) => (
														<li key={child.id}>
															<button
																type="button"
																aria-label={`Open delegated work ${child.name}`}
														data-agent-session-id={child.id}
																onClick={() => onOpenSession(child.id)}
															>
																<span className="agent-work-overview-name">{child.name}</span>
																<AgentWorkMetadata {...child} />
															</button>
														</li>
													))}
												</ul>
											</details>
										) : null}
									</li>
								))}
							</ul>
						</section>
					) : null,
				)
			)}
		</div>
	);
}
