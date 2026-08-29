import type {
	UserBrowserOriginFavicon,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { isKestrelInternalTabUrl, tabFaviconDataUrl } from "./tab-favicon";

type TabFaviconInput = Pick<
	UserBrowserTab,
	"url" | "faviconDataUrl" | "loading" | "file"
>;

type OriginFaviconInput = Pick<
	UserBrowserOriginFavicon,
	"origin" | "faviconDataUrl"
>;

export function TabFavicon({
	tab,
	originFavicons = [],
}: {
	tab: TabFaviconInput;
	originFavicons?: readonly OriginFaviconInput[];
}) {
	if (tab.file) return <Icon name="artifacts" />;
	if (isKestrelInternalTabUrl(tab.url)) {
		return <BrandMark className="browser-tab-brand-mark" />;
	}
	const faviconDataUrl = tabFaviconDataUrl(tab, originFavicons);
	if (faviconDataUrl) return <img src={faviconDataUrl} alt="" />;
	if (tab.loading) return <span className="browser-tab-spinner" />;
	if (!tab.url) return <Icon name="globe" />;
	try {
		const host = new URL(tab.url).hostname.replace(/^www\./, "");
		return (
			<span className="browser-favicon-letter">
				{host.charAt(0).toUpperCase()}
			</span>
		);
	} catch {
		return <Icon name="globe" />;
	}
}

export function recentTabFavicon(url: string) {
	if (isKestrelInternalTabUrl(url)) {
		return <BrandMark className="browser-tab-brand-mark" />;
	}
	try {
		const host = new URL(url).hostname.replace(/^www\./, "");
		return (
			<span className="browser-favicon-letter">
				{host.charAt(0).toUpperCase()}
			</span>
		);
	} catch {
		return <Icon name="history" />;
	}
}
