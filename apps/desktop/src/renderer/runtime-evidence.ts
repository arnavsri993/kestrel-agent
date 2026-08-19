import type {
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
							: execution.status === "running"
								? "reasoned"
								: "observed";
			const detail = verified
				? `${verified.method} · ${verified.evidenceSha256.slice(0, 12)}`
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
