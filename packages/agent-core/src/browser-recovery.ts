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

export type BrowserRecoveryBudgetPhase =
	| "observe_required"
	| "retry_ready"
	| "stop_required"
	| "resolved";

export interface BrowserRecoveryBudgetEntry {
	signature: string;
	reasonCode: BrowserRecoveryReasonCode;
	operation: BrowserRecoveryOperation;
	surface: BrowserRecoverySurface;
	failureCount: number;
	maximumFailures: number;
	phase: BrowserRecoveryBudgetPhase;
	allowedToolNames: string[];
	sequence: number;
}

export interface BrowserRecoveryBudgetState {
	version: 1;
	nextSequence: number;
	entries: BrowserRecoveryBudgetEntry[];
}

export interface BrowserRecoveryBudgetPlan {
	signature: string;
	failureCount: number;
	maximumFailures: number;
	phase: Exclude<BrowserRecoveryBudgetPhase, "resolved">;
	mutationBlocked: boolean;
	automaticReplayAllowed: false;
	allowedToolNames: string[];
	message: string;
}

export interface BrowserRecoveryBudgetBlock {
	reason: string;
	plan: BrowserRecoveryBudgetPlan;
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

const MAX_TRACKED_RECOVERY_SIGNATURES =
	BROWSER_RECOVERY_REASON_CODES.length * 4 * 2;

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

function recoverySignature(guidance: BrowserRecoveryGuidance): string {
	return `${guidance.surface}:${guidance.operation}:${guidance.reasonCode}`;
}

function maximumRecoveryFailures(guidance: BrowserRecoveryGuidance): number {
	return guidance.effectState === "not_started" ? 2 : 1;
}

function allowedRecoveryTools(guidance: BrowserRecoveryGuidance): string[] {
	return [
		...new Set(
			HINTS_BY_REASON[guidance.reasonCode]
				.map((kind) => recoveryHint(kind, guidance.surface))
				.flatMap((hint) =>
				hint.toolName &&
				(hint.readOnly || hint.kind === "auth_handoff")
					? [hint.toolName]
					: [],
				),
		),
	];
}

function planForEntry(entry: BrowserRecoveryBudgetEntry): BrowserRecoveryBudgetPlan {
	const phase =
		entry.phase === "resolved" ? "stop_required" : entry.phase;
	return {
		signature: entry.signature,
		failureCount: entry.failureCount,
		maximumFailures: entry.maximumFailures,
		phase,
		mutationBlocked: phase !== "retry_ready",
		automaticReplayAllowed: false,
		allowedToolNames: [...entry.allowedToolNames],
		message:
			phase === "stop_required"
				? "The bounded recovery budget is exhausted. Preserve the evidence, stop browser mutations on this surface, and request only the missing intervention."
				: phase === "observe_required"
					? "Take one fresh allowed read-only observation before deciding whether a single retry is safe. Do not replay the failed action yet."
					: "A fresh observation succeeded. At most one deliberate retry may proceed; a repeated matching failure will stop browser mutations on this surface.",
	};
}

export function emptyBrowserRecoveryBudgetState(): BrowserRecoveryBudgetState {
	return { version: 1, nextSequence: 1, entries: [] };
}

export function applyBrowserRecoveryBudget(
	state: BrowserRecoveryBudgetState,
	guidance: BrowserRecoveryGuidance,
): { state: BrowserRecoveryBudgetState; plan: BrowserRecoveryBudgetPlan } {
	const signature = recoverySignature(guidance);
	const previous = state.entries.find((entry) => entry.signature === signature);
	const maximumFailures = maximumRecoveryFailures(guidance);
	const failureCount = Math.min(
		maximumFailures,
		(previous?.failureCount ?? 0) + 1,
	);
	const entry: BrowserRecoveryBudgetEntry = {
		signature,
		reasonCode: guidance.reasonCode,
		operation: guidance.operation,
		surface: guidance.surface,
		failureCount,
		maximumFailures,
		phase:
			failureCount >= maximumFailures ? "stop_required" : "observe_required",
		allowedToolNames: allowedRecoveryTools(guidance),
		sequence: state.nextSequence,
	};
	const entries = [
		...state.entries.filter((item) => item.signature !== signature),
		entry,
	]
		.sort((left, right) => left.sequence - right.sequence)
		.slice(-MAX_TRACKED_RECOVERY_SIGNATURES);
	return {
		state: {
			version: 1,
			nextSequence: state.nextSequence + 1,
			entries,
		},
		plan: planForEntry(entry),
	};
}

export function browserRecoveryGuidanceFromOutput(
	output: unknown,
): BrowserRecoveryGuidance | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
	const recovery = (output as Record<string, unknown>).recovery;
	if (!recovery || typeof recovery !== "object" || Array.isArray(recovery))
		return undefined;
	const candidate = recovery as Partial<BrowserRecoveryGuidance>;
	if (
		!BROWSER_RECOVERY_REASON_CODES.includes(
			candidate.reasonCode as BrowserRecoveryReasonCode,
		) ||
		!(["act", "navigate", "upload", "observe"] as const).includes(
			candidate.operation as BrowserRecoveryOperation,
		) ||
		!(["isolated", "visible"] as const).includes(
			candidate.surface as BrowserRecoverySurface,
		) ||
		!(["not_started", "unknown", "possibly_started"] as const).includes(
			candidate.effectState as BrowserEffectState,
		) ||
		candidate.automaticReplayAllowed !== false ||
		candidate.advisoryOnly !== true ||
		!Array.isArray(candidate.hints)
	)
		return undefined;
	const operation = candidate.operation as BrowserRecoveryOperation;
	const surface = candidate.surface as BrowserRecoverySurface;
	const effectState = candidate.effectState as BrowserEffectState;
	return {
		...guidance(candidate.reasonCode as BrowserRecoveryReasonCode, {
			operation,
			surface,
			effectState,
		}),
		// An already-wrapped recovery error can conservatively upgrade a
		// precondition failure after crossing another browser boundary.
		effectState,
	};
}

export function browserRecoveryToolSurface(
	toolName: string,
): BrowserRecoverySurface | undefined {
	if (!toolName.startsWith("browser.")) return undefined;
	if (
		toolName.startsWith("browser.visible-") ||
		[
			"browser.tabs",
			"browser.current-context",
			"browser.search-history",
			"browser.navigate-tab",
			"browser.open-tab",
			"browser.close-tab",
			"browser.select-tab",
		].includes(toolName)
	)
		return "visible";
	return "isolated";
}

export function recordBrowserRecoveryToolSuccess(
	state: BrowserRecoveryBudgetState,
	toolName: string,
	readOnly: boolean,
): BrowserRecoveryBudgetState {
	const surface = browserRecoveryToolSurface(toolName);
	if (!surface) return state;
	let changed = false;
	const entries = state.entries.map((entry) => {
		if (entry.surface !== surface) return entry;
		if (
			entry.phase === "observe_required" &&
			readOnly &&
			entry.allowedToolNames.includes(toolName)
		) {
			changed = true;
			return { ...entry, phase: "retry_ready" as const };
		}
		if (
			!readOnly &&
			(entry.phase === "retry_ready" ||
				(entry.reasonCode === "auth_required" &&
					entry.allowedToolNames.includes(toolName)))
		) {
			changed = true;
			return { ...entry, phase: "resolved" as const };
		}
		return entry;
	});
	return changed ? { ...state, entries } : state;
}

export function browserRecoveryBlockForTool(
	state: BrowserRecoveryBudgetState,
	toolName: string,
	readOnly: boolean,
): BrowserRecoveryBudgetBlock | undefined {
	if (readOnly) return undefined;
	const surface = browserRecoveryToolSurface(toolName);
	if (!surface) return undefined;
	const explicitAuthHandoff = state.entries.some(
		(entry) =>
			entry.surface === surface &&
			entry.reasonCode === "auth_required" &&
			(entry.phase === "observe_required" || entry.phase === "stop_required") &&
			entry.allowedToolNames.includes(toolName),
	);
	if (explicitAuthHandoff) return undefined;
	const active = state.entries
		.filter(
			(entry) =>
				entry.surface === surface &&
				(entry.phase === "observe_required" || entry.phase === "stop_required"),
		)
		.sort((left, right) => {
			if (left.phase !== right.phase)
				return left.phase === "stop_required" ? -1 : 1;
			return right.sequence - left.sequence;
		});
	const entry = active[0];
	if (!entry) return undefined;
	const plan = planForEntry(entry);
	return {
		reason:
			entry.phase === "stop_required"
				? "Kestrel blocked this browser mutation because the bounded recovery budget for this surface is exhausted."
				: "Kestrel blocked this browser mutation until the required fresh read-only observation succeeds.",
		plan,
	};
}
