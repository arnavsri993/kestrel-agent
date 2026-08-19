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
		const ref = `e${interactive.length + 1}`;
		const name = axText(node.name);
		const backendDOMNodeId =
			typeof node.backendDOMNodeId === "number" &&
			Number.isInteger(node.backendDOMNodeId) &&
			node.backendDOMNodeId > 0
				? node.backendDOMNodeId
				: undefined;
		interactive.push({
			ref,
			role,
			...(name ? { name } : {}),
			...(backendDOMNodeId !== undefined ? { backendDOMNodeId } : {}),
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
		accessibilityTree: walk(tree),
		interactive,
		truncated,
	};
}
