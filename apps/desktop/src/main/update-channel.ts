import type { ReleaseChannel } from "@kestrel/shared-types";

export interface DownloadedUpdateInfo {
	version: string;
}

export interface AutomaticUpdater {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	allowPrerelease: boolean;
	channel: string | null;
	checkForUpdates(): Promise<unknown>;
}

export function updaterFeedChannel(
	channel: ReleaseChannel,
): "latest" | "beta" | undefined {
	if (channel === "stable") return "latest";
	if (channel === "beta") return "beta";
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

/**
 * Start a non-blocking, signed release check for a packaged app.
 *
 * Beta builds use GitHub's prerelease-aware provider and stable builds use the
 * latest channel. The check is intentionally started immediately after
 * Electron is ready rather than scanning the source repository or the user's
 * filesystem. electron-updater verifies the signed update artifact before it
 * is installed on quit.
 */
export function startAutomaticUpdates(
	updater: AutomaticUpdater,
	options: {
		packaged: boolean;
		channel: ReleaseChannel;
		updatesDisabled?: boolean;
		subscribeToUpdate?: (
			listener: (info: DownloadedUpdateInfo) => void,
		) => void;
		onUpdateDownloaded?: (info: DownloadedUpdateInfo) => void;
	},
): boolean {
	const feedChannel = updaterFeedChannel(options.channel);
	if (
		!shouldCheckForUpdates(
			options.packaged,
			options.channel,
			options.updatesDisabled,
		) || !feedChannel
	)
		return false;

	updater.autoDownload = true;
	updater.autoInstallOnAppQuit = true;
	updater.allowPrerelease = options.channel === "beta";
	updater.channel = feedChannel;
	if (options.onUpdateDownloaded && options.subscribeToUpdate)
		options.subscribeToUpdate(options.onUpdateDownloaded);

	// A network failure must never prevent the app from opening. Wrapping the
	// call also handles an unexpected synchronous throw from a test/runtime
	// adapter while keeping the launch path non-blocking.
	void Promise.resolve()
		.then(() => updater.checkForUpdates())
		.catch(() => undefined);
	return true;
}
