export const OPEN_PANELS_KEY = "kestrel.native.openPanels.v1";

// Chromium owns visibility. Share its events with existing UI documents so a
// Kestrel tab never mounts a second conversation beside the native companion.
export function trackNativePanels(chromeApi) {
	let updates = Promise.resolve();
	function changed(info, open) {
		if (!Number.isSafeInteger(info?.windowId) || info.windowId < 0) return;
		updates = updates.catch(() => {}).then(async () => {
			const stored = await chromeApi.storage.session.get(OPEN_PANELS_KEY);
			const windows = { ...stored[OPEN_PANELS_KEY] };
			if (open) windows[info.windowId] = true;
			else delete windows[info.windowId];
			await chromeApi.storage.session.set({ [OPEN_PANELS_KEY]: windows });
		});
		// A storage failure must not produce an unhandled worker rejection.
		void updates.catch(() => {});
	}
	chromeApi.sidePanel.onOpened.addListener((info) => changed(info, true));
	chromeApi.sidePanel.onClosed.addListener((info) => changed(info, false));
	chromeApi.windows.onRemoved.addListener((windowId) => changed({ windowId }, false));
	return { settled: () => updates };
}
