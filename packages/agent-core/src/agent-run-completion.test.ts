import { describe, expect, it } from "vitest";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { emptyBrowserRecoveryBudgetState } from "./browser-recovery";
import {
	OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR,
	PREMATURE_BROWSER_COMPLETION_ERROR,
	UNVERIFIED_BROWSER_CLICK_COMPLETION_ERROR,
	isUnexecutedLocalPlan,
	prematureBrowserCompletionError,
	unverifiedBrowserClickNarration,
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
	it.each(["Let's execute:", "Let’s execute:", "Plan:\nLet's begin."])("recognizes a terminal unfinished execution plan: %s", text => {
		expect(isUnexecutedLocalPlan(text)).toBe(true);
	});
	it.each(["Here is the requested plan.", "> Let's execute:", "Let's execute the following code in your own terminal."])("does not reinterpret final explanations or quoted plans: %s", text => {
		expect(isUnexecutedLocalPlan(text)).toBe(false);
	});
	it.each([
		"The verification button click was executed.",
		"I clicked the Show verification button.",
		"We have successfully clicked the button.",
		"Outcome: The Reveal verification button has been clicked on the local page, exposing a hidden verification line.",
		"The link was successfully clicked.",
	])("rejects an unsupported completed click claim: %s", modelText => {
		expect(prematureBrowserCompletionError({
			runId: "run-1", sessionId: "session-1", modelText,
			browserRecoveryState: emptyBrowserRecoveryBudgetState(),
			listExecutions: () => [
				execution({ id: "read", idempotencyKey: "run-1:read", toolName: "browser.visible-snapshot" }),
				execution({ id: "denied", idempotencyKey: "run-1:denied", toolName: "browser.visible-act", status: "blocked", input: { action: { type: "click" } } }),
				execution({ id: "old-click", idempotencyKey: "run-0:click", toolName: "browser.visible-act", input: { action: { type: "click" } } }),
			],
		})).toBe(UNVERIFIED_BROWSER_CLICK_COMPLETION_ERROR);
	});
	it("accepts a completed click claim only with a verified click in this run", () => {
		for (const type of ["click", "type"]) {
			expect(prematureBrowserCompletionError({
				runId: "run-1", sessionId: "session-1", modelText: "I clicked the button.",
				browserRecoveryState: emptyBrowserRecoveryBudgetState(),
				listExecutions: () => [execution({ id: "action", idempotencyKey: "run-1:action", toolName: "browser.visible-act", input: { action: { type } } })],
			})).toBe(type === "click" ? undefined : UNVERIFIED_BROWSER_CLICK_COMPLETION_ERROR);
		}
	});
	it.each([
		"I could not click the button. No action was taken.",
		"I will click the button after approval.",
		"Click the button to continue.",
		"The click was not executed.",
		"The button has not been clicked.",
		"If the button was clicked, read the result.",
		"Once the element has been clicked, a result should appear.",
		"For example: the button has been clicked.",
		"> I clicked the button.\nThe quoted claim is unverified.",
		"```text\nI clicked the button.\n```\nThis is example text.",
	])("preserves limitations, instructions and quoted examples: %s", modelText => {
		expect(prematureBrowserCompletionError({
			runId: "run-1", sessionId: "session-1", modelText,
			browserRecoveryState: emptyBrowserRecoveryBudgetState(),
			listExecutions: () => [execution({ id: "read", idempotencyKey: "run-1:read", toolName: "browser.visible-snapshot" })],
		})).toBeUndefined();
	});
	it("checks a first tool request even before any browser execution exists", () => {
		expect(unverifiedBrowserClickNarration({
			runId: "run-1", sessionId: "session-1",
			modelText: "The button has been clicked.", listExecutions: () => [],
		})).toBe(true);
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
