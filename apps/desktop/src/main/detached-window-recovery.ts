import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type UserBrowserState,
	UserBrowserStateSchema,
	type UserBrowserTab,
} from "@kestrel/shared-types";

const DETACHED_WINDOW_STATE_NAME = /^window-[a-f0-9-]+\.json$/;
const MAX_DETACHED_WINDOW_STATE_BYTES = 5_000_000;
const MAX_RESTORED_DETACHED_WINDOWS = 20;
const MAX_DETACHED_WINDOW_CANDIDATES = 1_000;
// Keep the former twenty-file worst-case read budget while allowing cheap
// invalid or opted-out entries to be skipped independently of the window quota.
const MAX_DETACHED_WINDOW_READ_BYTES = 100_000_000;

export async function restoreDetachedWindowStates(
	directory: string,
	restoreWindow: (
		state: UserBrowserState,
		tab: UserBrowserTab,
		statePath: string,
	) => void,
): Promise<number> {
	const names = await readdir(directory).catch(() => [] as string[]);
	let restored = 0;
	let remainingReadBytes = MAX_DETACHED_WINDOW_READ_BYTES;
	for (const name of names
		.filter((value) => DETACHED_WINDOW_STATE_NAME.test(value))
		.sort()
		.slice(0, MAX_DETACHED_WINDOW_CANDIDATES)) {
		if (restored >= MAX_RESTORED_DETACHED_WINDOWS) break;
		try {
			const statePath = join(directory, name);
			const metadata = await lstat(statePath);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				metadata.size > MAX_DETACHED_WINDOW_STATE_BYTES
			)
				continue;
			if (metadata.size > remainingReadBytes) continue;
			remainingReadBytes -= metadata.size;
			const state = UserBrowserStateSchema.parse(
				JSON.parse(await readFile(statePath, "utf8")),
			);
			if (
				!state.settings.restoreSession ||
				state.settings.startupBehavior !== "restore"
			)
				continue;
			const tab =
				state.tabs.find((item) => item.id === state.activeTabId) ?? state.tabs[0];
			if (!tab) continue;
			restoreWindow(state, tab, statePath);
			restored += 1;
		} catch {
			// Preserve malformed, incompatible, or temporarily unavailable state so a
			// later launch or manual recovery can retry it.
		}
	}
	return restored;
}
