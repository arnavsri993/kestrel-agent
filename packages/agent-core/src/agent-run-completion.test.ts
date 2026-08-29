import { describe, expect, it } from "vitest";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { emptyBrowserRecoveryBudgetState } from "./browser-recovery";
import {
	OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR,
	PREMATURE_BROWSER_COMPLETION_ERROR,
	prematureBrowserCompletionError,
} from "./agent-run-completion";

function execution(
	overrides: Partial<RuntimeToolExecution> & Pick<RuntimeToolExecution, "id">,
): RuntimeToolExecution {
	return {
		sessionId: "session-1",
		toolName: "browser.act",
		riskLevel: "external",
		status: "verified",
		startedAt: "2026-07-22T18:00:00.000Z",
		completedAt: "2026-07-22T18:00:01.000Z",
		...overrides,
	};
}

describe("prematureBrowserCompletionError", () => {
	it("allows normal Q&A completion with assistant text", () => {
		expect(
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "Here is the answer.",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => [],
			}),
		).toBeUndefined();
	});

	it("allows empty completion when no browser work ran in this run", () => {
		expect(
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => [
					execution({
						id: "other-run",
						idempotencyKey: "run-2:call-1",
						toolName: "browser.act",
					}),
				],
			}),
		).toBeUndefined();
	});

	it("flags empty completion after browser work in the same run", () => {
		expect(
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "   ",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => [
					execution({
						id: "browser-step",
						idempotencyKey: "run-1:call-1",
						toolName: "browser.visible-act",
					}),
				],
			}),
		).toBe(PREMATURE_BROWSER_COMPLETION_ERROR);
	});

	it("requires a fresh observation when recovery budget is observe_required", () => {
		expect(
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "",
				browserRecoveryState: {
					version: 1,
					nextSequence: 2,
					entries: [
						{
							signature: "visible:act:stale_target",
							reasonCode: "stale_target",
							operation: "act",
							surface: "visible",
							failureCount: 1,
							maximumFailures: 2,
							phase: "observe_required",
							allowedToolNames: ["browser.visible-snapshot"],
							sequence: 1,
						},
					],
				},
				listExecutions: () => [
					execution({
						id: "browser-step",
						idempotencyKey: "run-1:call-1",
						toolName: "browser.visible-act",
					}),
				],
			}),
		).toBe(OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR);
	});
});
