import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { screenshotTextOutput } from "./screenshot-model-context";

interface RedactionState {
	redactions: number;
	nextTokenByKind: Map<string, number>;
}

// Match through KEY before checking the trailing delimiter so malformed
// headers cannot hide key material. Words and whitespace do not overlap.
const PRIVATE_KEY_MARKER = /-----(BEGIN|END)[ \t\r\n]+((?:[A-Z0-9]+[ \t\r\n]+)*)PRIVATE[ \t\r\n]+KEY/gi;
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

/**
 * Keep model-facing tool receipts comfortably below RuntimeMessageSchema's
 * 1 MB hard limit. This is deliberately smaller than the persistence limit so
 * result metadata and future envelope fields cannot turn a safe result into a
 * rejected runtime message.
 */
export const MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS = 250_000;

function createRedactionState(): RedactionState {
	return {
		redactions: 0,
		nextTokenByKind: new Map(),
	};
}

// Mark occurrences, never secret identities. Reusing a marker for equal values
// lets known candidate values reveal an unknown secret in the same receipt.
function tokenFor(kind: string, state: RedactionState): string {
	const next = (state.nextTokenByKind.get(kind) ?? 0) + 1;
	state.nextTokenByKind.set(kind, next);
	const token = `[${kind}_${next}]`;
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

// Scan each marker once. Ambiguous nested, mismatched or incomplete blocks
// redact the remainder because it may still contain key material.
function redactPrivateKeys(value: string, state: RedactionState): string {
	PRIVATE_KEY_MARKER.lastIndex = 0;
	const parts: string[] = [];
	let cursor = 0;
	let begin: RegExpExecArray | null;
	while ((begin = PRIVATE_KEY_MARKER.exec(value))) {
		if (begin[1]!.toUpperCase() !== "BEGIN") continue;
		const beginComplete = value.startsWith("-----", PRIVATE_KEY_MARKER.lastIndex);
		if (beginComplete) PRIVATE_KEY_MARKER.lastIndex += 5;
		const end = beginComplete ? PRIVATE_KEY_MARKER.exec(value) : null;
		const label = (marker: RegExpExecArray) => marker[2]!.trim().replace(/[ \t\r\n]+/g, " ").toUpperCase();
		const matches = end?.[1]?.toUpperCase() === "END" && label(end) === label(begin) &&
			value.startsWith("-----", PRIVATE_KEY_MARKER.lastIndex);
		const blockEnd = matches ? PRIVATE_KEY_MARKER.lastIndex + 5 : value.length;
		if (matches) PRIVATE_KEY_MARKER.lastIndex = blockEnd;
		parts.push(value.slice(cursor, begin.index), tokenFor("PRIVATE_KEY", state));
		cursor = blockEnd;
		if (!matches) break;
	}
	if (cursor === 0) return value;
	parts.push(value.slice(cursor));
	return parts.join("");
}

function redactText(value: string, state: RedactionState): string {
	let redacted = redactPrivateKeys(value, state);
	redacted = redacted.replace(
		SENSITIVE_ASSIGNMENT_PATTERN,
		(_match, key: string, separator: string, quote: string) =>
			`${key}${separator}${quote}${tokenFor(assignmentKind(key), state)}${quote}`,
	);
	redacted = redacted.replace(
		ANTHROPIC_KEY_PATTERN,
		() => tokenFor("ANTHROPIC_API_KEY", state),
	);
	redacted = redacted.replace(
		OPENAI_KEY_PATTERN,
		() => tokenFor("OPENAI_API_KEY", state),
	);
	redacted = redacted.replace(
		GITHUB_TOKEN_PATTERN,
		() => tokenFor("GITHUB_TOKEN", state),
	);
	redacted = redacted.replace(
		GOOGLE_API_KEY_PATTERN,
		() => tokenFor("GOOGLE_API_KEY", state),
	);
	redacted = redacted.replace(
		AWS_ACCESS_KEY_PATTERN,
		() => tokenFor("AWS_ACCESS_KEY", state),
	);
	redacted = redacted.replace(
		SLACK_TOKEN_PATTERN,
		() => tokenFor("SLACK_TOKEN", state),
	);
	return redacted.replace(
		BEARER_TOKEN_PATTERN,
		(_match, prefix: string) =>
			`${prefix}${tokenFor("BEARER_TOKEN", state)}`,
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
			? tokenFor(assignmentKind(key), state)
			: redactText(value, state);
	if (typeof value === "number" || typeof value === "boolean")
		return key && isSensitiveKey(key)
			? tokenFor(assignmentKind(key), state)
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
 * The original execution record remains unchanged; only the model-facing
 * copy is redacted so a local read of a secret-bearing file or external page
 * cannot replay that secret into a hosted model on a later turn.
 */
export function modelVisibleToolResult(execution: RuntimeToolExecution): string {
	const state = createRedactionState();
	const output =
		execution.output === undefined
			? undefined
			: redactValue(screenshotTextOutput(execution), state);
	const error = execution.error
		? redactText(execution.error, state)
		: undefined;
	const result = {
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
	};
	const serialized = JSON.stringify(result);
	if (serialized.length <= MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS)
		return serialized;

	return JSON.stringify({
		status: execution.status,
		output: {
			truncated: true,
			originalCharacterCount: serialized.length,
			limitCharacterCount: MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
			message:
				"The tool result was too large to add to model context. Do not assume omitted details were read; use a narrower request or a scoped tool.",
		},
		...(state.redactions > 0
			? {
					safety: {
						redactedSensitiveData: true,
						redactionCount: state.redactions,
						note: "Sensitive-looking values were handled locally before this result reached the model.",
					},
				}
			: {}),
	});
}
