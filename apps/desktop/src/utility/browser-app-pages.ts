export const KESTREL_APP_PAGES = {
	settings: "Settings",
	history: "History",
	bookmarks: "Bookmarks",
	downloads: "Downloads",
	commands: "Capabilities",
	agent: "Agent",
	readiness: "Readiness",
	approvals: "Approvals",
	memory: "Life",
	research: "Research",
	artifacts: "Artifacts",
	work: "Work",
	events: "Opportunities",
	activity: "Activity",
	extensions: "Extensions",
} as const;

export type KestrelAppPageId = keyof typeof KESTREL_APP_PAGES;

export interface KestrelAppPage {
	id: KestrelAppPageId;
	url: string;
	title: string;
}

export function isKestrelAppPageId(value: string): value is KestrelAppPageId {
	return Object.hasOwn(KESTREL_APP_PAGES, value);
}

export function kestrelAppPageUrl(id: KestrelAppPageId): string {
	return `kestrel://${id}`;
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
			url.search ||
			url.hash ||
			(url.pathname !== "" && url.pathname !== "/")
		)
			return undefined;
		if (!isKestrelAppPageId(url.hostname)) return undefined;
		return {
			id: url.hostname,
			url: kestrelAppPageUrl(url.hostname),
			title: KESTREL_APP_PAGES[url.hostname],
		};
	} catch {
		return undefined;
	}
}

export function isKestrelAppPageUrl(value: string): boolean {
	return Boolean(parseKestrelAppPage(value));
}
