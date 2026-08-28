import { KestrelError } from "@kestrel/error-handling";

export const BROWSER_RECOVERY_REASON_CODES = [
	"stale_target",
	"target_missing",
	"obscured",
	"navigation_changed",
	"auth_required",
	"popup_denied",
	"network_error",
] as const;

export type BrowserRecoveryReasonCode =
	(typeof BROWSER_RECOVERY_REASON_CODES)[number];

export const BROWSER_RECOVERY_HINT_KINDS = [
	"snapshot",
	"reobserve",
	"diagnostics",
	"auth_handoff",
	"safe_stop",
] as const;

export type BrowserRecoveryHintKind =
	(typeof BROWSER_RECOVERY_HINT_KINDS)[number];
export type BrowserRecoverySurface = "isolated" | "visible";
export type BrowserRecoveryOperation =
	| "act"
	| "navigate"
	| "upload"
	| "observe";
export type BrowserEffectState =
	| "not_started"
	| "unknown"
	| "possibly_started";

export interface BrowserRecoveryHint {
	kind: BrowserRecoveryHintKind;
	description: string;
	toolName?:
		| "browser.snapshot"
		| "browser.visible-snapshot"
		| "browser.diagnostics"
		| "browser.auth-handoff";
	readOnly: boolean;
	requiresApproval: boolean;
}

export interface BrowserRecoveryGuidance {
	reasonCode: BrowserRecoveryReasonCode;
	operation: BrowserRecoveryOperation;
	surface: BrowserRecoverySurface;
	effectState: BrowserEffectState;
	automaticReplayAllowed: false;
	advisoryOnly: true;
	hints: BrowserRecoveryHint[];
}

export interface BrowserRecoveryContext {
	operation: BrowserRecoveryOperation;
	surface: BrowserRecoverySurface;
	effectState: BrowserEffectState;
}

const PRECONDITION_FAILURES = new Set<BrowserRecoveryReasonCode>([
	"stale_target",
	"target_missing",
	"obscured",
]);

const EFFECT_STATE_RANK: Record<BrowserEffectState, number> = {
	not_started: 0,
	unknown: 1,
	possibly_started: 2,
};

const HINTS_BY_REASON: Record<
	BrowserRecoveryReasonCode,
	BrowserRecoveryHintKind[]
> = {
	stale_target: ["snapshot", "reobserve", "safe_stop"],
	target_missing: ["snapshot", "reobserve", "diagnostics", "safe_stop"],
	obscured: ["snapshot", "reobserve", "safe_stop"],
	navigation_changed: ["snapshot", "reobserve", "diagnostics", "safe_stop"],
	auth_required: ["snapshot", "auth_handoff", "safe_stop"],
	popup_denied: ["diagnostics", "safe_stop"],
	network_error: ["diagnostics", "snapshot", "safe_stop"],
};

function snapshotTool(
	surface: BrowserRecoverySurface,
): "browser.snapshot" | "browser.visible-snapshot" {
	return surface === "isolated" ? "browser.snapshot" : "browser.visible-snapshot";
}

function recoveryHint(
	kind: BrowserRecoveryHintKind,
	surface: BrowserRecoverySurface,
): BrowserRecoveryHint {
	if (kind === "snapshot")
		return {
			kind,
			description: "Take a fresh accessibility snapshot before deciding on another action.",
			toolName: snapshotTool(surface),
			readOnly: true,
			requiresApproval: false,
		};
	if (kind === "reobserve")
		return {
			kind,
			description: "Reacquire the target from fresh page state; never reuse the failed reference.",
			readOnly: true,
			requiresApproval: false,
		};
	if (kind === "diagnostics")
		return {
			kind,
			description:
				surface === "isolated"
					? "Inspect bounded browser diagnostics for a supporting console or network error."
					: "Inspect the visible tab's current loading or error state without changing it.",
			...(surface === "isolated"
				? { toolName: "browser.diagnostics" as const }
				: {}),
			readOnly: true,
			requiresApproval: false,
		};
	if (kind === "auth_handoff")
		return {
			kind,
			description:
				surface === "isolated"
					? "Offer an explicit user authentication handoff; never request or expose credentials to the model."
					: "Ask the user to authenticate directly in the visible tab without exposing credentials to the model.",
			...(surface === "isolated"
				? { toolName: "browser.auth-handoff" as const }
				: {}),
			readOnly: false,
			requiresApproval: true,
		};
	return {
		kind,
		description:
			"Stop safely, preserve the current task evidence, and request only the missing intervention.",
		readOnly: true,
		requiresApproval: false,
	};
}

function guidance(
	reasonCode: BrowserRecoveryReasonCode,
	context: BrowserRecoveryContext,
): BrowserRecoveryGuidance {
	return {
		reasonCode,
		operation: context.operation,
		surface: context.surface,
		effectState: PRECONDITION_FAILURES.has(reasonCode)
			? "not_started"
			: context.effectState,
		automaticReplayAllowed: false,
		advisoryOnly: true,
		hints: HINTS_BY_REASON[reasonCode].map((kind) =>
			recoveryHint(kind, context.surface),
		),
	};
}

function moreConservativeEffectState(
	left: BrowserEffectState,
	right: BrowserEffectState,
): BrowserEffectState {
	return EFFECT_STATE_RANK[left] >= EFFECT_STATE_RANK[right] ? left : right;
}

export class BrowserRecoveryError extends KestrelError {
	readonly recovery: BrowserRecoveryGuidance;

	constructor(
		message: string,
		recovery: BrowserRecoveryGuidance,
		cause?: unknown,
	) {
		super({
			code: "browser_recovery_required",
			message,
			cause,
			retryable: false,
			metadata: { recovery },
		});
		this.name = "BrowserRecoveryError";
		this.recovery = recovery;
	}
}

export function browserRecoveryReason(
	error: unknown,
): BrowserRecoveryReasonCode | undefined {
	if (!(error instanceof Error)) return undefined;
	const message = error.message.toLowerCase();
	if (/\b(cancelled|canceled|aborted)\b|aborterror/.test(message))
		return undefined;
	if (
		/(?:target|element) ref (?:is )?stale|stale (?:browser )?(?:target|state)/.test(
			message,
		)
	)
		return "stale_target";
	if (
		/browser (?:upload )?target (?:was )?not found|browser (?:session|tab) is unavailable|no browser tab is active|selected tab does not have a readable web page/.test(
			message,
		)
	)
		return "target_missing";
	if (
		/browser target is (?:not visible|disabled|outside the viewport|obscured)|cannot receive pointer input/.test(
			message,
		)
	)
		return "obscured";
	if (
		/execution context.*destroyed|frame.*detached|page (?:has )?changed|navigation (?:has )?changed|target closed|cannot find context/.test(
			message,
		)
	)
		return "navigation_changed";
	if (
		/(?:authentication|login|sign[ -]?in).*(?:required|expired)|(?:required|expired).*(?:authentication|login|sign[ -]?in)|(?:browser|fixture|user) session expired/.test(
			message,
		)
	)
		return "auth_required";
	if (/popup.*(?:denied|blocked)|(?:denied|blocked).*popup/.test(message))
		return "popup_denied";
	if (
		/\b(?:network error|network disconnected|network unavailable|failed to fetch|load failed|internet disconnected)\b|net::err_|err_(?:internet_disconnected|network_changed|connection_[a-z_]+|name_not_resolved|timed_out)|\b(?:enotfound|econnreset|econnrefused)\b/.test(
			message,
		)
	)
		return "network_error";
	return undefined;
}

export function toBrowserRecoveryError(
	error: unknown,
	context: BrowserRecoveryContext,
): BrowserRecoveryError | undefined {
	if (error instanceof BrowserRecoveryError) {
		const effectState = moreConservativeEffectState(
			error.recovery.effectState,
			context.effectState,
		);
		if (
			effectState === error.recovery.effectState &&
			context.operation === error.recovery.operation &&
			context.surface === error.recovery.surface
		)
			return error;
		return new BrowserRecoveryError(
			error.message,
			{
				...guidance(error.recovery.reasonCode, context),
				effectState,
			},
			error,
		);
	}
	const reasonCode = browserRecoveryReason(error);
	if (!reasonCode || !(error instanceof Error)) return undefined;
	return new BrowserRecoveryError(error.message, guidance(reasonCode, context), error);
}

export async function withBrowserRecovery<T>(
	context: BrowserRecoveryContext,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw toBrowserRecoveryError(error, context) ?? error;
	}
}
