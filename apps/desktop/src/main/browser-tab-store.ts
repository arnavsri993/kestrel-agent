import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	DEFAULT_NEW_TAB_WIDGET_IDS,
	emptyNewTabGreetingActivity,
	type UserBrowserOriginFavicon,
	type UserBrowserSettings,
	type UserBrowserState,
	UserBrowserStateSchema,
} from "@kestrel/shared-types";
import {
	isKestrelAppPageUrl,
	parseKestrelAppPage,
} from "../utility/browser-app-pages";

export const DEFAULT_BROWSER_SETTINGS: UserBrowserSettings = {
	searchEngine: "google",
	tabLayout: "horizontal",
	newTabBackground: "graphite",
	newTabGreetingActivity: emptyNewTabGreetingActivity(),
	newTabWidgets: {
		version: 1,
		enabled: [...DEFAULT_NEW_TAB_WIDGET_IDS],
		layouts: {},
	},
	restoreSession: true,
	historyRetentionDays: 90,
	sleepingTabsEnabled: true,
	sleepingTabTimeoutMinutes: 30,
	sleepingTabExcludedDomains: [],
	memorySaverMode: true,
	showBookmarksBar: true,
	addressBarSuggestionsEnabled: true,
	passwordAutofillEnabled: true,
	paymentAutofillEnabled: true,
};
const SEARCH_ENGINES: Record<
	Exclude<UserBrowserSettings["searchEngine"], "custom">,
	string
> = {
	google: "https://www.google.com/search?q=",
	duckduckgo: "https://duckduckgo.com/?q=",
	bing: "https://www.bing.com/search?q=",
	brave: "https://search.brave.com/search?q=",
	ecosia: "https://www.ecosia.org/search?q=",
	startpage: "https://www.startpage.com/sp/search?query=",
	yahoo: "https://search.yahoo.com/search?p=",
	kagi: "https://kagi.com/search?q=",
	qwant: "https://www.qwant.com/?q=",
	mojeek: "https://www.mojeek.com/search?q=",
	baidu: "https://www.baidu.com/s?wd=",
	yandex: "https://yandex.com/search/?text=",
};

const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const LOOPBACK =
	/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
const HOST_LIKE =
	/^(?:[A-Za-z\d](?:[A-Za-z\d-]{0,62}[A-Za-z\d])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:[/?#]|$)/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)/;
const CUSTOM_SEARCH_TEMPLATE = /%s/;
const SENSITIVE_URL_KEY =
	/^(?:access_?token|api_?key|assertion|auth(?:entication|orization)?(?:_?token|_?code)?|client_?secret|code|credential|id_?token|jwt|key|oauth(?:_?token|_?code)?|password|refresh_?token|samlresponse|secret|session(?:_?id|_?token)?|sig(?:nature)?|sso(?:_?token)?|ticket|token|x-amz-(?:credential|security-token|signature))$/i;

export interface NormalizedBrowserAddress {
	kind: "url" | "search";
	url: string;
}

export const MAX_AX_SNAPSHOT_BYTES = 1_500_000;
export const MAX_AX_SNAPSHOT_NODES = 5_000;
export const MAX_INTERACTIVE_REFS = 200;
export const MAX_ORIGIN_FAVICONS = 200;

export function upsertOriginFavicon(
	current: UserBrowserOriginFavicon[],
	origin: string,
	faviconDataUrl: string,
	updatedAt: string,
	limit = MAX_ORIGIN_FAVICONS,
): UserBrowserOriginFavicon[] {
	const without = current.filter((item) => item.origin !== origin);
	return [...without, { origin, faviconDataUrl, updatedAt }].slice(
		-Math.max(1, limit),
	);
}

const ACCESSIBILITY_URL_VALUE =
	/\b(?:https?|file|ftp|data|javascript|blob):[^\s<>"'{}[\]]+/gi;

export function sanitizeUntrustedBrowserValue(value: unknown): unknown {
	if (typeof value === "string")
		return value.replace(ACCESSIBILITY_URL_VALUE, (candidate) => {
			return sanitizeBrowserUrl(candidate) || "[redacted URL]";
		});
	if (Array.isArray(value)) return value.map(sanitizeUntrustedBrowserValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			sanitizeUntrustedBrowserValue(item),
		]),
	);
}

export function redactUntrustedBrowserText(
	value: unknown,
	maximum: number,
): string {
	return String(sanitizeUntrustedBrowserValue(String(value ?? ""))).slice(
		0,
		maximum,
	);
}

/**
 * Keep navigationally useful URLs while excluding credential-like values from
 * durable history, session restore, downloads, and model-visible metadata.
 */
function normalizeCustomSearchTemplate(template: string): string {
	const trimmed = template.trim();
	if (!trimmed || trimmed.length > 2_048)
		throw new Error("Enter a valid search engine URL.");
	const sample = CUSTOM_SEARCH_TEMPLATE.test(trimmed)
		? trimmed.replace(/%s/g, "query")
		: trimmed;
	let parsed: URL;
	try {
		parsed = new URL(sample);
	} catch {
		throw new Error("Enter a valid search engine URL.");
	}
	if (!["http:", "https:"].includes(parsed.protocol))
		throw new Error("Custom search engines must use HTTP or HTTPS URLs.");
	if (parsed.username || parsed.password)
		throw new Error(
			"Search engine URLs with embedded credentials are blocked.",
		);
	return trimmed;
}

export function describeBrowserLoadFailure(
	errorCode: number,
	errorDescription = "",
): string {
	const description = errorDescription.trim();
	switch (errorCode) {
		case -105:
			return "This address could not be found. Check the spelling or try a web search instead.";
		case -106:
			return "You appear to be offline. Check your internet connection and try again.";
		case -109:
		case -113:
			return "Kestrel could not reach this site. It may be down or blocking connections.";
		case -118:
			return "The connection timed out. Try again in a moment or check your network.";
		case -200:
		case -201:
		case -202:
		case -207:
			return "This site's security certificate could not be verified. Contact the site owner if you need access.";
		case -501:
			return "This page uses an insecure connection that Kestrel blocked.";
		case -300:
			return "This address is not valid. Check the URL and try again.";
		case -10:
			return "Access to this page was blocked.";
		default:
			if (/ERR_NAME_NOT_RESOLVED/i.test(description))
				return "This address could not be found. Check the spelling or try a web search instead.";
			if (/ERR_INTERNET_DISCONNECTED/i.test(description))
				return "You appear to be offline. Check your internet connection and try again.";
			if (/ERR_CONNECTION_TIMED_OUT/i.test(description))
				return "The connection timed out. Try again in a moment or check your network.";
			if (/ERR_CERT/i.test(description))
				return "This site's security certificate could not be verified.";
			return "This page could not be opened. Check the address or try again in a moment.";
	}
}

export function sanitizeBrowserUrl(value: string): string {
	if (!value || value.length > 8_192) return "";
	try {
		const url = new URL(value);
		const appPage = parseKestrelAppPage(value);
		if (appPage) return appPage.url;
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_URL_KEY.test(key)) url.searchParams.delete(key);
		}
		if (url.hash.length > 1) {
			const fragment = url.hash.slice(1);
			if (fragment.includes("=")) {
				const parameters = new URLSearchParams(fragment);
				for (const key of [...parameters.keys()]) {
					if (SENSITIVE_URL_KEY.test(key)) parameters.delete(key);
				}
				const next = parameters.toString();
				url.hash = next ? `#${next}` : "";
			} else if (fragment.length > 512) {
				url.hash = "";
			}
		}
		const sanitized = url.toString();
		return sanitized.length <= 8_192 ? sanitized : "";
	} catch {
		return "";
	}
}

function hostnameForUrl(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, "") || "New Tab";
	} catch {
		return "New Tab";
	}
}

export function normalizeBrowserAddress(
	value: string,
	searchEngine: UserBrowserSettings["searchEngine"] = "google",
	customSearchUrl?: string,
): NormalizedBrowserAddress {
	const input = value.trim();
	if (!input || input.length > 8_192 || /[\u0000-\u001f\u007f]/.test(input))
		throw new Error("Enter a valid address or search.");

	// A loopback host with a port (for example localhost:5173) resembles a URL
	// scheme to the generic parser, but is intentionally supported for local
	// development and test pages.
	const loopback = LOOPBACK.test(input);
	const explicitScheme = EXPLICIT_SCHEME.test(input) && !loopback;
	const appPage = parseKestrelAppPage(input);
	if (appPage) return { kind: "url", url: appPage.url };
	if (explicitScheme && !/^https?:/i.test(input))
		throw new Error("Kestrel tabs support HTTP and HTTPS pages only.");

	const looksLikeHost = loopback || HOST_LIKE.test(input) || IPV4.test(input);
	if (!explicitScheme && !looksLikeHost) {
		if (searchEngine === "custom" && customSearchUrl) {
			const template = normalizeCustomSearchTemplate(customSearchUrl);
			const encoded = encodeURIComponent(input);
			const url = CUSTOM_SEARCH_TEMPLATE.test(template)
				? template.replace(/%s/g, encoded)
				: `${template}${template.includes("?") ? "&q=" : "?q="}${encoded}`;
			return {
				kind: "search",
				url,
			};
		}
		const engineBase =
			searchEngine === "custom"
				? SEARCH_ENGINES.google
				: SEARCH_ENGINES[searchEngine] ?? SEARCH_ENGINES.google;
		return {
			kind: "search",
			url: `${engineBase}${encodeURIComponent(input)}`,
		};
	}

	const candidate = explicitScheme
		? input
		: `${loopback ? "http" : "https"}://${input}`;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error("Enter a valid address or search.");
	}
	if (!["http:", "https:"].includes(parsed.protocol))
		throw new Error("Kestrel tabs support HTTP and HTTPS pages only.");
	if (parsed.username || parsed.password)
		throw new Error(
			"Addresses with embedded usernames or passwords are blocked.",
		);
	if (!parsed.hostname || (parsed.port && Number(parsed.port) > 65_535))
		throw new Error("Enter a valid address or search.");
	return { kind: "url", url: parsed.toString() };
}

export function createEmptyBrowserTab(
	now: () => Date = () => new Date(),
): UserBrowserState["tabs"][number] {
	const timestamp = now().toISOString();
	return {
		id: `tab-${randomUUID()}`,
		title: "New Tab",
		url: "",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		discarded: false,
		crashed: false,
		pinned: false,
		muted: false,
		createdAt: timestamp,
		lastActiveAt: timestamp,
	};
}

export function freshBrowserState(
	now: () => Date = () => new Date(),
): UserBrowserState {
	const tab = createEmptyBrowserTab(now);
	return {
		tabs: [tab],
		tabFolders: [],
		activeTabId: tab.id,
		history: [],
		originFavicons: [],
		downloads: [],
		bookmarks: [],
		recentlyClosedTabs: [],
		sitePermissions: [],
		settings: { ...DEFAULT_BROWSER_SETTINGS },
	};
}

export class BrowserTabStore {
	constructor(private readonly path: string) {}

	load(now: () => Date = () => new Date()): UserBrowserState {
		if (!existsSync(this.path)) return freshBrowserState(now);
		let serialized: string;
		try {
			serialized = readFileSync(this.path, "utf8");
		} catch {
			// A transient filesystem or permission failure is not evidence that the
			// user's session is corrupt. Leave the original path untouched so a later
			// launch can retry it.
			return freshBrowserState(now);
		}

		let state: UserBrowserState;
		try {
			state = UserBrowserStateSchema.parse(JSON.parse(serialized));
		} catch {
			// Preserve malformed data for diagnosis or manual recovery rather than
			// silently overwriting it the next time a fresh session is saved.
			try {
				renameSync(
					this.path,
					`${this.path}.corrupt-${Date.now()}-${randomUUID()}`,
				);
			} catch {
				// The state is still unusable, but a failed archival rename must not
				// prevent Kestrel from opening a safe fresh tab.
			}
			return freshBrowserState(now);
		}

		const tabs = state.settings.restoreSession
			? state.tabs
					.filter(
						(tab) =>
							!tab.url ||
							/^https?:\/\//.test(tab.url) ||
							isKestrelAppPageUrl(tab.url),
					)
					.map((tab) => ({
						...tab,
						faviconDataUrl: undefined,
						loading: false,
						canGoBack: false,
						canGoForward: false,
						discarded: Boolean(tab.url) && !isKestrelAppPageUrl(tab.url),
						crashed: false,
						error: undefined,
					}))
			: [];
		if (tabs.length === 0)
			return {
				...freshBrowserState(now),
				tabFolders: [],
				history: state.history,
				originFavicons: state.originFavicons,
				bookmarks: state.bookmarks,
				recentlyClosedTabs: state.recentlyClosedTabs,
				sitePermissions: state.sitePermissions,
				downloads: state.downloads.map((download) => ({
					...download,
					status:
						download.status === "progressing" ? "failed" : download.status,
					canReveal: false,
				})),
				settings: state.settings,
			};
		const tabFolderIds = new Set(
			state.tabFolders
				.filter((folder) => tabs.some((tab) => tab.tabFolderId === folder.id))
				.map((folder) => folder.id),
		);
		const normalizedTabs = tabs.map((tab) =>
			tab.tabFolderId && tabFolderIds.has(tab.tabFolderId)
				? tab
				: { ...tab, tabFolderId: undefined },
		);
		const activeTabId = tabs.some((tab) => tab.id === state.activeTabId)
			? state.activeTabId
			: normalizedTabs[0]!.id;
		return {
			...state,
			tabs: normalizedTabs,
			tabFolders: state.tabFolders.filter((folder) =>
				tabFolderIds.has(folder.id),
			),
			activeTabId,
			downloads: state.downloads.map((download) => ({
				...download,
				status:
					download.status === "progressing" ? "failed" : download.status,
				canReveal: false,
			})),
		};
	}

	save(state: UserBrowserState): void {
		const safe = UserBrowserStateSchema.parse({
			...state,
			tabs: state.tabs.map(({ faviconDataUrl: _faviconDataUrl, ...tab }) => ({
				...tab,
				url: tab.url ? sanitizeBrowserUrl(tab.url) : "",
			})),
			history: state.history.flatMap((entry) => {
				const url = sanitizeBrowserUrl(entry.url);
				return url ? [{ ...entry, url }] : [];
			}),
			recentlyClosedTabs: state.recentlyClosedTabs.flatMap((tab) => {
				const url = sanitizeBrowserUrl(tab.url);
				if (!url) return [];
				return [
					{
						...tab,
						url,
						title:
							redactUntrustedBrowserText(tab.title, 500) ||
							hostnameForUrl(url),
					},
				];
			}),
			originFavicons: state.originFavicons.flatMap((item) => {
				try {
					const origin = new URL(item.origin).origin;
					if (
						!item.faviconDataUrl.startsWith("data:image/") ||
						origin !== item.origin
					)
						return [];
					return [{ ...item, origin }];
				} catch {
					return [];
				}
			}),
			downloads: state.downloads.flatMap((download) => {
				const sourceUrl = sanitizeBrowserUrl(download.sourceUrl);
				return sourceUrl ? [{ ...download, sourceUrl }] : [];
			}),
		});
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}
}
