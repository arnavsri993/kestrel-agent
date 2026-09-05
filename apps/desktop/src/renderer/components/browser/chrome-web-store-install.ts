export function chromeWebStoreInstallErrorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "";
	if (/invalid chrome web store url|32-character id/i.test(message))
		return "Open a Chrome Web Store extension listing and try again.";
	if (/timed out|aborterror/i.test(message))
		return "The download timed out. Check your connection and try again.";
	if (/http \d+/i.test(message))
		return "The Chrome Web Store could not provide this extension right now. Try again later.";
	if (/service worker|does not support|unsupported chrome api/i.test(message))
		return "This extension needs Chrome features that Kestrel does not support yet.";
	if (/verifiable crx3|signature|signed identity|identity did not match/i.test(message))
		return "Kestrel rejected the package because its Chrome Web Store signature could not be verified.";
	if (
		/safety limit|exceeds the|too many files|larger than|expands beyond|path traversal|escaped its destination/i.test(
			message,
		)
	)
		return "Kestrel rejected the package because it did not pass extension safety checks.";
	return "Kestrel could not install this extension. It may rely on Chrome features that are unavailable here.";
}
