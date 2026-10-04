export type AgentWorkspaceView = "list" | "map";

export const AGENT_WORKSPACE_VIEW_STORAGE_KEY = "kestrel:agent-workspace-view";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function readAgentWorkspaceView(
	storage: ReadableStorage | null | undefined =
		typeof window === "undefined" ? undefined : window.localStorage,
): AgentWorkspaceView {
	try {
		return storage?.getItem(AGENT_WORKSPACE_VIEW_STORAGE_KEY) === "map"
			? "map"
			: "list";
	} catch {
		return "list";
	}
}

export function writeAgentWorkspaceView(
	view: AgentWorkspaceView,
	storage: WritableStorage | null | undefined =
		typeof window === "undefined" ? undefined : window.localStorage,
): void {
	try {
		storage?.setItem(AGENT_WORKSPACE_VIEW_STORAGE_KEY, view);
	} catch {
		// A blocked storage area should never make the workspace unusable.
	}
}
