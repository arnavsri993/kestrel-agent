import type { KestrelDatabase } from "@kestrel/database";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import type { BrowserRecoveryBudgetState } from "./browser-recovery";

export const PREMATURE_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before confirming the browser task was finished. Review the last browser steps, then retry or send a follow-up.";

export const OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before taking the required fresh browser observation. Retry the last turn or ask for a follow-up.";

export function prematureBrowserCompletionError(input: {
	runId: string;
	sessionId: string;
	modelText: string;
	browserRecoveryState: BrowserRecoveryBudgetState;
	listExecutions: (sessionId: string) => RuntimeToolExecution[];
}): string | undefined {
	const modelText = input.modelText.trim();
	const runPrefix = `${input.runId}:`;
	const browserExecutions = input.listExecutions(input.sessionId).filter(
		(execution) =>
			execution.idempotencyKey?.startsWith(runPrefix) === true &&
			execution.toolName.startsWith("browser."),
	);
	const observeRequired = input.browserRecoveryState.entries.some(
		(entry) => entry.phase === "observe_required",
	);

	// A prose reply must not skip a required fresh observation. Empty-text
	// completion is still blocked whenever this run performed browser work.
	if (observeRequired && browserExecutions.length > 0) {
		return OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR;
	}
	if (modelText) return undefined;
	if (browserExecutions.length === 0) return undefined;

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
