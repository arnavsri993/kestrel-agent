type FileIconSize = "small" | "normal" | "large";

export interface FileIconApi<Result = unknown> {
	getFileIcon(
		path: string,
		options?: { size: FileIconSize },
	): Promise<Result>;
}

const guardedApis = new WeakSet<object>();

/**
 * Electron 43 embeds Chromium 150, whose macOS IconLoader traps when Electron
 * passes its LARGE enum to IconLoader::ReadIcon. The result is a native
 * EXC_BREAKPOINT/SIGTRAP on ThreadPoolForegroundWorker, so a JavaScript catch
 * cannot recover it. Chromium's NORMAL path returns the same useful 32 px icon
 * on macOS without entering the unhandled branch.
 *
 * Keep this process-wide guard even when Kestrel has no direct getFileIcon
 * callers. It protects future call sites and bundled dependencies from
 * reintroducing the startup crash.
 */
export function installMacFileIconCrashGuard<Result>(
	iconApi: FileIconApi<Result>,
	platform = process.platform,
): void {
	if (platform !== "darwin" || guardedApis.has(iconApi)) return;

	const getFileIcon = iconApi.getFileIcon.bind(iconApi);
	iconApi.getFileIcon = (path, options) =>
		getFileIcon(
			path,
			options?.size === "large" ? { ...options, size: "normal" } : options,
		);
	guardedApis.add(iconApi);
}
