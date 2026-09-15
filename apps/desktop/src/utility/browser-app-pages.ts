export const KESTREL_APP_PAGES = {
	settings: "Settings",
	history: "History",
	bookmarks: "Bookmarks",
	downloads: "Downloads",
	commands: "Command Center",
	writing: "Writing Studio",
	agent: "Agent",
	projects: "Projects",
	readiness: "Readiness",
	approvals: "Approvals",
	memory: "Memory",
	connections: "Connections",
	research: "Research",
	artifacts: "Artifacts",
	work: "Work",
	events: "Opportunities",
	activity: "Activity",
	extensions: "Extensions",
} as const;

export type KestrelAppPageId = keyof typeof KESTREL_APP_PAGES;

export interface KestrelAppPage {
	scopeSessionId?: string;
	id: KestrelAppPageId;
	url: string;
	title: string;
}

export interface KestrelFilePage {
	tabId: string;
	url: string;
}

export function isKestrelAppPageId(value: string): value is KestrelAppPageId {
	return Object.hasOwn(KESTREL_APP_PAGES, value);
}

export function kestrelAppPageUrl(id: KestrelAppPageId, scopeSessionId?: string): string {
	if (scopeSessionId && (id !== "memory" && id !== "connections" || !/^session-[a-zA-Z0-9-]{1,160}$/.test(scopeSessionId)))
		throw new Error("Invalid app page scope.");
	return `kestrel://${id}${scopeSessionId ? `?scope=${encodeURIComponent(scopeSessionId)}` : ""}`;
}

export function parseKestrelAppPage(value: string): KestrelAppPage | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value.trim());
		if (
			url.protocol !== "kestrel:" ||
			url.username ||
			url.password ||
			url.port ||
			url.hash ||
			(url.pathname !== "" && url.pathname !== "/")
		)
			return undefined;
		if (!isKestrelAppPageId(url.hostname)) return undefined;
		const scopeSessionId = url.searchParams.get("scope") ?? undefined;
		if (url.search && (!scopeSessionId || [...url.searchParams.keys()].length !== 1 ||
			(url.hostname !== "memory" && url.hostname !== "connections") ||
			!/^session-[a-zA-Z0-9-]{1,160}$/.test(scopeSessionId))) return undefined;
		return {
			id: url.hostname,
			url: kestrelAppPageUrl(url.hostname, scopeSessionId),
			...(scopeSessionId ? { scopeSessionId } : {}),
			title: KESTREL_APP_PAGES[url.hostname],
		};
	} catch {
		return undefined;
	}
}

/**
 * File tabs use an opaque tab id in the URL. The actual path stays in the
 * trusted browser-tab state and is never placed in a navigable URL.
 */
export function parseKestrelFilePage(value: string): KestrelFilePage | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value.trim());
		if (
			url.protocol !== "kestrel:" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash ||
			url.hostname !== "file"
		)
			return undefined;
		const tabId = url.pathname.replace(/^\//, "");
		if (!/^tab-[a-f0-9-]{36}$/.test(tabId)) return undefined;
		return { tabId, url: `kestrel://file/${tabId}` };
	} catch {
		return undefined;
	}
}

export function isKestrelAppPageUrl(value: string): boolean {
	return Boolean(parseKestrelAppPage(value) || parseKestrelFilePage(value));
}
