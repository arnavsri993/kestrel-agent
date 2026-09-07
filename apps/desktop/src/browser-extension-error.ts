/**
 * Native extension errors can contain filesystem paths, runtime internals, or
 * package details.  Only return bounded, actionable language across the
 * renderer boundary; detailed causes stay in the main-process logs.
 */
export function chromeWebStoreInstallErrorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "";
	if (
		/^(Open a Chrome Web Store extension listing|The download timed out|The Chrome Web Store could not provide|That extension review expired|This extension needs Chrome features|Kestrel rejected the package|Kestrel could not install this extension)/.test(
			message,
		)
	)
		return message;
	if (/invalid chrome web store url|32-character id/i.test(message))
		return "Open a Chrome Web Store extension listing and try again.";
	if (/timed out|aborterror/i.test(message))
		return "The download timed out. Check your connection and try again.";
	if (/expired|reviewed extension package is no longer available/i.test(message))
		return "That extension review expired. Review the package again before installing it.";
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

export function browserExtensionOperationErrorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "";
	if (/not found/i.test(message))
		return "This extension is no longer installed. Refresh the extensions list and try again.";
	if (/enable this extension/i.test(message))
		return "Enable this extension before reloading it.";
	if (/expired|reviewed extension package is no longer available/i.test(message))
		return "That extension review expired. Review the package again before installing it.";
	return "Kestrel could not update this extension. Try again, or remove and review it again from the Chrome Web Store.";
}
