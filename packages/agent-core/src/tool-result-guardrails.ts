import { createHash } from "node:crypto";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { replaceSensitiveText } from "@kestrel/shared-types";
export { replaceSensitiveText } from "@kestrel/shared-types";

interface RedactionState {
	redactions: number;
	tokens: Map<string, string>;
	nextTokenByKind: Map<string, number>;
}

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
