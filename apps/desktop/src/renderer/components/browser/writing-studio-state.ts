export type WritingProfilePanelPhase = "loading" | "ready" | "unavailable";

export function writingProfilePanelPhase(
	profileLoaded: boolean,
	profileLoading: boolean,
): WritingProfilePanelPhase {
	if (profileLoaded) return "ready";
	if (profileLoading) return "loading";
	return "unavailable";
}
