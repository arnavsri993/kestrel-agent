import { createHash } from "node:crypto";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { replaceSensitiveText } from "@kestrel/shared-types";
export { replaceSensitiveText } from "@kestrel/shared-types";

interface RedactionState {
	redactions: number;
	tokens: Map<string, string>;
	nextTokenByKind: Map<string, number>;
}

function createRedactionState(): RedactionState {
	return {
		redactions: 0,
		tokens: new Map(),
		nextTokenByKind: new Map(),
	};
}

function tokenFor(kind: string, value: string, state: RedactionState): string {
	const fingerprint = createHash("sha256").update(value).digest("hex");
	const existing = state.tokens.get(fingerprint);
	if (existing) {
		state.redactions += 1;
		return existing;
	}
	const next = (state.nextTokenByKind.get(kind) ?? 0) + 1;
	state.nextTokenByKind.set(kind, next);
	const token = `[${kind}_${next}]`;
	state.tokens.set(fingerprint, token);
	state.redactions += 1;
	return token;
}

function normalizedKey(key: string): string {
	return key
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replaceAll("-", "_")
		.replaceAll(" ", "_");
}

function assignmentKind(key: string): string {
	const normalized = normalizedKey(key);
	if (normalized.includes("password")) return "PASSWORD";
	if (normalized.includes("private_key")) return "PRIVATE_KEY";
	if (normalized.includes("cookie")) return "SESSION_COOKIE";
	if (normalized.includes("credential")) return "CREDENTIAL";
	if (normalized.includes("secret")) return "SECRET";
	if (normalized.includes("authorization") || normalized === "auth")
		return "AUTHORIZATION";
	if (normalized.includes("access_token")) return "ACCESS_TOKEN";
	return "API_KEY";
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizedKey(key);
	if (/(?:^|_)(?:available|enabled|disabled|required|configured|present|count|length|status|name|label|hint)$/.test(normalized)) return false;
	return /(?:^|_)(?:api_key|access_token|auth|authorization|client_secret|password|secret|private_key|session_cookie|credential)(?:$|_)/.test(
		normalized,
	);
}

function redactText(value: string, state: RedactionState): string {
	return replaceSensitiveText(value, (kind, secret) => tokenFor(kind, secret, state));
}

/** Redact a previously persisted tool-message payload before replaying it. */
export function redactSensitiveContent(value: string): string {
	return redactText(value, createRedactionState());
}

function redactValue(
	value: unknown,
	state: RedactionState,
	key?: string,
	redactKnownText: (text: string) => string = text => text,
): unknown {
	if (typeof value === "string")
		return key && isSensitiveKey(key) && !/^(?:\[(?:[A-Z][A-Z0-9_]*_\d+|REDACTED|TASK_SECRET:[^\]]+)\]|task-secret-[a-f0-9-]{36})$/.test(value)
			? tokenFor(assignmentKind(key), value, state)
			: redactKnownText(redactText(value, state));
	if (typeof value === "boolean") return value;
	if (typeof value === "number")
		return key && isSensitiveKey(key)
			? tokenFor(assignmentKind(key), String(value), state)
			: value;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, state, undefined, redactKnownText));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, childValue]) => [
				childKey,
				redactValue(childValue, state, childKey, redactKnownText),
			]),
		);
	}
	return value;
}

/** Durable records use the same protections as model-facing results. */
export function redactSensitiveValue(value: unknown, redactKnownText?: (text: string) => string): unknown {
	return redactValue(value, createRedactionState(), undefined, redactKnownText);
}

/**
 * Format a tool result for conversation history and model context.
 *
 * This is independent defense at the provider boundary. Runtime journals use
 * redactSensitiveValue too; encryption alone is not permission to retain keys.
 */
export function modelVisibleToolResult(execution: RuntimeToolExecution): string {
	const state = createRedactionState();
	const output =
		execution.output === undefined
			? undefined
			: redactValue(execution.output, state);
	const error = execution.error
		? redactText(execution.error, state)
		: undefined;
	return JSON.stringify({
		status: execution.status,
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
		...(state.redactions > 0
			? {
					safety: {
						redactedSensitiveData: true,
						redactionCount: state.redactions,
						note: "Sensitive-looking values were replaced locally before this result reached the model. Never reconstruct or request a redacted value.",
					},
				}
			: {}),
	});
}
