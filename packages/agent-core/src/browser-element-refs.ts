export const ELEMENT_REF_PATTERN = /^e[1-9][0-9]{0,4}$/;

const INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"combobox",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"slider",
	"spinbutton",
	"option",
	"listbox",
	"treeitem",
	"cell",
	"gridcell",
	"row",
	"textfield",
	"textarea",
]);

const CHILD_KEYS = ["nodes", "children", "childNodes"] as const;

export interface BrowserInteractiveRef {
	ref: string;
	role: string;
	name?: string;
	backendDOMNodeId?: number;
}

const SENSITIVE_FIELD_NAME_PATTERNS = [
	/\b(?:new|current|old|confirm(?:ation)?|repeat)?\s*password\b/i,
	/\b(?:one\s*time|recovery|verification|security)\s*(?:code|passcode|pin)\b/i,
	/\botp\b/i,
	/\bone[-_\s]*time[-_\s]*code\b/i,
	/\b(?:cvv|cvc)\b/i,
	/\bcc[-_\s]*csc\b/i,
	/\bcard\s+(?:security|verification)\s+(?:code|number|value)\b/i,
	/\bapi\s*(?:key|token)\b/i,
	/\baccess\s*token\b/i,
	/\bprivate\s*key\b/i,
];

export const REDACTED_SENSITIVE_FIELD_NAME = "Sensitive field";

export interface AnnotatedBrowserTree {
	accessibilityTree: unknown;
	interactive: BrowserInteractiveRef[];
	truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function axText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		return text || undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	if (isRecord(value) && "value" in value) return axText(value.value);
	return undefined;
}

function looksLikeAccessibilityNode(value: Record<string, unknown>): boolean {
	return ["nodeId", "role", "name", "value", "description", "properties"].some(
		(key) => key in value,
	);
}

function sensitiveAccessibilityNodeText(node: Record<string, unknown>): string {
	const parts: unknown[] = [node.role, node.name, node.description];
	if (Array.isArray(node.properties)) {
		for (const property of node.properties) {
			if (!isRecord(property)) continue;
			parts.push(property.name, property.value);
		}
	}
	return parts
		.map(axText)
		.filter((value): value is string => value !== undefined)
		.join(" ");
}

function isSensitiveAccessibilityNode(node: Record<string, unknown>): boolean {
	return SENSITIVE_FIELD_NAME_PATTERNS.some((pattern) =>
		pattern.test(sensitiveAccessibilityNodeText(node)),
	);
}

function redactAccessibilityText(value: unknown, replacement: string): unknown {
	if (isRecord(value) && "value" in value)
		return { ...value, value: replacement };
	return replacement;
}

/**
 * Retains the structural accessibility data agents need while removing every
 * mutable or descriptive value from recognised secret fields before the tree
 * crosses a process, model, or activity boundary.
 */
function redactSensitiveAccessibilityFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSensitiveAccessibilityFields);
	if (!isRecord(value)) return value;
	const sensitive =
		looksLikeAccessibilityNode(value) && isSensitiveAccessibilityNode(value);
	const next: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "nodes" || key === "children" || key === "childNodes") {
			next[key] = redactSensitiveAccessibilityFields(child);
			continue;
		}
		if (sensitive && key === "name") {
			next[key] = redactAccessibilityText(child, REDACTED_SENSITIVE_FIELD_NAME);
			continue;
		}
		if (sensitive && (key === "value" || key === "description")) {
			next[key] = redactAccessibilityText(child, "");
			continue;
		}
		if (sensitive && key === "properties" && Array.isArray(child)) {
			next[key] = child.map((property) => {
				if (!isRecord(property)) return property;
				return "value" in property
					? { ...property, value: redactAccessibilityText(property.value, "") }
					: property;
			});
			continue;
		}
		next[key] = child;
	}
	return next;
}

export function normalizeBrowserElementRef(
	target: string,
): string | undefined {
	const trimmed = target.trim();
	const stripped = trimmed.startsWith("@")
		? trimmed.slice(1)
		: trimmed.startsWith("ref=")
			? trimmed.slice(4)
			: trimmed;
	return ELEMENT_REF_PATTERN.test(stripped) ? stripped : undefined;
}

export function isBrowserElementRef(target: string): boolean {
	return normalizeBrowserElementRef(target) !== undefined;
}

/**
 * Identifies fields whose accessible name says they accept an authentication
 * secret. Keep this deliberately narrow: it protects clear secret prompts
 * without disabling ordinary form entry such as names, email addresses, or
 * search fields.
 */
export function isSensitiveBrowserInteractiveRef(
	ref: Pick<BrowserInteractiveRef, "name">,
): boolean {
	const name = ref.name
		?.normalize("NFKC")
		.replace(/[._-]+/g, " ")
		.trim();
	return (
		name === REDACTED_SENSITIVE_FIELD_NAME ||
		Boolean(name && SENSITIVE_FIELD_NAME_PATTERNS.some((pattern) => pattern.test(name)))
	);
}

export function annotateAccessibilityTree(
	tree: unknown,
	maxInteractive = 200,
): AnnotatedBrowserTree {
	const cap = Number.isFinite(maxInteractive)
		? Math.max(0, Math.trunc(maxInteractive))
		: 200;
	const interactive: BrowserInteractiveRef[] = [];
	let truncated = false;

	const assignRef = (
		node: Record<string, unknown>,
	): Record<string, unknown> => {
		if (node.ignored === true) return node;
		const role = axText(node.role);
		if (!role || !INTERACTIVE_ROLES.has(role.toLowerCase())) return node;
		if (interactive.length >= cap) {
			truncated = true;
			return node;
		}
		const backendDOMNodeId =
			typeof node.backendDOMNodeId === "number" &&
			Number.isInteger(node.backendDOMNodeId) &&
			node.backendDOMNodeId > 0
				? node.backendDOMNodeId
				: undefined;
		if (backendDOMNodeId === undefined) return node;
		const ref = `e${interactive.length + 1}`;
		const name = isSensitiveAccessibilityNode(node)
			? REDACTED_SENSITIVE_FIELD_NAME
			: axText(node.name);
		interactive.push({
			ref,
			role,
			...(name ? { name } : {}),
			backendDOMNodeId,
		});
		return { ...node, ref };
	};

	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (!isRecord(value)) return value;
		let next: Record<string, unknown> = looksLikeAccessibilityNode(value)
			? assignRef(value)
			: value;
		for (const key of CHILD_KEYS) {
			if (!Array.isArray(next[key])) continue;
			const walked = (next[key] as unknown[]).map(walk);
			if (next === value) next = { ...value };
			next[key] = walked;
		}
		return next;
	};

	return {
		accessibilityTree: redactSensitiveAccessibilityFields(walk(tree)),
		interactive,
		truncated,
	};
}
