const CHROME_WEB_STORE_EXTENSION_ID = /^[a-p]{32}$/i;

function chromeWebStoreDetailSegments(url: URL): string[] | null {
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port
	)
		return null;

	const segments = url.pathname.split("/").filter(Boolean);
	if (
		url.hostname === "chromewebstore.google.com" &&
		segments[0] === "detail"
	)
		return segments.slice(1);
	if (
		url.hostname === "chrome.google.com" &&
		segments[0] === "webstore" &&
		segments[1] === "detail"
	)
		return segments.slice(2);
	return null;
}

/**
 * Returns the signed extension identity from a Chrome Web Store listing URL.
 * The Web Store currently uses either /detail/<id> or /detail/<slug>/<id>.
 */
export function parseChromeWebStoreListingUrl(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	const segments = chromeWebStoreDetailSegments(url);
	if (!segments || (segments.length !== 1 && segments.length !== 2)) return null;
	const candidate = segments.at(-1);
	return candidate && CHROME_WEB_STORE_EXTENSION_ID.test(candidate)
		? candidate.toLowerCase()
		: null;
}

/** Accept either an exact extension ID or an official Chrome Web Store URL. */
export function parseChromeWebStoreExtensionId(input: string): string | null {
	const trimmed = input.trim();
	if (CHROME_WEB_STORE_EXTENSION_ID.test(trimmed)) return trimmed.toLowerCase();
	return parseChromeWebStoreListingUrl(trimmed);
}
