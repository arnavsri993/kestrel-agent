import { describe, expect, it } from "vitest";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { emptyBrowserRecoveryBudgetState } from "./browser-recovery";
import {
	OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR,
	OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR,
	FAILED_COMPUTER_COMPLETION_ERROR,
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
	it("does not mark a failed computer capture complete just because the model explains the failure", () => {
		const failed = execution({ id: "capture", toolName: "computer.screenshot", status: "failed", idempotencyKey: "run-1:capture" });
		const check = (steps: RuntimeToolExecution[]) => prematureBrowserCompletionError({
			runId: "run-1", sessionId: "session-1", modelText: "The screenshot failed; no input was sent.",
			browserRecoveryState: emptyBrowserRecoveryBudgetState(), listExecutions: () => steps,
		});
		expect(check([failed])).toBe(FAILED_COMPUTER_COMPLETION_ERROR);
		expect(check([failed, { ...failed, id: "retry", status: "verified" }])).toBeUndefined();
	});
	it("requires a verified observation after a computer action even if the model says done", () => {
		const action = execution({ id: "act", toolName: "computer.act", idempotencyKey: "run-1:act" });
		const observation = execution({ id: "observe", toolName: "computer.screenshot", idempotencyKey: "run-1:observe" });
		const check = (steps: RuntimeToolExecution[]) => prematureBrowserCompletionError({
			runId: "run-1", sessionId: "session-1", modelText: "Done.",
			browserRecoveryState: emptyBrowserRecoveryBudgetState(), listExecutions: () => steps,
		});
		expect(check([observation, action])).toBe(OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR);
		expect(check([action, { ...observation, status: "failed" }])).toBe(FAILED_COMPUTER_COMPLETION_ERROR);
		expect(check([action, observation])).toBeUndefined();
		expect(check([{ ...action, idempotencyKey: "other:act" }])).toBeUndefined();
	});
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

	it("requires fresh page evidence after navigation even when the model says done", () => {
		const check = (steps: RuntimeToolExecution[]) =>
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "Done.",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => steps,
			});
		const navigate = execution({
			id: "navigate",
			toolName: "browser.navigate-tab",
			idempotencyKey: "run-1:navigate",
		});
		const snapshot = execution({
			id: "snapshot",
			toolName: "browser.visible-snapshot",
			idempotencyKey: "run-1:snapshot",
		});

		expect(check([navigate])).toBe(OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR);
		expect(check([snapshot, navigate])).toBe(
			OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR,
		);
		expect(check([navigate, snapshot])).toBeUndefined();
	});

	it.each([
		["browser.navigate", "browser.snapshot", "browserSessionId"],
		["browser.navigate-tab", "browser.visible-snapshot", "tabId"],
	])("requires fresh evidence from the changed target for %s", (mutation, observation, targetKey) => {
		const check = (steps: RuntimeToolExecution[]) => prematureBrowserCompletionError({
			runId: "run-1", sessionId: "session-1", modelText: "Done.",
			browserRecoveryState: emptyBrowserRecoveryBudgetState(), listExecutions: () => steps,
		});
		const change = execution({ id: "change", toolName: mutation, idempotencyKey: "run-1:change", input: { [targetKey]: "changed" } });
		const observe = execution({ id: "observe", toolName: observation, idempotencyKey: "run-1:observe", input: { [targetKey]: "other" } });
		expect(check([change, observe])).toBe(OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR);
		expect(check([change, { ...observe, input: { [targetKey]: "changed" } }])).toBeUndefined();
		expect(check([change, { ...observe, status: "failed", input: { [targetKey]: "changed" } }])).toBe(OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR);
	});

	it.each([
		["browser.navigate", "browser.act"],
		["browser.navigate-tab", "browser.visible-act"],
	])("accepts a later action with its built-in post-action observation after %s", (navigation, action) => {
		expect(
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "The requested control is now enabled.",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => [
					execution({ id: "navigate", toolName: navigation, idempotencyKey: "run-1:navigate" }),
					execution({
						id: "act",
						toolName: action,
						idempotencyKey: "run-1:act",
						output: { performed: true, observation: { changed: true } },
					}),
				],
			}),
		).toBeUndefined();
	});

	it("requires tab-list evidence after changing visible tab ownership", () => {
		const open = execution({
			id: "open",
			toolName: "browser.open-tab",
			idempotencyKey: "run-1:open",
		});
		const tabs = execution({
			id: "tabs",
			toolName: "browser.tabs",
			idempotencyKey: "run-1:tabs",
		});
		const check = (steps: RuntimeToolExecution[]) =>
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText: "The tab is open.",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => steps,
			});

		expect(check([open])).toBe(OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR);
		expect(check([open, tabs])).toBeUndefined();
	});

	it.each(["", "Done."])("requires a fresh observation with recovery observe_required even for prose %j", (modelText) => {
		expect(
			prematureBrowserCompletionError({
				runId: "run-1",
				sessionId: "session-1",
				modelText,
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
