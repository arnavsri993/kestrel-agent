import type { ReleaseChannel } from "@kestrel/shared-types";

export function updaterFeedChannel(
	channel: ReleaseChannel,
): "latest" | undefined {
	if (channel === "stable") return "latest";
	return undefined;
}

export function shouldCheckForUpdates(
	packaged: boolean,
	channel: ReleaseChannel,
	updatesDisabled = false,
): boolean {
	return (
		!updatesDisabled && packaged && updaterFeedChannel(channel) !== undefined
	);
}
