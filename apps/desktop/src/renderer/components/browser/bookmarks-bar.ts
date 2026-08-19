export const BOOKMARKS_BAR_LABEL_MAX = 28;

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

export function hostnameFromBookmarkUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return "";
	}
}
