import type {
	UserBrowserBookmarkDisplayMode,
	UserBrowserOriginFavicon,
} from "@kestrel/shared-types";

export const BOOKMARKS_BAR_LABEL_MAX = 28;
export const BOOKMARKS_BAR_URL_MAX = 42;

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

export function bookmarkBarUrlLabel(
	url: string,
	max = BOOKMARKS_BAR_URL_MAX,
): string {
	const source = url.trim();
	if (source.length <= max) return source;
	return `${source.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * A missing mode means the bookmark predates presentation choices. Keep those
 * records looking like the original Kestrel bookmark bar until the person
 * edits them, while new saves always write an explicit mode.
 */
export function bookmarkBarDisplayLabel(
	title: string,
	url: string,
	displayMode?: UserBrowserBookmarkDisplayMode,
): string {
	if (displayMode === "icon") return "";
	if (displayMode === "full") return bookmarkBarUrlLabel(url);
	return bookmarkBarLabel(title, url);
}

export function bookmarkDisplayModeLabel(
	displayMode?: UserBrowserBookmarkDisplayMode,
): string {
	if (displayMode === "icon") return "Icon only";
	if (displayMode === "full") return "Full link";
	return "Suggested title";
}

export function bookmarkBarFaviconDataUrl(
	url: string,
	originFavicons: readonly BookmarkOriginFavicon[] = [],
	bookmarkFaviconDataUrl?: string,
): string | undefined {
	if (bookmarkFaviconDataUrl?.startsWith("data:image/"))
		return bookmarkFaviconDataUrl;
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
