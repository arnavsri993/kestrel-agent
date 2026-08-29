import { describe, expect, it } from "vitest";
import type {
	ActionReceipt,
	AgentRun,
	RuntimeToolExecution,
} from "@kestrel/shared-types";
import {
	actionReceiptApprovalLabel,
	actionReceiptOutcomeLabel,
	actionReceiptRollbackLabel,
	actionReceiptVerificationLabel,
	activityItemsFromExecutions,
	isConsumedApprovalCheckpoint,
	latestRunActionReceipts,
	pendingToolApprovals,
	policyGateCopy,
	runRouteLabel,
	runtimeOutcomeCopy,
	uncertainExecutionsForRun,
	verifiedApprovalEvidenceForRun,
} from "./runtime-evidence";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
	return {
		id: "run-1",
		sessionId: "session-1",
		model: "gpt-oss:20b-cloud",
		providerIds: ["auto", "ollama"],
		status: "waiting_approval",
		turn: 1,
		pendingToolExecutionId: "tool-1",
		createdAt: "2026-08-19T12:00:00.000Z",
		updatedAt: "2026-08-19T12:01:00.000Z",
		...overrides,
	};
}

function execution(
	overrides: Partial<RuntimeToolExecution> = {},
): RuntimeToolExecution {
	return {
		id: "tool-1",
		sessionId: "session-1",
		toolName: "workspace.apply_patch",
		status: "blocked",
		riskLevel: "sensitive",
		input: { path: "README.md" },
		output: { approvalRequired: true, preview: "Patch README.md" },
		error: "Approval level 3 is required before this action can execute.",
		idempotencyKey: "run-1:call-1",
		startedAt: "2026-08-19T12:01:00.000Z",
		completedAt: "2026-08-19T12:01:00.000Z",
		...overrides,
	};
}

function receipt(overrides: Partial<ActionReceipt> = {}): ActionReceipt {
	return {
		id: "action-receipt-1",
		sessionId: "session-1",
		runId: "run-1",
		toolExecutionId: "tool-1",
		toolName: "workspace.write",
		action: {
			title: "Write workspace file",
			category: "workspace",
			riskLevel: "low",
			summary: "Write one bounded workspace file.",
		},
		destination: {
			kind: "workspace",
			label: "Granted workspace · notes/today.md",
		},
		approval: { required: false, result: "not_required" },
		precondition: {
			status: "satisfied",
			summary: "Policy and scope were checked.",
		},
		expectedState: "The file should match the requested content.",
		observedState: "Filesystem read-back matched.",
		outcome: "verified",
		verification: {
			method: "filesystem-content-readback",
			evidenceSha256: "a".repeat(64),
			verifiedAt: "2026-08-19T12:02:00.000Z",
		},
		rollback: {
			status: "available",
			method: "workspace.undo",
			referenceId: "mutation-1",
			reason: "An encrypted mutation is available.",
		},
		startedAt: "2026-08-19T12:01:00.000Z",
		completedAt: "2026-08-19T12:02:00.000Z",
		trust: "local_encrypted_bounded",
		...overrides,
	};
}

describe("pending tool approvals", () => {
	it("pairs waiting runs with approval-required executions", () => {
		expect(
			pendingToolApprovals(
				[run(), run({ id: "run-2", status: "completed", pendingToolExecutionId: undefined })],
				[execution(), execution({ id: "tool-other" })],
			),
		).toEqual([{ run: run(), execution: execution() }]);
	});

	it("ignores blocked executions that are not waiting for approval", () => {
		expect(
			pendingToolApprovals(
				[run()],
				[
					execution({
						output: { approvalRequired: false, preview: "Denied" },
					}),
				],
			),
		).toEqual([]);
	});
});

describe("policy and route copy", () => {
	it("surfaces the deterministic policy reason and selected route", () => {
		expect(policyGateCopy(execution())).toEqual({
			level: 3,
			reason: "Approval level 3 is required before this action can execute.",
		});
		expect(runRouteLabel(run())).toBe("gpt-oss:20b-cloud · ollama");
	});

	it("uses persisted restart recovery copy instead of a transient IPC error", () => {
		const interrupted = run({
			status: "failed",
			recovery: {
				reason: "core_restarted",
				action: "retry_last_turn",
			},
			error: "Kestrel restarted. No work resumed automatically.",
		});
		expect(
			runtimeOutcomeCopy(
				interrupted,
				"Agent Core stopped before responding.",
			),
		).toEqual({
			title: "Task interrupted",
			detail: "Kestrel restarted. No work resumed automatically.",
		});
	});
});

describe("execution audit items", () => {
	it("turns verified tool executions into an inspectable audit trail", () => {
		const items = activityItemsFromExecutions([
			execution({
				id: "tool-verified",
				status: "verified",
				error: undefined,
				output: { path: "README.md" },
				verification: {
					method: "workspace-write-readback",
					evidenceSha256: "a".repeat(64),
					verifiedAt: "2026-08-19T12:02:00.000Z",
				},
				completedAt: "2026-08-19T12:02:00.000Z",
			}),
			execution(),
		]);
		expect(items[0]).toMatchObject({
			id: "tool-1",
			title: "workspace.apply_patch",
			status: "waiting",
		});
		expect(items[1]).toMatchObject({
			id: "tool-verified",
			status: "verified",
			detail: `workspace-write-readback · ${"a".repeat(12)}`,
		});
		expect(items[1]?.sourceIds).toContain("a".repeat(64));
	});

	it("labels cancelled tool executions distinctly from generic failures", () => {
		const items = activityItemsFromExecutions([
			execution({
				id: "tool-cancelled",
				status: "cancelled",
				error: "Cancelled by the user.",
				completedAt: "2026-08-19T12:02:00.000Z",
			}),
		]);
		expect(items[0]).toMatchObject({
			id: "tool-cancelled",
			status: "cancelled",
			detail: "Cancelled by the user.",
		});
	});

	it("surfaces uncertain outcomes only for the matching run", () => {
		const uncertain = execution({
			status: "failed",
			outcomeUncertain: true,
			error: "The action may already have completed.",
		});
		const otherRun = execution({
			id: "tool-other-run",
			status: "failed",
			outcomeUncertain: true,
			idempotencyKey: "run-other:call-1",
		});
		expect(uncertainExecutionsForRun(run(), [uncertain, otherRun])).toEqual([
			uncertain,
		]);
		expect(activityItemsFromExecutions([uncertain])[0]?.detail).toContain(
			"Outcome uncertain",
		);
	});
});

describe("verified approval evidence handoff", () => {
	it("prefers the latest verified receipt that required approval", () => {
		const evidence = verifiedApprovalEvidenceForRun(
			run({ status: "running", pendingToolExecutionId: undefined }),
			[],
			[
				receipt({
					id: "receipt-earlier",
					toolExecutionId: "tool-earlier",
					startedAt: "2026-08-19T12:01:00.000Z",
					approval: { required: true, result: "approved_once" },
				}),
				receipt({
					id: "receipt-later",
					toolExecutionId: "tool-later",
					toolName: "workspace.write",
					startedAt: "2026-08-19T12:03:00.000Z",
					approval: { required: true, result: "allowed_by_rule" },
				}),
			],
		);
		expect(evidence).toEqual({
			executionId: "tool-later",
			toolName: "workspace.write",
		});
	});

	it("falls back to verified executions when receipts are unavailable", () => {
		const evidence = verifiedApprovalEvidenceForRun(
			run({ status: "completed", pendingToolExecutionId: undefined }),
			[
				execution({
					id: "tool-verified",
					status: "verified",
					verification: {
						method: "workspace-write-readback",
						evidenceSha256: "b".repeat(64),
						verifiedAt: "2026-08-19T12:02:00.000Z",
					},
				}),
			],
			[],
		);
		expect(evidence).toEqual({
			executionId: "tool-verified",
			toolName: "workspace.apply_patch",
		});
	});
});

describe("action receipt presentation", () => {
	it("selects only the latest run and hides consumed approval checkpoints", () => {
		const consumed = receipt({
			id: "action-receipt-consumed",
			toolExecutionId: "tool-consumed",
			approval: { required: true, result: "approved_once" },
			outcome: "cancelled",
			verification: undefined,
			observedState: "The approved one-time grant was consumed.",
		});
		expect(isConsumedApprovalCheckpoint(consumed)).toBe(true);
		expect(
			latestRunActionReceipts(
				[
					receipt({
						id: "action-receipt-later",
						toolExecutionId: "tool-later",
						startedAt: "2026-08-19T12:03:00.000Z",
					}),
					consumed,
					receipt({
						id: "action-receipt-other-run",
						toolExecutionId: "tool-other-run",
						runId: "run-2",
					}),
					receipt(),
				],
				run(),
			).map((item) => item.id),
		).toEqual(["action-receipt-1", "action-receipt-later"]);
	});

	it("uses truthful approval, outcome, verification, and rollback labels", () => {
		const verified = receipt();
		expect(actionReceiptApprovalLabel(verified.approval)).toBe("Not required");
		expect(actionReceiptOutcomeLabel(verified.outcome)).toBe("Verified");
		expect(actionReceiptVerificationLabel(verified)).toBe(
			`Verified via filesystem-content-readback · ${"a".repeat(12)}`,
		);
		expect(actionReceiptRollbackLabel(verified.rollback)).toBe(
			"Available via workspace.undo",
		);

		const uncertain = receipt({
			outcome: "uncertain",
			verification: undefined,
			approval: { required: true, result: "unknown" },
			rollback: {
				status: "unavailable",
				reason: "The result must be inspected before any compensating action.",
			},
		});
		expect(actionReceiptOutcomeLabel(uncertain.outcome)).toBe(
			"Outcome uncertain",
		);
		expect(actionReceiptApprovalLabel(uncertain.approval)).toBe(
			"Required; provenance unavailable",
		);
		expect(
			actionReceiptApprovalLabel(
				{ required: true, result: "pending" },
				"cancelled",
			),
		).toBe("Not granted; task cancelled");
		expect(actionReceiptVerificationLabel(uncertain)).toBe(
			"No independent verification recorded",
		);
		expect(actionReceiptRollbackLabel(uncertain.rollback)).toBe("Unavailable");
	});
});
