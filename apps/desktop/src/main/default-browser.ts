/**
 * The Electron binary used by `electron-vite dev` is still named Electron on
 * macOS. Never let that development shell claim Kestrel's external handlers.
 */
export function canRegisterAsDefaultBrowser(isPackaged: boolean): boolean {
	return isPackaged;
}
