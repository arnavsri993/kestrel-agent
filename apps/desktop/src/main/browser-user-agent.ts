/** Use the embedded Chromium identity, removing only desktop app products. */
export function embeddedBrowserUserAgent(
	defaultUserAgent: string,
	chromeVersion?: string,
	appName = "Kestrel",
): string {
	const appProducts = new Set(["electron", "kestrel", "kestrel-agent", appName.toLowerCase().replace(/\s/g, "")]);
	let userAgent = defaultUserAgent.split(/\s+/).filter((token) => {
		const separator = token.indexOf("/");
		return separator < 0 || !appProducts.has(token.slice(0, separator).toLowerCase());
	}).join(" ").trim();
	// Never advertise a guessed or newer engine version. Electron supplies this
	// runtime version in production; tests and other hosts can retain the default.
	if (chromeVersion && /^\d+\.\d+\.\d+\.\d+$/.test(chromeVersion))
		userAgent = userAgent.replace(/\bChrome\/\d+(?:\.\d+){0,3}\b/, `Chrome/${chromeVersion}`);
	return userAgent;
}
