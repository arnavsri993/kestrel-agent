import type { ReleaseChannel } from "@kestrel/shared-types";

export function updaterFeedChannel(channel: ReleaseChannel): "latest" | "beta" | undefined {
  if (channel === "stable") return "latest";
  if (channel === "beta") return "beta";
  return undefined;
}

export function shouldCheckForUpdates(
  packaged: boolean,
  channel: ReleaseChannel,
  updatesDisabled = false,
): boolean {
  return !updatesDisabled && packaged && updaterFeedChannel(channel) !== undefined;
}
