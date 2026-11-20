import { describe, expect, it } from "vitest";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { emptyBrowserRecoveryBudgetState } from "./browser-recovery";
import {
	OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR,
	OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR,
	computerCompletionError,
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
		input: {},
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

describe("computerCompletionError", () => {
	const action = execution({ id: "input", toolName: "computer.act", idempotencyKey: "run-1:input",
		input: { action: { type: "click", captureId: "before" } } });
	const observation = execution({ id: "after", toolName: "computer.screenshot", idempotencyKey: "run-1:after",
		output: { captureId: "after", capturedAt: "2026-07-22T18:00:02.000Z" } });
	const check = (items: RuntimeToolExecution[], observedExecutionId?: string) => computerCompletionError({
		runId: "run-1", sessionId: "session-1", listExecutions: () => items, observedExecutionId,
	});
	it("rejects a completion after delivered input until the model receives a fresh observation", () => {
		expect(check([action])).toBe(OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR);
		expect(check([action, observation])).toBe(OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR);
		expect(check([action, observation], "after")).toBeUndefined();
	});
	it("rejects old, reused, foreign, or pre-action frames", () => {
		for (const changed of [
			{ ...observation, idempotencyKey: "other-run:after" },
			{ ...observation, sessionId: "other-session" },
			{ ...observation, status: "failed" as const },
			{ ...observation, output: { captureId: "before", capturedAt: "2026-07-22T18:00:02.000Z" } },
			{ ...observation, output: { captureId: "after", capturedAt: "2026-07-22T17:59:59.000Z" } },
		]) expect(check([action, changed], "after")).toBe(OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR);
	});
	it("checks the final action and leaves read-only and denied-input runs alone", () => {
		const later = { ...action, id: "later", completedAt: "2026-07-22T18:00:03.000Z" };
		expect(check([action, observation, later], "after")).toBe(OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR);
		expect(check([observation], "after")).toBeUndefined();
		expect(check([{ ...action, status: "blocked" }])).toBeUndefined();
	});
});
