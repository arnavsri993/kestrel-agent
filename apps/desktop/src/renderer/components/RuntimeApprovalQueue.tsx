import type { CoreResponse, WorkspaceSnapshot } from "@kestrel/shared-types";
import { useEffect, useState } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { Icon } from "./Icon";
import { EmptyState, Status } from "./ui";
import {
	pendingToolApprovals,
	policyGateCopy,
	runRouteLabel,
	type PendingToolApproval,
} from "../runtime-evidence";

export function RuntimeApprovalQueue({
	snapshot,
	update,
	onOpenSession,
}: {
	snapshot: WorkspaceSnapshot;
	update(next: WorkspaceSnapshot): void;
	onOpenSession(sessionId: string): void;
}) {
	const [pending, setPending] = useState<PendingToolApproval[]>([]);
	const [error, setError] = useState("");
	const queued = snapshot.approvals.filter(
		(approval) => approval.status === "pending",
	);
	const approval = queued[0] ?? snapshot.approvals[0];

	async function refresh() {
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-list-pending-tool-approvals",
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setPending(
				pendingToolApprovals(
					response.runs ?? [],
					response.executions ?? [],
				),
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not load waiting tool approvals.",
			);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function request(input: Parameters<typeof window.kestrel.request>[0]) {
		const response = (await window.kestrel.request(input)) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		if (response.snapshot) update(response.snapshot);
	}

	if (pending.length === 0 && !approval)
		return (
			<EmptyState
				title="No approvals waiting"
				detail="When a consequential tool needs a decision, Kestrel pauses the run in encrypted local state. That pause survives restart until you allow or reject it."
			/>
		);

	return (
		<div className="page-frame">
			<header className="page-header">
				<h1>Review this action</h1>
				<p>
					A deterministic policy layer decides whether a tool can run
					automatically. Consequential actions wait here, restart-safe, until
					you decide.
				</p>
			</header>
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
			{pending.map((item) => (
				<RuntimeApprovalCard
					key={item.execution.id}
					item={item}
					onOpen={() => onOpenSession(item.run.sessionId)}
				/>
			))}
			{approval && (
				<ApprovalCard
					approval={approval}
					onApprove={() =>
						request({ type: "approve", approvalId: approval.id })
					}
					onReject={() => request({ type: "reject", approvalId: approval.id })}
					onEdit={(emailBody) =>
						request({
							type: "edit-approval",
							approvalId: approval.id,
							emailBody,
						})
					}
				/>
			)}
		</div>
	);
}

function RuntimeApprovalCard({
	item,
	onOpen,
}: {
	item: PendingToolApproval;
	onOpen(): void;
}) {
	const policy = policyGateCopy(item.execution);
	return (
		<article className="runtime-approval-card">
			<header>
				<div>
					<span className="eyebrow">
						Policy level {policy.level} · {item.execution.riskLevel.replaceAll("_", " ")} ·
						restart-safe
					</span>
					<h2>{item.execution.toolName}</h2>
				</div>
				<Status tone="needs-approval">Waiting</Status>
			</header>
			<p>{policy.reason}</p>
			<small>
				Route {runRouteLabel(item.run)}
				{item.execution.idempotencyKey
					? ` · idempotency ${item.execution.idempotencyKey}`
					: ""}
			</small>
			{typeof item.execution.output?.preview === "string" && (
				<pre className="approval-preview">{item.execution.output.preview}</pre>
			)}
			<div className="button-row">
				<button className="button primary" type="button" onClick={onOpen}>
					Review in task
					<Icon name="arrow" />
				</button>
			</div>
		</article>
	);
}
