import type { UserBrowserOriginFavicon } from "@kestrel/shared-types";

export const BOOKMARKS_BAR_LABEL_MAX = 28;

type BookmarkOriginFavicon = Pick<
	UserBrowserOriginFavicon,
	"origin" | "faviconDataUrl"
>;

export function bookmarkBarLabel(
	title: string,
	url: string,
	max = BOOKMARKS_BAR_LABEL_MAX,
): string {
	const trimmed = title.trim();
	const source =
		trimmed && trimmed !== url
			? trimmed
			: hostnameFromBookmarkUrl(url) || trimmed || url;
	if (source.length <= max) return source;
	return `${source.slice(0, Math.max(1, max - 1))}…`;
}

export function bookmarkBarGlyph(title: string, url: string): string {
	const label = bookmarkBarLabel(title, url, 80);
	const letter = label.match(/[A-Za-z0-9]/);
	return (letter?.[0] ?? "•").toUpperCase();
}

export function bookmarkBarFaviconDataUrl(
	url: string,
	originFavicons: readonly BookmarkOriginFavicon[] = [],
): string | undefined {
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
		return originFavicons.find((item) => item.origin === parsed.origin)
			?.faviconDataUrl;
	} catch {
		return undefined;
	}
}

export function hostnameFromBookmarkUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return "";
	}
}
