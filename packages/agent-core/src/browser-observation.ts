const MAX_OBSERVATION_NODES = 5_000;
const MAX_OBSERVATION_CHANGES = 100;
const MAX_OBSERVATION_TEXT = 500;
const MAX_OBSERVATION_URL = 2_048;

const OBSERVATION_STATE_NAMES = [
	"checked",
	"disabled",
	"expanded",
	"focused",
	"invalid",
	"pressed",
	"readonly",
	"required",
	"selected",
	"settable",
] as const;

const SENSITIVE_URL_PARAMETER =
	/(?:token|secret|password|passwd|api[_-]?key|auth|credential|session|signature|sig|code)/i;

export interface BrowserObservationSnapshot {
	url: string;
	title: string;
	accessibilityTree: unknown;
}

export interface BrowserObservationNode {
	key: string;
	role: string;
	name?: string;
	value?: string;
	description?: string;
	states?: Record<string, string>;
}

export interface BrowserObservationChange {
	key: string;
	before: BrowserObservationNode;
	after: BrowserObservationNode;
}

export interface BrowserObservationDiff {
	before: { url: string; title: string };
	after: { url: string; title: string };
	added: BrowserObservationNode[];
	removed: BrowserObservationNode[];
	changed: BrowserObservationChange[];
	truncated: boolean;
	trust: "untrusted_browser";
}

interface InternalObservationNode extends BrowserObservationNode {
	fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, maximum = MAX_OBSERVATION_TEXT): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function scalarValue(value: unknown): string | boolean | number | undefined {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (isRecord(value) && "value" in value) return scalarValue(value.value);
	return undefined;
}

function fieldText(node: Record<string, unknown>, name: string): string | undefined {
	const value = scalarValue(node[name]);
	if (value === undefined) return undefined;
	return boundedText(String(value));
}

function stateText(value: unknown): string | undefined {
	const scalar = scalarValue(value);
	return scalar === undefined ? undefined : boundedText(String(scalar), 80);
}

function observationStates(
	node: Record<string, unknown>,
): Record<string, string> | undefined {
	const states = new Map<string, string>();
	const properties = node.properties;
	if (Array.isArray(properties)) {
		for (const property of properties) {
			if (!isRecord(property) || typeof property.name !== "string") continue;
			if (!(OBSERVATION_STATE_NAMES as readonly string[]).includes(property.name))
				continue;
			const value = stateText(property.value);
			if (value !== undefined) states.set(property.name, value);
		}
	}
	for (const name of OBSERVATION_STATE_NAMES) {
		const value = stateText(node[name]);
		if (value !== undefined) states.set(name, value);
	}
	if (!states.size) return undefined;
	return Object.fromEntries(
		[...states.entries()].sort(([left], [right]) => left.localeCompare(right)),
	);
}

function isAccessibilityNode(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	return ["nodeId", "role", "name", "value", "description", "properties"].some(
		(key) => key in value,
	);
}

function collectAccessibilityNodes(tree: unknown): {
	nodes: InternalObservationNode[];
	truncated: boolean;
} {
	const nodes: InternalObservationNode[] = [];
	const usedKeys = new Set<string>();
	const visited = new WeakSet<object>();
	let truncated = false;

	const addNode = (value: Record<string, unknown>, path: string) => {
		if (value.ignored === true) return;
		if (nodes.length >= MAX_OBSERVATION_NODES) {
			truncated = true;
			return;
		}
		const nodeId = scalarValue(value.nodeId);
		const baseKey =
			nodeId !== undefined ? `node:${String(nodeId)}` : `path:${path}`;
		let key = baseKey;
		let duplicate = 1;
		while (usedKeys.has(key)) key = `${baseKey}#${duplicate++}`;
		usedKeys.add(key);
		const role = fieldText(value, "role") || "unknown";
		const name = fieldText(value, "name");
		const nodeValue = fieldText(value, "value");
		const description = fieldText(value, "description");
		const states = observationStates(value);
		const publicNode: BrowserObservationNode = {
			key,
			role,
			...(name ? { name } : {}),
			...(nodeValue ? { value: nodeValue } : {}),
			...(description ? { description } : {}),
			...(states ? { states } : {}),
		};
		nodes.push({
			...publicNode,
			fingerprint: JSON.stringify({
				role,
				name: name ?? "",
				value: nodeValue ?? "",
				description: description ?? "",
				states: states ?? {},
			}),
		});
	};

	const visit = (value: unknown, path: string): void => {
		if (nodes.length >= MAX_OBSERVATION_NODES) {
			truncated = true;
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${path}.${index}`));
			return;
		}
		if (!isRecord(value)) return;
		if (visited.has(value)) return;
		visited.add(value);
		if (isAccessibilityNode(value)) addNode(value, path);
		for (const childKey of ["nodes", "children", "childNodes"]) {
			if (childKey in value) visit(value[childKey], `${path}.${childKey}`);
		}
	};

	visit(tree, "root");
	return { nodes, truncated };
}

function publicNode(node: InternalObservationNode): BrowserObservationNode {
	const { fingerprint: _fingerprint, ...value } = node;
	return value;
}

function observationUrl(value: string): string {
	const candidate = boundedText(value, MAX_OBSERVATION_URL);
	try {
		const url = new URL(candidate);
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_URL_PARAMETER.test(key)) url.searchParams.delete(key);
		}
		return url.toString().slice(0, MAX_OBSERVATION_URL);
	} catch {
		return candidate
			.replace(/#.*$/, "")
			.replace(/\/\/[^/?#]*@/, "//")
			.replace(/[^\s/?#]+:[^\s/?#]*@/g, "")
			.replace(
				/[?&](?:access_?token|api_?key|auth(?:entication|orization)?(?:_?token|_?code)?|code|credential|jwt|password|refresh_?token|secret|session(?:_?id|_?token)?|sig(?:nature)?|ticket|token)=[^&]*/gi,
				"",
			);
	}
}

function observationTitle(value: string): string {
	return boundedText(value, MAX_OBSERVATION_TEXT);
}

/**
 * Build a compact, untrusted semantic delta between two browser snapshots.
 * Raw accessibility trees never cross this boundary.
 */
export function diffBrowserSnapshots(
	before: BrowserObservationSnapshot,
	after: BrowserObservationSnapshot,
): BrowserObservationDiff {
	const beforeTree = collectAccessibilityNodes(before.accessibilityTree);
	const afterTree = collectAccessibilityNodes(after.accessibilityTree);
	const beforeByKey = new Map(beforeTree.nodes.map((node) => [node.key, node]));
	const afterByKey = new Map(afterTree.nodes.map((node) => [node.key, node]));
	const added = afterTree.nodes
		.filter((node) => !beforeByKey.has(node.key))
		.map(publicNode);
	const removed = beforeTree.nodes
		.filter((node) => !afterByKey.has(node.key))
		.map(publicNode);
	const changed = afterTree.nodes
		.filter((node) => {
			const previous = beforeByKey.get(node.key);
			return previous !== undefined && previous.fingerprint !== node.fingerprint;
		})
		.map((node) => ({
			key: node.key,
			before: publicNode(beforeByKey.get(node.key)!),
			after: publicNode(node),
		}));

	return {
		before: {
			url: observationUrl(before.url),
			title: observationTitle(before.title),
		},
		after: {
			url: observationUrl(after.url),
			title: observationTitle(after.title),
		},
		added: added.slice(0, MAX_OBSERVATION_CHANGES),
		removed: removed.slice(0, MAX_OBSERVATION_CHANGES),
		changed: changed.slice(0, MAX_OBSERVATION_CHANGES),
		truncated:
			beforeTree.truncated ||
			afterTree.truncated ||
			added.length > MAX_OBSERVATION_CHANGES ||
			removed.length > MAX_OBSERVATION_CHANGES ||
			changed.length > MAX_OBSERVATION_CHANGES,
		trust: "untrusted_browser",
	};
}
