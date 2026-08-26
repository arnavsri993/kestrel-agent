import type {
	UserBrowserBookmark,
	UserBrowserHistoryEntry,
	UserBrowserOriginFavicon,
	UserBrowserTab,
} from "@kestrel/shared-types";

export type AddressBarSuggestionKind =
	| "search"
	| "history"
	| "bookmark"
	| "tab"
	| "url";

export type AddressBarSuggestionFilter =
	| "all"
	| "history"
	| "bookmarks"
	| "tabs";

export interface AddressBarSuggestion {
	id: string;
	kind: AddressBarSuggestionKind;
	title: string;
	detail: string;
	value: string;
	url?: string;
	tabId?: string;
	faviconDataUrl?: string;
	/** Used for deterministic ordering and for choosing inline completion. */
	score: number;
}

export interface AddressBarSuggestionInput {
	query?: string;
	history: readonly UserBrowserHistoryEntry[];
	bookmarks: readonly UserBrowserBookmark[];
	tabs: readonly UserBrowserTab[];
	activeTabId?: string | null;
	originFavicons?: readonly UserBrowserOriginFavicon[];
	searchEngineName?: string;
	filter?: AddressBarSuggestionFilter;
	now?: Date;
}

export interface InlineAddressCompletion {
	value: string;
	suggestion: AddressBarSuggestion;
}

const MAX_SUGGESTIONS = 8;
const MAX_LABEL_LENGTH = 180;
const MAX_QUERY_LENGTH = 500;

const SOURCE_PRIORITY: Record<Exclude<AddressBarSuggestionKind, "search" | "url">, number> = {
	tab: 112,
	bookmark: 82,
	history: 0,
};

const ADDRESS_PREFIX = /^(?:[a-z][a-z\d+.-]*:\/\/|[^\s/]+[./]|\/)/i;
const HTTP_ADDRESS = /^https?:\/\//i;
const LOOPBACK_ADDRESS =
	/^(?:localhost|127(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]|$)/i;
const HOST_LIKE_ADDRESS =
	/^(?:[a-z\d](?:[a-z\d-]{0,62}[a-z\d])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]|$)/i;
const IPV4_ADDRESS =
	/^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)/i;

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function cleanLabel(value: unknown, fallback: string): string {
	const cleaned = String(value ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_LABEL_LENGTH);
	return cleaned || fallback;
}

function safeSuggestionUrl(value: string): string | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (!["http:", "https:", "kestrel:"].includes(url.protocol))
			return undefined;
		if (url.username || url.password) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function canonicalUrl(value: string): string | undefined {
	const safe = safeSuggestionUrl(value);
	if (!safe) return undefined;
	try {
		const url = new URL(safe);
		if (url.protocol === "kestrel:") return url.toString();
		return `${url.origin}${url.pathname}${url.search}`;
	} catch {
		return undefined;
	}
}

export function displayAddress(value: string): string {
	const safe = safeSuggestionUrl(value);
	if (!safe) return cleanLabel(value, value).slice(0, MAX_LABEL_LENGTH);
	try {
		const url = new URL(safe);
		if (url.protocol === "kestrel:") return cleanLabel(safe, safe);
		const host = `${url.hostname}${url.port ? `:${url.port}` : ""}`;
		const path = url.pathname === "/" ? "" : url.pathname;
		return cleanLabel(`${host}${path}${url.search}${url.hash}`, host);
	} catch {
		return cleanLabel(value, value).slice(0, MAX_LABEL_LENGTH);
	}
}

function originForUrl(value: string): string | undefined {
	const safe = safeSuggestionUrl(value);
	if (!safe) return undefined;
	try {
		const url = new URL(safe);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: undefined;
	} catch {
		return undefined;
	}
}

function faviconForUrl(
	url: string,
	favicons: readonly UserBrowserOriginFavicon[] | undefined,
): string | undefined {
	const origin = originForUrl(url);
	return origin
		? favicons?.find((item) => item.origin === origin)?.faviconDataUrl
		: undefined;
}

function words(value: string): string[] {
	return normalize(value).split(/[^a-z\d]+/i).filter(Boolean);
}

function matchScore(query: string, title: string, url: string): number {
	const needle = normalize(query);
	if (!needle) return 0;
	const normalizedTitle = normalize(title);
	const normalizedAddress = normalize(displayAddress(url));
	const normalizedUrl = normalize(url);
	const compactNeedle = needle.replace(/\s+/g, "");
	const compactTitle = normalizedTitle.replace(/\s+/g, "");
	const compactAddress = normalizedAddress.replace(/\s+/g, "");

	if (normalizedAddress === needle || normalizedUrl === needle) return 1_200;
	if (normalizedTitle === needle || compactTitle === compactNeedle) return 1_080;
	if (normalizedAddress.startsWith(needle) || normalizedUrl.startsWith(needle))
		return 980;
	if (normalizedTitle.startsWith(needle) || compactTitle.startsWith(compactNeedle))
		return 900;
	if (compactAddress.startsWith(compactNeedle)) return 860;

	const queryWords = words(needle);
	const titleWords = words(title);
	const addressWords = words(displayAddress(url));
	if (
		queryWords.length > 0 &&
		queryWords.every((word) =>
			[...titleWords, ...addressWords].some((candidate) =>
				candidate.startsWith(word),
			),
		)
	)
		return 760;
	if (normalizedTitle.includes(needle) || compactTitle.includes(compactNeedle))
		return 680;
	if (normalizedAddress.includes(needle) || normalizedUrl.includes(needle))
		return 640;
	return 0;
}

function recencyScore(value: string, now: Date): number {
	const visitedAt = Date.parse(value);
	if (!Number.isFinite(visitedAt)) return 0;
	const ageDays = Math.max(0, (now.getTime() - visitedAt) / 86_400_000);
	return Math.max(0, 64 - Math.min(64, ageDays * 2));
}

function isLikelyWebAddress(value: string): boolean {
	const input = value.trim();
	return (
		HTTP_ADDRESS.test(input) ||
		LOOPBACK_ADDRESS.test(input) ||
		HOST_LIKE_ADDRESS.test(input) ||
		IPV4_ADDRESS.test(input)
	);
}

function directUrlForInput(value: string): string | undefined {
	const input = value.trim();
	if (!isLikelyWebAddress(input)) return undefined;
	const candidate = HTTP_ADDRESS.test(input)
		? input
		: `${LOOPBACK_ADDRESS.test(input) || IPV4_ADDRESS.test(input) ? "http" : "https"}://${input}`;
	return safeSuggestionUrl(candidate);
}

function canInlineComplete(query: string, completion: string): boolean {
	const needle = query.trim();
	if (!needle || query !== needle || /\s/.test(needle)) return false;
	if (needle.length < 3 || !completion.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase()))
		return false;
	if (/^(?:https?:\/\/|kestrel:\/\/)/i.test(needle)) return true;
	if (/[./]/.test(needle)) return true;
	return completion.slice(needle.length).startsWith(".");
}

function sourceDetail(
	kind: Exclude<AddressBarSuggestionKind, "search" | "url">,
	url: string,
	isActive = false,
): string {
	const address = displayAddress(url);
	if (kind === "tab") return `${isActive ? "Current tab" : "Open tab"} · ${address}`;
	if (kind === "bookmark") return `Favorite · ${address}`;
	return `History · ${address}`;
}

interface InternalSuggestion extends AddressBarSuggestion {
	canonical: string;
	lastVisitedAt?: string;
	matchScore: number;
	visits: number;
}

function sourceAllowed(
	kind: AddressBarSuggestionKind,
	filter: AddressBarSuggestionFilter,
): boolean {
	if (filter === "all") return kind !== "search" && kind !== "url";
	if (filter === "history") return kind === "history";
	if (filter === "bookmarks") return kind === "bookmark";
	return kind === "tab";
}

function choosePreferredSource(
	candidates: InternalSuggestion[],
): InternalSuggestion[] {
	const grouped = new Map<string, InternalSuggestion>();
	for (const candidate of candidates) {
		const current = grouped.get(candidate.canonical);
		if (!current) {
			grouped.set(candidate.canonical, candidate);
			continue;
		}
		const currentPriority =
			SOURCE_PRIORITY[current.kind as keyof typeof SOURCE_PRIORITY] ?? 0;
		const candidatePriority =
			SOURCE_PRIORITY[candidate.kind as keyof typeof SOURCE_PRIORITY] ?? 0;
		if (
			candidatePriority > currentPriority ||
			(candidatePriority === currentPriority && candidate.score > current.score)
		)
			grouped.set(candidate.canonical, candidate);
	}
	return [...grouped.values()];
}

function sortSuggestions(
	left: InternalSuggestion,
	right: InternalSuggestion,
): number {
	if (right.score !== left.score) return right.score - left.score;
	const rightTime = Date.parse(right.lastVisitedAt ?? "");
	const leftTime = Date.parse(left.lastVisitedAt ?? "");
	if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime)
		return rightTime - leftTime;
	return left.title.localeCompare(right.title);
}

export function getAddressBarSuggestions({
	query = "",
	history,
	bookmarks,
	tabs,
	activeTabId,
	originFavicons,
	searchEngineName = "Search",
	filter = "all",
	now = new Date(),
}: AddressBarSuggestionInput): AddressBarSuggestion[] {
	const safeQuery = query.slice(0, MAX_QUERY_LENGTH);
	const needle = safeQuery.trim();
	const candidates: InternalSuggestion[] = [];

	const historyByUrl = new Map<string, InternalSuggestion>();
	for (const entry of history) {
		const url = safeSuggestionUrl(entry.url);
		const canonical = url ? canonicalUrl(url) : undefined;
		if (!url || !canonical) continue;
		const title = cleanLabel(entry.title, displayAddress(url));
		const match = needle ? matchScore(needle, title, url) : 0;
		if (needle && match === 0) continue;
		const current = historyByUrl.get(canonical);
		if (current) {
			current.visits += 1;
			const isNewer =
				Date.parse(entry.visitedAt) > Date.parse(current.lastVisitedAt ?? "");
			if (match > current.matchScore || (match === current.matchScore && isNewer)) {
				current.title = title;
				current.detail = sourceDetail("history", url);
				current.value = url;
				current.url = url;
				const faviconDataUrl = faviconForUrl(url, originFavicons);
				if (faviconDataUrl) current.faviconDataUrl = faviconDataUrl;
				else delete current.faviconDataUrl;
				current.lastVisitedAt = entry.visitedAt;
				current.matchScore = match;
			}
			current.score =
				current.matchScore +
				recencyScore(current.lastVisitedAt ?? "", now) +
				current.visits * 4;
			continue;
		}
		const faviconDataUrl = faviconForUrl(url, originFavicons);
		const candidate: InternalSuggestion = {
			id: `history:${canonical}`,
			kind: "history",
			title,
			detail: sourceDetail("history", url),
			value: url,
			url,
			...(faviconDataUrl ? { faviconDataUrl } : {}),
			score: match + recencyScore(entry.visitedAt, now) + 4,
			canonical,
			lastVisitedAt: entry.visitedAt,
			matchScore: match,
			visits: 1,
		};
		historyByUrl.set(canonical, candidate);
	}
	candidates.push(...historyByUrl.values());

	for (const bookmark of bookmarks) {
		const url = safeSuggestionUrl(bookmark.url);
		const canonical = url ? canonicalUrl(url) : undefined;
		if (!url || !canonical) continue;
		const title = cleanLabel(bookmark.title, displayAddress(url));
		const match = needle ? matchScore(needle, title, url) : 0;
		if (needle && match === 0) continue;
		const faviconDataUrl = faviconForUrl(url, originFavicons);
		candidates.push({
			id: `bookmark:${bookmark.id}`,
			kind: "bookmark",
			title,
			detail: sourceDetail("bookmark", url),
			value: url,
			url,
			...(faviconDataUrl ? { faviconDataUrl } : {}),
			score:
				match + SOURCE_PRIORITY.bookmark + recencyScore(bookmark.createdAt, now),
			canonical,
			lastVisitedAt: bookmark.createdAt,
			matchScore: match,
			visits: 1,
		});
	}

	for (const tab of tabs) {
		const url = safeSuggestionUrl(tab.url);
		const canonical = url ? canonicalUrl(url) : undefined;
		if (!url || !canonical) continue;
		const title = cleanLabel(tab.title, displayAddress(url));
		const match = needle ? matchScore(needle, title, url) : 0;
		if (needle && match === 0) continue;
		const isActive = tab.id === activeTabId;
		const faviconDataUrl = tab.faviconDataUrl ?? faviconForUrl(url, originFavicons);
		candidates.push({
			id: `tab:${tab.id}`,
			kind: "tab",
			title,
			detail: sourceDetail("tab", url, isActive),
			value: url,
			url,
			tabId: tab.id,
			...(faviconDataUrl ? { faviconDataUrl } : {}),
			score:
				match +
				SOURCE_PRIORITY.tab +
				(isActive ? 20 : 0) +
				recencyScore(tab.lastActiveAt, now),
			canonical,
			lastVisitedAt: tab.lastActiveAt,
			matchScore: match,
			visits: 1,
		});
	}

	const sourceCandidates = choosePreferredSource(
		candidates.filter((candidate) => sourceAllowed(candidate.kind, filter)),
	).sort(sortSuggestions);

	if (filter !== "all") return sourceCandidates.slice(0, MAX_SUGGESTIONS);

	const results: AddressBarSuggestion[] = [];
	const directUrl = needle ? directUrlForInput(needle) : undefined;
	const directCanonical = directUrl ? canonicalUrl(directUrl) : undefined;
	const matchingSource = directCanonical
		? sourceCandidates.find((candidate) => candidate.canonical === directCanonical)
		: undefined;
	const directSuggestion: AddressBarSuggestion | undefined =
		needle && directUrl && !matchingSource
			? {
				id: `url:${normalize(needle)}`,
				kind: "url",
				title: `Open ${displayAddress(directUrl)}`,
				detail: "Address",
				value: directUrl,
				url: directUrl,
				score: 1_100,
			}
			: undefined;

	const searchSuggestion: AddressBarSuggestion | undefined = needle
		? {
				id: `search:${normalize(needle)}`,
				kind: "search",
				title: `Search ${cleanLabel(searchEngineName, "Search")} for “${cleanLabel(needle, "this")}”`,
				detail: cleanLabel(searchEngineName, "Search engine"),
				value: needle,
				score: 700,
			}
		: undefined;

	const addressMatchIsStrong = sourceCandidates.some(
		(candidate) => candidate.score >= 860 && candidate.kind !== "history",
	);
	if (directSuggestion) results.push(directSuggestion);
	if (addressMatchIsStrong) {
		results.push(...sourceCandidates);
		if (searchSuggestion) results.push(searchSuggestion);
	} else {
		if (searchSuggestion) results.push(searchSuggestion);
		results.push(...sourceCandidates);
	}
	return results.slice(0, MAX_SUGGESTIONS);
}

export function getInlineAddressCompletion(
	query: string,
	suggestions: readonly AddressBarSuggestion[],
): InlineAddressCompletion | undefined {
	const needle = query.trim();
	if (!needle || /\s/.test(needle)) return undefined;
	for (const suggestion of suggestions) {
		if (!suggestion.url || suggestion.kind === "search") continue;
		const safeUrl = safeSuggestionUrl(suggestion.url);
		if (!safeUrl) continue;
		const completion = /^(?:https?:\/\/|kestrel:\/\/)/i.test(needle)
			? safeUrl
			: displayAddress(safeUrl);
		if (
			completion.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase()) &&
			completion.length > needle.length &&
			canInlineComplete(needle, completion)
		)
			return { value: completion, suggestion };
	}
	return undefined;
}

export function isAddressBarInput(value: string): boolean {
	const input = value.trim();
	return ADDRESS_PREFIX.test(input) || isLikelyWebAddress(input);
}
