import type { ModelMessage } from "./providers/types";

const SNAPSHOT_TOOLS = new Set(["browser.visible-snapshot", "browser.snapshot"]);
const MAX_PROJECTED_CHARACTERS = 32_000;

function label(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "value" in value && typeof value.value === "string") return value.value;
	return undefined;
}

/** Local-model presentation only. The recorded receipt and its verification stay intact. */
export function localBrowserContext(message: ModelMessage): ModelMessage {
	if (message.role !== "tool" || !SNAPSHOT_TOOLS.has(message.toolName ?? "")) return message;
	return {
		...message,
		content: message.content.map(part => {
			if (part.type !== "text") return part;
			try {
				const receipt = JSON.parse(part.text);
				const output = receipt?.output;
				const tree = output?.accessibilityTree;
				if (receipt?.status !== "verified" || !Array.isArray(tree?.nodes)) return part;
				const pageText = new Set<string>();
				const nodes = tree.nodes.flatMap((node: unknown) => {
					if (!node || typeof node !== "object" || Array.isArray(node)) return [];
					const item = node as Record<string, unknown>;
					if (item.ignored === true) return [];
					const role = label(item.role);
					const name = label(item.name);
					if (name) pageText.add(name);
					const value = label(item.value);
					const description = label(item.description);
					const states = Array.isArray(item.properties) ? Object.fromEntries(item.properties.flatMap(property => {
						if (!property || typeof property !== "object" || typeof property.name !== "string") return [];
						const value = property.value?.value;
						return ["string", "boolean", "number"].includes(typeof value) ? [[property.name, value]] : [];
					})) : item.states;
					const { chromeRole: _chromeRole, backendDOMNodeId: _backendId, ignoredReasons: _reasons,
						properties: _properties, ...semantic } = item;
					return [{ ...semantic,
						...(role ? { role } : {}), ...(name !== undefined ? { name } : {}),
						...(value !== undefined ? { value } : {}), ...(description !== undefined ? { description } : {}),
						...(states && Object.keys(states).length ? { states } : {}),
					}];
				});
				const text = JSON.stringify({ ...receipt, output: {
					...output, accessibilityTree: { ...tree, nodes }, pageText: [...pageText],
				} });
				// Never silently clip an exact observed value. Keep the existing bounded
				// receipt when this projection would be larger or need truncation.
				return text.length <= Math.min(MAX_PROJECTED_CHARACTERS, part.text.length)
					? { ...part, text } : part;
			} catch { return part; }
		}),
	};
}
