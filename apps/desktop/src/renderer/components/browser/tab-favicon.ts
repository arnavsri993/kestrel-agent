import type {
	UserBrowserOriginFavicon,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { isKestrelAppPageUrl } from "../../../utility/browser-app-pages";

type TabFaviconInput = Pick<UserBrowserTab, "url" | "faviconDataUrl">;
type OriginFaviconInput = Pick<
	UserBrowserOriginFavicon,
	"origin" | "faviconDataUrl"
>;

function httpOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol)
			? url.origin
			: undefined;
	} catch {
		return undefined;
	}
}

/** Kestrel-owned surfaces: app pages, new tab, and other internal routes. */
export function isKestrelInternalTabUrl(url: string | undefined): boolean {
	if (!url || url === "about:blank") return true;
	return isKestrelAppPageUrl(url);
}

/**
 * Sleeping and restored tabs intentionally do not persist a duplicate
 * per-tab image. Use the durable origin cache when that live value is gone.
 */
export function tabFaviconDataUrl(
	tab: TabFaviconInput,
	originFavicons: readonly OriginFaviconInput[] = [],
): string | undefined {
	if (tab.faviconDataUrl) return tab.faviconDataUrl;
	const origin = httpOrigin(tab.url);
	return originFavicons.find((item) => item.origin === origin)?.faviconDataUrl;
}
