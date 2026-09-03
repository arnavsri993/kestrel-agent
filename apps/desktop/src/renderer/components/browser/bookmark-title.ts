function hostnameForBookmark(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return "";
	}
}

function titleCaseHostname(hostname: string): string {
	const label = hostname.split(".")[0] ?? hostname;
	return label
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.trim();
}

function sameAsHostname(value: string, hostname: string): boolean {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.trim();
	const host = hostname
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.trim();
	return Boolean(normalized && host && (normalized === host || host.includes(normalized)));
}

/**
 * Produce a concise, local recommendation from the page title and URL. This
 * deliberately does not claim to call an AI service: it removes common site
 * branding and falls back to the hostname when the page gives us no useful
 * title.
 */
export function recommendedBookmarkTitle(url: string, pageTitle: string): string {
	const hostname = hostnameForBookmark(url);
	const normalized = pageTitle.replace(/\s+/g, " ").trim();
	if (!normalized || normalized === url.trim()) return titleCaseHostname(hostname) || "Saved page";

	const candidates = normalized
		.split(/\s*(?:\||·|—|–)\s*/)
		.map((value) => value.trim())
		.filter(Boolean);
	const unbranded = candidates.find((value) => !sameAsHostname(value, hostname));
	return (unbranded || candidates[0] || normalized).slice(0, 500);
}
