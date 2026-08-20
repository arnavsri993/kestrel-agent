import { describe, expect, it } from "vitest";
import type { AgentRun, RuntimeToolExecution } from "@kestrel/shared-types";
import {
	activityItemsFromExecutions,
	pendingToolApprovals,
	policyGateCopy,
	runRouteLabel,
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
});
