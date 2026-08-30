import type { ReleaseChannel } from "@kestrel/shared-types";

export const GITHUB_RELEASE_OWNER = "arnavsri993";
export const GITHUB_RELEASE_REPOSITORY = "kestrel-agent";

export function updaterFeedChannel(
	channel: ReleaseChannel,
): "latest" | undefined {
	if (channel === "stable") return "latest";
	return undefined;
}

export interface GithubUpdateFeed {
	provider: "github";
	owner: string;
	repo: string;
	releaseType: "release";
	channel: "latest";
}

export function githubUpdateFeed(): GithubUpdateFeed {
	return {
		provider: "github",
		owner: GITHUB_RELEASE_OWNER,
		repo: GITHUB_RELEASE_REPOSITORY,
		releaseType: "release",
		channel: "latest",
	};
}

export interface DownloadedUpdateInfo {
	version: string;
}

export interface AutomaticUpdater {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	allowPrerelease: boolean;
	channel: string | null;
	setFeedURL(options: GithubUpdateFeed): void;
	checkForUpdates(): Promise<unknown>;
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
 * Start a non-blocking update check against the public GitHub release feed.
 *
 * A packaged stable app downloads the signed ZIP in the background and lets
 * electron-updater install it on the next normal quit. Development builds and
 * explicit smoke-test launches never contact the release provider.
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
		onCheckFailure?: (error: unknown) => void;
	},
): boolean {
	const feedChannel = updaterFeedChannel(options.channel);
	const reportFailure = (error: unknown) => {
		// The diagnostics hook receives the original error so it can retain only
		// its safe classification. It must never make updater startup fatal.
		try {
			options.onCheckFailure?.(error);
		} catch {
			// Observability is best-effort and cannot block app startup.
		}
	};
	if (
		!shouldCheckForUpdates(
			options.packaged,
			options.channel,
			options.updatesDisabled,
		) ||
		!feedChannel
	)
		return false;

	try {
		// Keep the repository and release policy in code as well as in the
		// packaged app-update.yml. This prevents a stale build variable or
		// generic feed from silently redirecting updates somewhere else.
		updater.setFeedURL(githubUpdateFeed());
		updater.autoDownload = true;
		updater.autoInstallOnAppQuit = true;
		updater.allowPrerelease = false;
		updater.channel = feedChannel;
		if (options.onUpdateDownloaded && options.subscribeToUpdate)
			options.subscribeToUpdate(options.onUpdateDownloaded);
	} catch (error) {
		// An updater configuration failure must never prevent the app from
		// opening, but it must remain visible in content-free diagnostics.
		reportFailure(error);
		return false;
	}

	// A network failure must never prevent the app from opening. Wrapping the
	// call also handles an unexpected synchronous throw from a test/runtime
	// adapter while keeping the launch path non-blocking.
	void Promise.resolve()
		.then(() => updater.checkForUpdates())
		.catch(reportFailure);
	return true;
}
