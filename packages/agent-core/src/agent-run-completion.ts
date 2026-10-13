import type { KestrelDatabase } from "@kestrel/database";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import type { BrowserRecoveryBudgetState } from "./browser-recovery";

export const PREMATURE_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before confirming the browser task was finished. Review the last browser steps, then retry or send a follow-up.";

export const OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before taking the required fresh browser observation. Retry the last turn or ask for a follow-up.";

export const OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR =
	"Kestrel stopped before checking the visible result of its last computer action. Take a fresh desktop screenshot before claiming completion.";
export const FAILED_COMPUTER_COMPLETION_ERROR =
	"Kestrel stopped after a computer tool failed. Check the reported native permission or helper error, then take a fresh desktop screenshot before continuing.";

export function prematureBrowserCompletionError(input: {
	runId: string;
	sessionId: string;
	modelText: string;
	browserRecoveryState: BrowserRecoveryBudgetState;
	listExecutions: (sessionId: string) => RuntimeToolExecution[];
}): string | undefined {
	const runPrefix = `${input.runId}:`;
	const executions = input.listExecutions(input.sessionId).filter(
		(execution) =>
			execution.idempotencyKey?.startsWith(runPrefix) === true,
	);
	let desktopObservationRequired = false;
	let desktopFailureUnresolved = false;
	for (const execution of executions) {
		if (execution.toolName.startsWith("computer.") && execution.status === "failed")
			desktopFailureUnresolved = true;
		if (execution.status !== "verified") continue;
		if (execution.toolName === "computer.act") desktopObservationRequired = true;
		if (execution.toolName === "computer.screenshot") {
			desktopObservationRequired = false;
			desktopFailureUnresolved = false;
		}
	}
	if (desktopFailureUnresolved) return FAILED_COMPUTER_COMPLETION_ERROR;
	if (desktopObservationRequired) return OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR;
	const modelText = input.modelText.trim();
	if (modelText) return undefined;
	const browserExecutions = executions.filter((execution) => execution.toolName.startsWith("browser."));
	if (browserExecutions.length === 0) return undefined;

	if (
		input.browserRecoveryState.entries.some(
			(entry) => entry.phase === "observe_required",
		)
	) {
		return OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR;
	}

	return PREMATURE_BROWSER_COMPLETION_ERROR;
}

export function prematureBrowserCompletionErrorForRun(
	database: KestrelDatabase,
	input: {
		runId: string;
		sessionId: string;
		modelText: string;
		browserRecoveryState: BrowserRecoveryBudgetState;
	},
): string | undefined {
	return prematureBrowserCompletionError({
		...input,
		listExecutions: (sessionId) => database.listToolExecutions(sessionId),
	});
}
