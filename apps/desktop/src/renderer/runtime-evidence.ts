import type {
	ActionReceipt,
	ActivityItem,
	AgentRun,
	RuntimeToolExecution,
} from "@kestrel/shared-types";

const approvalLevelForRisk = {
	read_only: 0,
	low: 1,
	external: 2,
	sensitive: 3,
	high_consequence: 4,
} as const;

export type PendingToolApproval = {
	run: AgentRun;
	execution: RuntimeToolExecution;
};

export function pendingToolApprovals(
	runs: AgentRun[],
	executions: RuntimeToolExecution[],
): PendingToolApproval[] {
	const byId = new Map(executions.map((execution) => [execution.id, execution]));
	return runs.flatMap((run) => {
		if (run.status !== "waiting_approval" || !run.pendingToolExecutionId)
			return [];
		const execution = byId.get(run.pendingToolExecutionId);
		if (!execution || execution.output?.approvalRequired !== true) return [];
		return [{ run, execution }];
	});
}

export function policyGateCopy(execution: RuntimeToolExecution): {
	level: number;
	reason: string;
} {
	const level = approvalLevelForRisk[execution.riskLevel];
	return {
		level,
		reason:
			execution.error?.trim() ||
			`Approval level ${level} is required before this action can execute.`,
	};
}

export function runRouteLabel(run: AgentRun): string {
	const providers = run.providerIds.filter((id) => id !== "auto");
	return providers.length > 0
		? `${run.model} · ${providers.join(", ")}`
		: run.model;
}

export function isConsumedApprovalCheckpoint(
	receipt: ActionReceipt,
): boolean {
	return (
		receipt.outcome === "cancelled" &&
		receipt.approval.result === "approved_once" &&
		/approved one-time grant was consumed/i.test(receipt.observedState)
	);
}

export function latestRunActionReceipts(
	receipts: ActionReceipt[],
	latestRun: AgentRun | null,
): ActionReceipt[] {
	if (!latestRun) return [];
	return receipts
		.filter(
			(receipt) =>
				receipt.runId === latestRun.id &&
				!isConsumedApprovalCheckpoint(receipt),
		)
		.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function actionReceiptOutcomeLabel(
	outcome: ActionReceipt["outcome"],
): string {
	return {
		in_progress: "In progress",
		waiting_approval: "Waiting for approval",
		blocked: "Blocked",
		verified: "Verified",
		failed: "Failed",
		cancelled: "Cancelled",
		uncertain: "Outcome uncertain",
	}[outcome];
}

export function actionReceiptApprovalLabel(
	approval: ActionReceipt["approval"],
	outcome?: ActionReceipt["outcome"],
): string {
	if (approval.result === "pending" && outcome === "cancelled")
		return "Not granted; task cancelled";
	return {
		not_required: "Not required",
		approved_once: "Approved once",
		allowed_by_rule: "Allowed by saved rule",
		pending: "Waiting for approval",
		denied: "Denied",
		unknown: approval.required
			? "Required; provenance unavailable"
			: "Not recorded",
	}[approval.result];
}

export function actionReceiptVerificationLabel(
	receipt: ActionReceipt,
): string {
	if (!receipt.verification) return "No independent verification recorded";
	return `Verified via ${receipt.verification.method} · ${receipt.verification.evidenceSha256.slice(0, 12)}`;
}

export function actionReceiptRollbackLabel(
	rollback: ActionReceipt["rollback"],
): string {
	if (rollback.status === "available")
		return rollback.method ? `Available via ${rollback.method}` : "Available";
	return rollback.status === "unavailable" ? "Unavailable" : "Not applicable";
}

export function runtimeOutcomeCopy(
	run: AgentRun,
	transientError = "",
): { title: string; detail: string } {
	if (run.status === "completed")
		return {
			title: "Task complete",
			detail:
				"Kestrel finished this run. Continue with another message when you are ready.",
		};
	if (run.status === "cancelled")
		return {
			title: "Task cancelled",
			detail:
				"The run was cancelled before it completed. You can continue this chat or start a new task.",
		};
	if (run.recovery?.reason === "core_restarted")
		return {
			title: "Task interrupted",
			detail:
				run.error?.trim() ||
				"Kestrel restarted before it could confirm the active work. Review the task, then choose whether to retry the last turn.",
		};
	return {
		title: "Task needs recovery",
		detail:
			transientError.trim() ||
			run.error?.trim() ||
			"The last run did not complete. Review the task context, then retry when ready.",
	};
}

export function uncertainExecutionsForRun(
	run: AgentRun,
	executions: RuntimeToolExecution[],
): RuntimeToolExecution[] {
	const keyPrefix = `${run.id}:`;
	return executions.filter(
		(execution) =>
			execution.outcomeUncertain === true &&
			execution.idempotencyKey?.startsWith(keyPrefix) === true,
	);
}


export function activityItemsFromExecutions(
	executions: RuntimeToolExecution[],
): ActivityItem[] {
	return [...executions]
		.reverse()
		.map((execution) => {
			const verified = execution.verification;
			const status =
				execution.status === "verified"
					? "verified"
					: execution.status === "blocked"
						? execution.output?.approvalRequired === true
							? "waiting"
							: "blocked"
						: execution.status === "failed"
							? "failed"
							: execution.status === "cancelled"
								? "cancelled"
								: execution.status === "running"
									? "reasoned"
									: "observed";
			const detail = verified
				? `${verified.method} · ${verified.evidenceSha256.slice(0, 12)}`
				: execution.outcomeUncertain
					? `Outcome uncertain · ${execution.error?.trim() || "Kestrel could not confirm whether this action completed."}`
					: execution.status === "cancelled"
						? execution.error?.trim() ||
							"Cancelled before this step completed."
						: execution.error?.trim() ||
							(typeof execution.output?.preview === "string"
								? execution.output.preview
								: `${execution.status} tool execution`);
			return {
				id: execution.id,
				title: execution.toolName,
				detail,
				timestamp: execution.completedAt ?? execution.startedAt,
				status,
				sourceIds: [
					execution.sessionId,
					...(execution.idempotencyKey ? [execution.idempotencyKey] : []),
					...(verified ? [verified.evidenceSha256] : []),
				],
			};
		});
}
