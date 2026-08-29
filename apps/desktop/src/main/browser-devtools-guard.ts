export const BROWSER_DEVTOOLS_PACKAGED_ERROR =
	"Developer tools are disabled in the packaged Kestrel app.";

export function canOpenBrowserDevTools(isPackagedKestrelApp: boolean): boolean {
	return !isPackagedKestrelApp;
}

export function assertBrowserDevToolsAllowed(
	isPackagedKestrelApp: boolean,
): void {
	if (!canOpenBrowserDevTools(isPackagedKestrelApp))
		throw new Error(BROWSER_DEVTOOLS_PACKAGED_ERROR);
}
