import { createHash } from "node:crypto";
import type { RuntimeToolExecution } from "@kestrel/shared-types";

interface RedactionState {
	redactions: number;
	tokens: Map<string, string>;
	nextTokenByKind: Map<string, number>;
}

const PRIVATE_KEY_PATTERN =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const SENSITIVE_ASSIGNMENT_PATTERN =
	/\b(api[_ -]?key|access[_ -]?token|auth(?:orization)?|client[_ -]?secret|password|secret|private[_ -]?key|session[_ -]?cookie|credential)\b(\s*[:=]\s*)(["'`]?)([^\s"'`,;&}]{8,})(\3)/gi;
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g;
const OPENAI_KEY_PATTERN = /\bsk-(?:proj-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,})\b/g;
const GITHUB_TOKEN_PATTERN =
	/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_\-]{16,}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g;
const BEARER_TOKEN_PATTERN =
	/(\bBearer\s+)([A-Za-z0-9._~+\/-]{20,})/gi;

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
	return /(?:^|_)(?:api_key|access_token|auth|authorization|client_secret|password|secret|private_key|session_cookie|credential)(?:$|_)/.test(
		normalized,
	);
}

function redactText(value: string, state: RedactionState): string {
	let redacted = value.replace(
		PRIVATE_KEY_PATTERN,
		(match) => tokenFor("PRIVATE_KEY", match, state),
	);
	redacted = redacted.replace(
		SENSITIVE_ASSIGNMENT_PATTERN,
		(_match, key: string, separator: string, quote: string, secret: string) =>
			`${key}${separator}${quote}${tokenFor(assignmentKind(key), secret, state)}${quote}`,
	);
	redacted = redacted.replace(
		ANTHROPIC_KEY_PATTERN,
		(match) => tokenFor("ANTHROPIC_API_KEY", match, state),
	);
	redacted = redacted.replace(
		OPENAI_KEY_PATTERN,
		(match) => tokenFor("OPENAI_API_KEY", match, state),
	);
	redacted = redacted.replace(
		GITHUB_TOKEN_PATTERN,
		(match) => tokenFor("GITHUB_TOKEN", match, state),
	);
	redacted = redacted.replace(
		GOOGLE_API_KEY_PATTERN,
		(match) => tokenFor("GOOGLE_API_KEY", match, state),
	);
	redacted = redacted.replace(
		AWS_ACCESS_KEY_PATTERN,
		(match) => tokenFor("AWS_ACCESS_KEY", match, state),
	);
	redacted = redacted.replace(
		SLACK_TOKEN_PATTERN,
		(match) => tokenFor("SLACK_TOKEN", match, state),
	);
	return redacted.replace(
		BEARER_TOKEN_PATTERN,
		(_match, prefix: string, token: string) =>
			`${prefix}${tokenFor("BEARER_TOKEN", token, state)}`,
	);
}

/** Redact a previously persisted tool-message payload before replaying it. */
export function redactSensitiveContent(value: string): string {
	return redactText(value, createRedactionState());
}

function redactValue(
	value: unknown,
	state: RedactionState,
	key?: string,
): unknown {
	if (typeof value === "string")
		return key && isSensitiveKey(key)
			? tokenFor(assignmentKind(key), value, state)
			: redactText(value, state);
	if (typeof value === "number" || typeof value === "boolean")
		return key && isSensitiveKey(key)
			? tokenFor(assignmentKind(key), String(value), state)
			: value;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, state));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, childValue]) => [
				childKey,
				redactValue(childValue, state, childKey),
			]),
		);
	}
	return value;
}

/**
 * Format a tool result for conversation history and model context.
 *
 * The encrypted execution record remains unchanged; only the model-facing
 * copy is redacted so a local read of a secret-bearing file or external page
 * cannot replay that secret into a hosted model on a later turn.
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
