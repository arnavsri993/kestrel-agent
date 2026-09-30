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

const MAX_MODEL_BROWSER_SNAPSHOT_CHARACTERS = 32_000;

function axLabel(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "value" in value &&
		typeof value.value === "string") return value.value;
	return "";
}

const SOURCE_FILE_EXTENSIONS = [
	".tsx", ".ts", ".jsx", ".js", ".mts", ".cts", ".mjs", ".cjs",
	".py", ".rs", ".go", ".swift", ".md", ".json", ".yaml", ".yml",
] as const;

/** Scan a bounded label for a source path without regex backtracking on page text. */
function sourcePathInLabel(label: string): string | undefined {
	let token = "";
	const finish = () => {
		const lower = token.toLowerCase();
		return SOURCE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
			? token
			: undefined;
	};
	for (let index = 0; index < Math.min(label.length, 600); index += 1) {
		const character = label[index]!;
		const code = character.charCodeAt(0);
		const pathCharacter =
			(code >= 48 && code <= 57) ||
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			character === "_" || character === "." || character === "/" || character === "-";
		if (pathCharacter) token += character;
		else {
			const file = finish();
			if (file) return file;
			token = "";
		}
	}
	return finish();
}

/** Keep the full encrypted receipt, but send a small page outline to the model. */
function compactBrowserSnapshotForModel(output: unknown): unknown {
	if (!output || typeof output !== "object" || Array.isArray(output)) return output;
	const snapshot = output as Record<string, unknown>;
	const tree = snapshot.accessibilityTree;
	if (!tree || typeof tree !== "object" || !Array.isArray((tree as { nodes?: unknown }).nodes))
		return output;
	if (JSON.stringify(output).length <= MAX_MODEL_BROWSER_SNAPSHOT_CHARACTERS)
		return output;
	const nodes = (tree as { nodes: unknown[] }).nodes;
	const named = nodes.flatMap((value, index) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const node = value as Record<string, unknown>;
		if (node.ignored === true) return [];
		const name = axLabel(node.name).trim();
		const role = axLabel(node.role).trim();
		const ref = typeof node.ref === "string" ? node.ref : undefined;
		if (!name && !ref) return [];
		return [{ index, name, role, ...(ref ? { ref } : {}) }];
	});
	// A code review needs the changed lines, not just the page headings. GitHub's
	// accessibility tree exposes each diff line as a named row; retain those
	// short rows across all files while dropping the redundant grid cells.
	let currentFile = "";
	const diffRows: Array<{ file: string; text: string }> = [];
	for (const item of named) {
		if (item.role.toLowerCase() === "heading" || item.role.toLowerCase() === "link") {
			const file = sourcePathInLabel(item.name);
			if (file) currentFile = file;
		}
		if (item.role.toLowerCase() !== "row") continue;
		if (!/^(?:@@|\d+(?:\s+\d+)?\s+[+-]\s?)/.test(item.name)) continue;
		diffRows.push({ file: currentFile, text: item.name.slice(0, 240) });
	}
	const priority = named.filter(({ name, role }) =>
		role.toLowerCase() === "heading" ||
		["files changed", "commits", "pull request"].some((phrase) =>
			name.toLowerCase().includes(phrase)) ||
		sourcePathInLabel(name) !== undefined,
	);
	const selected = new Map<number, { index: number; role: string; name: string; ref?: string }>();
	let nodeCharacters = 0;
	for (const item of [...priority, ...named.slice(0, 90), ...named.slice(-30)]) {
		if (selected.has(item.index)) continue;
		const compact = { ...item, name: item.name.slice(0, 180) };
		const size = JSON.stringify(compact).length;
		if (nodeCharacters + size > 18_000 || selected.size >= 180) continue;
		selected.set(item.index, compact);
		nodeCharacters += size;
	}
	const compactNodes = [...selected.values()].sort((a, b) => a.index - b.index);
	const interactive = Array.isArray(snapshot.interactive)
		? snapshot.interactive.slice(0, 70)
		: undefined;
	const compacted = {
		...snapshot,
		accessibilityTree: { nodes: compactNodes },
		...(interactive ? { interactive } : {}),
		...(diffRows.length > 0 ? { modelDiffRows: diffRows } : {}),
		truncated: true,
		modelSummary: `Compact page outline: ${compactNodes.length} of ${nodes.length} captured accessibility nodes${diffRows.length ? ` and ${diffRows.length} changed diff rows` : ""}. Use browser.current-context or a smaller page for full text.`,
	};
	while (JSON.stringify(compacted).length > MAX_MODEL_BROWSER_SNAPSHOT_CHARACTERS &&
		compactNodes.length > 0) compactNodes.pop();
	while (JSON.stringify(compacted).length > MAX_MODEL_BROWSER_SNAPSHOT_CHARACTERS &&
		interactive && interactive.length > 0) interactive.pop();
	while (JSON.stringify(compacted).length > MAX_MODEL_BROWSER_SNAPSHOT_CHARACTERS &&
		diffRows.length > 0) diffRows.pop();
	return compacted;
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
	const redactedOutput =
		execution.output === undefined
			? undefined
			: redactValue(execution.output, state);
	const output =
		execution.toolName === "browser.visible-snapshot" ||
		execution.toolName === "browser.snapshot"
			? compactBrowserSnapshotForModel(redactedOutput)
			: redactedOutput;
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
