export { chromeWebStoreInstallErrorMessage } from "../../../browser-extension-error";

import {
	parseChromeWebStoreListingUrl,
	type NativeBrowserStatus,
	type RendererBridge,
} from "@kestrel/shared-types";

export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/";

/** Open Chromium's own Store flow; never download or sideload a package here. */
export async function openNativeChromeWebStore(
	request: RendererBridge["request"],
	listingUrl?: string,
): Promise<NativeBrowserStatus> {
	const extensionId = listingUrl ? parseChromeWebStoreListingUrl(listingUrl) : null;
	if (listingUrl && !extensionId)
		throw new Error("Open an official Chrome Web Store extension listing and try again.");
	const response = await request({
		type: "browser-open-native",
		input: extensionId ? `${CHROME_WEB_STORE_URL}detail/${extensionId}` : CHROME_WEB_STORE_URL,
	});
	if (!response.ok || !("nativeBrowser" in response) ||
		!response.nativeBrowser.available || !response.nativeBrowser.running || response.nativeBrowser.error)
		throw new Error("The native Chrome Web Store could not open. Check native browser availability in Extensions and try again.");
	return response.nativeBrowser;
}
