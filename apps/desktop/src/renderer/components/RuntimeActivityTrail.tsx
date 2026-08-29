import type {
	ActivityItem,
	CoreResponse,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "./ui";
import { activityItemsFromExecutions } from "../runtime-evidence";

export function RuntimeActivityTrail({
	snapshot,
	highlightExecutionId,
}: {
	snapshot: WorkspaceSnapshot;
	highlightExecutionId?: string | null;
}) {
	const [executions, setExecutions] = useState<ActivityItem[]>([]);
	const [error, setError] = useState("");
	const items = useMemo(() => {
		const fixtureIds = new Set(snapshot.activity.map((item) => item.id));
		return [
			...executions.filter((item) => !fixtureIds.has(item.id)),
			...snapshot.activity,
		];
	}, [executions, snapshot.activity]);

	useEffect(() => {
		let cancelled = false;
		void window.kestrel
			.request({ type: "runtime-list-executions", limit: 80 })
			.then((raw) => {
				if (cancelled) return;
				const response = raw as CoreResponse;
				if (!response.ok) throw new Error(response.error);
				setExecutions(activityItemsFromExecutions(response.executions ?? []));
			})
			.catch((cause) => {
				if (!cancelled)
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load the tool audit trail.",
					);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!highlightExecutionId) return;
		const node = document.getElementById(
			`activity-item-${highlightExecutionId}`,
		);
		if (!node) return;
		node.scrollIntoView({ block: "nearest" });
		node.classList.add("activity-item-focused");
		return () => node.classList.remove("activity-item-focused");
	}, [highlightExecutionId, items]);

	return (
		<div className="page-frame">
			<header className="page-header">
				<h1>What happened</h1>
				<p>
					Verified tool results and the local audit trail. Hashes are evidence,
					not a claim that the task worked.
				</p>
			</header>
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
			{items.length === 0 ? (
				<EmptyState
					title="No verified work yet"
					detail="After a tool runs, this trail shows the status, verification method, and evidence hash stored in encrypted SQLite."
				/>
			) : (
				<ol className="activity-list">
					{items.map((item, index) => (
						<li key={item.id} id={`activity-item-${item.id}`}>
							<span className={`activity-node node-${item.status}`}>
								{String(index + 1).padStart(2, "0")}
							</span>
							<div>
								<div className="activity-title">
									<strong>{item.title}</strong>
									<time>
										{new Date(item.timestamp).toLocaleTimeString([], {
											hour: "numeric",
											minute: "2-digit",
										})}
									</time>
								</div>
								<p>{item.detail}</p>
								<small>
									{item.status} · {item.sourceIds.join(" · ")}
								</small>
							</div>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
