import { createHmac, randomBytes } from "node:crypto";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import {
	isOpaqueSensitiveReference,
	isSensitiveMetadataKey,
	MAX_KNOWN_SENSITIVE_CHARACTERS,
	MAX_KNOWN_SENSITIVE_VALUES,
	replaceSensitiveText,
	sensitiveKeyKind,
	SensitiveTextLimitError,
} from "@kestrel/shared-types";
export { replaceSensitiveText } from "@kestrel/shared-types";

interface RedactionState {
	redactions: number;
	fingerprintKey: Buffer;
	tokens: Map<string, string>;
	nextTokenByKind: Map<string, number>;
	knownValues: Map<string, string>;
	explicitValues: Set<string>;
	knownCharacters: number;
	visitedValues: number;
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
		fingerprintKey: randomBytes(32),
		tokens: new Map(),
		nextTokenByKind: new Map(),
		knownValues: new Map(),
		explicitValues: new Set(),
		knownCharacters: 0,
		visitedValues: 0,
	};
}

function withRedactionState<T>(operation: (state: RedactionState) => T): T {
	const state = createRedactionState();
	try {
		return operation(state);
	} finally {
		state.fingerprintKey.fill(0);
		state.tokens.clear();
		state.nextTokenByKind.clear();
		state.knownValues.clear();
		state.explicitValues.clear();
		// Release references; JavaScript strings do not support zeroization.
	}
}

function tokenFor(kind: string, value: string, state: RedactionState): string {
	kind = state.knownValues.get(value) ?? kind;
	// This only deduplicates placeholders within one redaction operation. A
	// private ephemeral key keeps low-entropy secrets out of a reusable digest.
	const fingerprint = createHmac("sha256", state.fingerprintKey)
		.update(value)
		.digest("hex");
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

const MAX_REDACTION_DEPTH = 128;
const MAX_REDACTION_VALUES = 100_000;

/** Visit validated JSON scalar spans without changing its formatting or type. */
function transformJsonText(
	value: string,
	transform: (value: string | number, kind?: string, numericMetadata?: boolean) => unknown,
): string | undefined {
	if (!/^[\s]*[\[{]/.test(value)) return undefined;
	try { JSON.parse(value); } catch { return undefined; }
	let index = 0;
	const parts: string[] = [];
	let copiedThrough = 0;
	const whitespace = () => {
		while (/[\t\n\r ]/.test(value[index] ?? "")) index += 1;
	};
	const stringToken = (): string => {
		const start = index++;
		while (index < value.length) {
			const character = value[index++];
			if (character === "\\") index += 1;
			else if (character === '"') break;
		}
		return JSON.parse(value.slice(start, index)) as string;
	};
	const visit = (kind: string | undefined, depth: number, numericMetadata = false) => {
		if (depth > MAX_REDACTION_DEPTH) throw new SensitiveTextLimitError();
		whitespace();
		if (value[index] === "{") {
			index += 1;
			whitespace();
			while (value[index] !== "}") {
				const key = stringToken();
				whitespace();
				index += 1; // Validated colon.
				const childKind = sensitiveKeyKind(key, kind);
				visit(childKind, depth + 1, !childKind && (numericMetadata || isSensitiveMetadataKey(key)));
				whitespace();
				if (value[index] !== ",") break;
				index += 1;
				whitespace();
			}
			index += 1;
			return;
		}
		if (value[index] === "[") {
			index += 1;
			whitespace();
			while (value[index] !== "]") {
				visit(kind, depth + 1, numericMetadata);
				whitespace();
				if (value[index] !== ",") break;
				index += 1;
			}
			index += 1;
			return;
		}
		const start = index;
		let scalar: unknown;
		if (value[index] === '"') scalar = stringToken();
		else {
			while (index < value.length && !/[\t\n\r ,}\]]/.test(value[index]!)) index += 1;
			scalar = JSON.parse(value.slice(start, index));
		}
		if (typeof scalar !== "string" && typeof scalar !== "number") return;
		const replacement = transform(scalar, kind, numericMetadata);
		if (replacement !== scalar) {
			parts.push(value.slice(copiedThrough, start), JSON.stringify(replacement));
			copiedThrough = index;
		}
	};
	visit(undefined, 0);
	parts.push(value.slice(copiedThrough));
	return parts.join("");
}

function rememberSecret(value: string, kind: string, state: RedactionState, explicit: boolean): void {
	if (!value || isOpaqueSensitiveReference(value)) return;
	if (!state.knownValues.has(value)) {
		state.knownCharacters += value.length;
		if (state.knownValues.size >= MAX_KNOWN_SENSITIVE_VALUES || state.knownCharacters > MAX_KNOWN_SENSITIVE_CHARACTERS)
			throw new SensitiveTextLimitError();
		state.knownValues.set(value, kind);
	} else if (explicit && !state.explicitValues.has(value)) state.knownValues.set(value, kind);
	if (explicit) state.explicitValues.add(value);
}

/** Discovery has no token/count side effects, including echoes before labels. */
function discoverSecrets(
	value: unknown,
	state: RedactionState,
	kind?: string,
	depth = 0,
	ancestors = new WeakSet<object>(),
): void {
	if (++state.visitedValues > MAX_REDACTION_VALUES || depth > MAX_REDACTION_DEPTH)
		throw new SensitiveTextLimitError();
	if (typeof value === "string") {
		if (kind) rememberSecret(value, kind, state, true);
		else if (transformJsonText(value, (scalar, scalarKind) => {
			discoverSecrets(scalar, state, scalarKind, depth + 1, ancestors);
			return scalar;
		}) === undefined) {
			replaceSensitiveText(value, (textKind, secret) => {
				rememberSecret(secret, textKind, state, false);
				return "[REDACTED]";
			});
		}
		return;
	}
	if (typeof value === "number") {
		if (kind) rememberSecret(String(value), kind, state, true);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (ancestors.has(value)) throw new SensitiveTextLimitError();
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (const child of value) discoverSecrets(child, state, kind, depth + 1, ancestors);
		} else {
			for (const [key, child] of Object.entries(value))
				discoverSecrets(child, state, sensitiveKeyKind(key, kind), depth + 1, ancestors);
		}
	} finally { ancestors.delete(value); }
}

function redactText(value: string, state: RedactionState, redactKnownText?: (text: string) => string): string {
	return transformJsonText(value, (scalar, kind, numericMetadata) => redactValue(scalar, state, kind, redactKnownText, numericMetadata)) ??
		replaceSensitiveText(value, (kind, secret) => tokenFor(kind, secret, state), { knownValues: state.knownValues });
}

/** Redact a previously persisted tool-message payload before replaying it. */
export function redactSensitiveContent(value: string): string {
	return withRedactionState(state => {
		discoverSecrets(value, state);
		return redactText(value, state);
	});
}

function redactValue(
	value: unknown,
	state: RedactionState,
	kind?: string,
	redactKnownText: (text: string) => string = text => text,
	numericMetadata = false,
): unknown {
	if (typeof value === "string")
		return kind && !isOpaqueSensitiveReference(value) && value.length > 0
			? tokenFor(kind, value, state)
			: redactKnownText(redactText(value, state, redactKnownText));
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		const text = String(value);
		if (kind || (!numericMetadata && state.knownValues.has(text)))
			return tokenFor(kind ?? state.knownValues.get(text)!, text, state);
		const knownRedacted = numericMetadata ? text : redactKnownText(text);
		return knownRedacted === text ? value : knownRedacted;
	}
	if (Array.isArray(value)) return value.map((item) => redactValue(item, state, kind, redactKnownText, numericMetadata));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, childValue]) => {
				const childKind = sensitiveKeyKind(childKey, kind);
				return [childKey, redactValue(childValue, state, childKind, redactKnownText,
					!childKind && (numericMetadata || isSensitiveMetadataKey(childKey)))];
			}),
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
	return withRedactionState(state => {
		discoverSecrets(value, state);
		return redactValue(value, state, undefined, redactKnownText);
	});
}

/**
 * Format a tool result for conversation history and model context.
 *
 * This is independent defense at the provider boundary. Runtime journals use
 * redactSensitiveValue too; encryption alone is not permission to retain keys.
 */
export function modelVisibleToolResult(execution: RuntimeToolExecution): string {
	return withRedactionState(state => {
		discoverSecrets(execution.output, state);
		discoverSecrets(execution.error, state);
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
	});
}
