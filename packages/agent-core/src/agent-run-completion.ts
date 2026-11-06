import type { KestrelDatabase } from "@kestrel/database";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import type { BrowserRecoveryBudgetState } from "./browser-recovery";

export const PREMATURE_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before confirming the browser task was finished. Review the last browser steps, then retry or send a follow-up.";

export const OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before taking the required fresh browser observation. Retry the last turn or ask for a follow-up.";

export const OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR =
	"Kestrel stopped before checking the result of its desktop input. Take a fresh computer.screenshot and inspect it before completing the task.";

// An input receipt confirms delivery, not the visible result. The final model
// request must have received a distinct screenshot taken after the last input.
export function computerCompletionError(input: {
	runId: string;
	sessionId: string;
	observedExecutionId?: string | undefined;
	listExecutions: (sessionId: string) => RuntimeToolExecution[];
}): string | undefined {
	const executions = input.listExecutions(input.sessionId).filter(execution =>
		execution.sessionId === input.sessionId && execution.idempotencyKey?.startsWith(`${input.runId}:`));
	const actions = executions.filter(execution => execution.toolName === "computer.act" && execution.status === "verified");
	if (!actions.length) return undefined;
	const observation = executions.find(execution => execution.id === input.observedExecutionId &&
		execution.toolName === "computer.screenshot" && execution.status === "verified");
	const capturedAt = Date.parse(String(observation?.output?.capturedAt ?? ""));
	if (!observation || typeof observation.output?.captureId !== "string" || !Number.isFinite(capturedAt) ||
		actions.some(action => {
			const finishedAt = Date.parse(action.completedAt ?? "");
			const actionInput = action.input.action as Record<string, unknown> | undefined;
			return !Number.isFinite(finishedAt) || capturedAt < finishedAt ||
				observation.output?.captureId === actionInput?.captureId;
		})) return OBSERVE_REQUIRED_COMPUTER_COMPLETION_ERROR;
	return undefined;
}

export function prematureBrowserCompletionError(input: {
	runId: string;
	sessionId: string;
	modelText: string;
	browserRecoveryState: BrowserRecoveryBudgetState;
	listExecutions: (sessionId: string) => RuntimeToolExecution[];
}): string | undefined {
	const modelText = input.modelText.trim();
	if (modelText) return undefined;

	const runPrefix = `${input.runId}:`;
	const browserExecutions = input.listExecutions(input.sessionId).filter(
		(execution) =>
			execution.idempotencyKey?.startsWith(runPrefix) === true &&
			execution.toolName.startsWith("browser."),
	);
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
