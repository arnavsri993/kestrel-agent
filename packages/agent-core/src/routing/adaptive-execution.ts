/**
 * Bounded, provider-neutral execution recovery policy.
 *
 * This module deliberately retains only normalized failure categories and
 * counters. Callers may pass an Error or a structured provider signal, but
 * neither its message nor any task/provider payload is returned or stored.
 */

export const ADAPTIVE_FAILURE_CATEGORIES = [
	"infrastructure",
	"provider",
	"auth",
	"tool",
	"model_reasoning",
	"insufficient_capability",
	"invalid_assumption",
	"verification",
	"timeout",
] as const;

export type AdaptiveFailureCategory =
	(typeof ADAPTIVE_FAILURE_CATEGORIES)[number];

export const ADAPTIVE_EXECUTION_ACTIONS = ["retry", "escalate", "stop"] as const;
export type AdaptiveExecutionAction =
	(typeof ADAPTIVE_EXECUTION_ACTIONS)[number];

export interface AdaptiveFailureSignal {
	category?: AdaptiveFailureCategory;
	code?: string;
	kind?: string;
	name?: string;
	status?: number;
}

export interface AdaptiveFailureClassification {
	category: AdaptiveFailureCategory;
}

export interface AdaptiveExecutionPolicy {
	maximumFailures: number;
	maximumFailuresPerCategory: number;
	maximumRetries: number;
	maximumEscalations: number;
}

export interface AdaptiveExecutionBudget {
	version: 1;
	failures: number;
	retries: number;
	escalations: number;
	failuresByCategory: Partial<Record<AdaptiveFailureCategory, number>>;
	escalatedCategories: AdaptiveFailureCategory[];
}

export interface AdaptiveExecutionDecision {
	action: AdaptiveExecutionAction;
	classification: AdaptiveFailureClassification;
	budget: AdaptiveExecutionBudget;
	reason:
		| "retry_available"
		| "escalation_available"
		| "invalid_assumption"
		| "non_recoverable_failure"
		| "failure_budget_exhausted"
		| "category_budget_exhausted"
		| "retry_budget_exhausted"
		| "escalation_budget_exhausted"
		| "escalation_cycle_prevented";
}

export const DEFAULT_ADAPTIVE_EXECUTION_POLICY: AdaptiveExecutionPolicy = {
	maximumFailures: 4,
	maximumFailuresPerCategory: 2,
	maximumRetries: 2,
	maximumEscalations: 1,
};

const ESCALATABLE_CATEGORIES = new Set<AdaptiveFailureCategory>([
	"model_reasoning",
	"insufficient_capability",
	"verification",
]);

const RETRYABLE_CATEGORIES = new Set<AdaptiveFailureCategory>([
	"infrastructure",
	"provider",
	"auth",
	"tool",
	"timeout",
]);

const CATEGORY_SET = new Set<string>(ADAPTIVE_FAILURE_CATEGORIES);

function normalizedText(value: unknown): string {
	return typeof value === "string"
		? value.toLowerCase().replaceAll(/[_-]+/g, " ")
		: "";
}

function signalFields(signal: unknown): {
	category: string;
	code: string;
	kind: string;
	name: string;
	status: number | undefined;
	message: string;
} {
	if (signal instanceof Error) {
		return {
			category: "",
			code: "",
			kind: "",
			name: normalizedText(signal.name),
			status: undefined,
			message: normalizedText(signal.message),
		};
	}
	if (!signal || typeof signal !== "object") {
		return { category: "", code: "", kind: "", name: "", status: undefined, message: "" };
	}
	const record = signal as Record<string, unknown>;
	return {
		// Categories are a closed, machine-readable vocabulary. Preserve their
		// underscore form so a caller can explicitly classify a signal without it
		// being mistaken for free-form error text.
		category:
			typeof record.category === "string"
				? record.category.trim().toLowerCase()
				: "",
		code: normalizedText(record.code),
		kind: normalizedText(record.kind),
		name: normalizedText(record.name),
		status: typeof record.status === "number" ? record.status : undefined,
		message: normalizedText(record.message),
	};
}

function hasAny(value: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(value));
}

/**
 * Converts a raw error or structured signal into a deliberately non-sensitive
 * category. The returned value never contains source error text or payload.
 */
export function classifyAdaptiveFailure(
	signal: unknown,
): AdaptiveFailureClassification {
	const fields = signalFields(signal);
	if (CATEGORY_SET.has(fields.category)) {
		return { category: fields.category as AdaptiveFailureCategory };
	}
	const text = [fields.code, fields.kind, fields.name, fields.message]
		.filter(Boolean)
		.join(" ");

	if (fields.status === 401 || fields.status === 403 || hasAny(text, [/\bauth(?:entication|orization)?\b/, /\bcredential\b/, /\btoken\b/, /\boauth\b/, /\bforbidden\b/, /\bunauthorized\b/]))
		return { category: "auth" };
	if (hasAny(text, [/\btimeout\b/, /\bdeadline\b/, /\betimedout\b/, /\b504\b/]))
		return { category: "timeout" };
	if (hasAny(text, [/\binsufficient[ _-]?capabilit/, /\bunsupported(?:[ _-]?(?:model|feature|capability|tool|vision|image))?\b/, /\bmodel.*does not support\b/, /\bcapability.*(?:missing|unavailable)\b/]))
		return { category: "insufficient_capability" };
	if (hasAny(text, [/\bverification\b/, /\bvalidation\b/, /\bassertion\b/, /\bquality gate\b/]))
		return { category: "verification" };
	if (hasAny(text, [/\b(reasoning|hallucin|invalid response|malformed output|refusal)\b/]))
		return { category: "model_reasoning" };
	if (hasAny(text, [/\binvalid[ _-]?(?:argument|assumption|input|request)\b/, /\bnot found\b/, /\bprecondition\b/, /\bconflict\b/]))
		return { category: "invalid_assumption" };
	if (fields.status === 429 || (fields.status !== undefined && fields.status >= 500) || hasAny(text, [/\b(provider|rate[ _-]?limit|overloaded|service unavailable|quota)\b/]))
		return { category: "provider" };
	if (hasAny(text, [/\b(tool|mcp|browser|shell|command)\b/]))
		return { category: "tool" };
	return { category: "infrastructure" };
}

export function emptyAdaptiveExecutionBudget(): AdaptiveExecutionBudget {
	return {
		version: 1,
		failures: 0,
		retries: 0,
		escalations: 0,
		failuresByCategory: {},
		escalatedCategories: [],
	};
}

function boundedPolicy(
	policy: Partial<AdaptiveExecutionPolicy> | undefined,
): AdaptiveExecutionPolicy {
	const value = { ...DEFAULT_ADAPTIVE_EXECUTION_POLICY, ...policy };
	return {
		maximumFailures: Math.max(1, Math.floor(value.maximumFailures)),
		maximumFailuresPerCategory: Math.max(1, Math.floor(value.maximumFailuresPerCategory)),
		maximumRetries: Math.max(0, Math.floor(value.maximumRetries)),
		maximumEscalations: Math.max(0, Math.floor(value.maximumEscalations)),
	};
}

function withFailure(
	budget: AdaptiveExecutionBudget,
	category: AdaptiveFailureCategory,
): AdaptiveExecutionBudget {
	return {
		version: 1,
		failures: budget.failures + 1,
		retries: budget.retries,
		escalations: budget.escalations,
		failuresByCategory: {
			...budget.failuresByCategory,
			[category]: (budget.failuresByCategory[category] ?? 0) + 1,
		},
		escalatedCategories: [...budget.escalatedCategories],
	};
}

/**
 * Applies one failure to a bounded budget and chooses its only safe next
 * action. Escalation is reserved for model reasoning, capability, and
 * verification failures; provider, tool, auth, and transient failures retry
 * when budget remains and never escalate.
 */
export function decideAdaptiveExecution(
	budget: AdaptiveExecutionBudget,
	signal: unknown,
	policy?: Partial<AdaptiveExecutionPolicy>,
): AdaptiveExecutionDecision {
	const classification = classifyAdaptiveFailure(signal);
	const category = classification.category;
	const limits = boundedPolicy(policy);
	const next = withFailure(budget, category);
	const stop = (reason: AdaptiveExecutionDecision["reason"]): AdaptiveExecutionDecision => ({
		action: "stop",
		classification,
		budget: next,
		reason: reason,
	});

	if (next.failures > limits.maximumFailures) return stop("failure_budget_exhausted");
	if ((next.failuresByCategory[category] ?? 0) > limits.maximumFailuresPerCategory)
		return stop("category_budget_exhausted");
	if (category === "invalid_assumption") return stop("invalid_assumption");

	if (ESCALATABLE_CATEGORIES.has(category)) {
		if (next.escalatedCategories.includes(category))
			return stop("escalation_cycle_prevented");
		if (next.escalations >= limits.maximumEscalations)
			return stop("escalation_budget_exhausted");
		return {
			action: "escalate",
			classification,
			budget: {
				...next,
				escalations: next.escalations + 1,
				escalatedCategories: [...next.escalatedCategories, category],
			},
			reason: "escalation_available",
		};
	}

	if (RETRYABLE_CATEGORIES.has(category)) {
		if (next.retries >= limits.maximumRetries) return stop("retry_budget_exhausted");
		return {
			action: "retry",
			classification,
			budget: { ...next, retries: next.retries + 1 },
			reason: "retry_available",
		};
	}

	return stop("non_recoverable_failure");
}
