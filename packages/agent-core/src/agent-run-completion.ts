import type { KestrelDatabase } from "@kestrel/database";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import type { BrowserRecoveryBudgetState } from "./browser-recovery";

export const PREMATURE_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before confirming the browser task was finished. Review the last browser steps, then retry or send a follow-up.";

export const OBSERVE_REQUIRED_BROWSER_COMPLETION_ERROR =
	"Kestrel stopped before taking the required fresh browser observation. Retry the last turn or ask for a follow-up.";

export const UNVERIFIED_BROWSER_CLICK_COMPLETION_ERROR =
	"Kestrel could not verify the claimed browser click. No successful click was recorded in this run. Review the browser steps, then retry or send a follow-up.";

export const UNEXECUTED_LOCAL_PLAN_ERROR =
	"Kestrel returned an unfinished plan instead of carrying out its next step. No completion was verified. Retry or send a follow-up.";

export function isUnexecutedLocalPlan(text: string): boolean {
	const lastLine = text.trim().split("\n").at(-1)?.trim() ?? "";
	return /^let['’]s (?:execute|begin|proceed|do it)[.!:]?$/i.test(lastLine);
}

function claimsExecutedClick(text: string): boolean {
	let fenced = false;
	const prose = text.split("\n").filter(line => {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			fenced = !fenced;
			return false;
		}
		return !fenced && !trimmed.startsWith(">");
	}).join("\n");
	return /\b(?:I|we) (?:have )?(?:just )?(?:successfully )?clicked\b|\bclick (?:was|has been) (?:successfully )?(?:executed|performed|completed)\b/i.test(prose);
}

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
	if (browserExecutions.length === 0) return undefined;
	if (modelText) {
		if (claimsExecutedClick(modelText) && !browserExecutions.some(execution => {
			const action = execution.input.action;
			return execution.status === "verified" &&
				["browser.act", "browser.visible-act"].includes(execution.toolName) &&
				typeof action === "object" && action !== null && "type" in action && action.type === "click";
		})) return UNVERIFIED_BROWSER_CLICK_COMPLETION_ERROR;
		return undefined;
	}

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
