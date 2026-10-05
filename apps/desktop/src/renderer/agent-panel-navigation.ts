import { agentPanelUsesOverlay } from "./motion-contract";

/** Opening a destination should reveal it; agent tasks retain their chat context. */
export function dismissCompactChatForDestination(
	viewportWidth: number,
	destination: string | undefined,
): boolean {
	return agentPanelUsesOverlay(viewportWidth) && destination !== "agent";
}
