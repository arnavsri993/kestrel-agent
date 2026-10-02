import { contentText, type ModelMessage, type ModelTool } from "./providers/types";

const INITIAL_LOCAL_TOOLS = new Set([
	"tools.search", "tools.activate", "browser.open-tab", "browser.tabs",
	"browser.visible-snapshot", "browser.current-context", "workspace.list",
	"workspace.read", "workspace.search", "agent.config.inspect",
]);
const SEARCH_TOOL_BATCH = 8;

export const LOCAL_TOOL_DISCOVERY_INSTRUCTIONS =
	"Kestrel keeps the local model's initial tool catalog small. For an absent capability, call tools.search with a focused query or exact tool name. Up to eight matching authorized tool definitions become available on the next turn. Discovery does not grant access or approve actions. For a requested fresh URL, open it with browser.open-tab and read the returned tabId with browser.visible-snapshot. Use browser.tabs only when the task requires existing tabs; internal Kestrel pages are not web-page observations. Use the returned definitions and Kestrel's normal approval controls; never invent a tool result.";

/** Presentation only: every returned definition must already be inside the run's ceiling. */
export function localToolCatalog(tools: ModelTool[], messages: ModelMessage[]): ModelTool[] | undefined {
	if (tools.length <= 24 || !tools.some(tool => tool.name === "tools.search")) return undefined;
	const authorized = new Set(tools.map(tool => tool.name));
	const visible = new Set(INITIAL_LOCAL_TOOLS);
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) visible.add(call.name);
		if (message.role !== "tool") continue;
		if (message.toolName) visible.add(message.toolName);
		if (message.toolName !== "tools.search") continue;
		try {
			const result = JSON.parse(contentText(message.content));
			if (result?.status !== "verified" || !Array.isArray(result.output?.active)) continue;
			let added = 0;
			for (const descriptor of result.output.active) {
				const name = descriptor?.name;
				if (typeof name !== "string" || !authorized.has(name) || visible.has(name)) continue;
				visible.add(name);
				if (++added === SEARCH_TOOL_BATCH) break;
			}
		} catch { /* Failed or malformed discovery cannot expand the catalog. */ }
	}
	return tools.filter(tool => visible.has(tool.name));
}
