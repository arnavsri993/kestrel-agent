/**
 * The development launcher uses a Kestrel-branded Electron wrapper on macOS.
 * Keep that shell in development mode so it never claims Kestrel's external
 * handlers.
 */
export function isPackagedKestrelRuntime(
	isPackaged: boolean,
	electronViteEnvironment = process.env.NODE_ENV_ELECTRON_VITE,
): boolean {
	return isPackaged && electronViteEnvironment !== "development";
}

export function canRegisterAsDefaultBrowser(isPackaged: boolean): boolean {
	return isPackaged;
}
