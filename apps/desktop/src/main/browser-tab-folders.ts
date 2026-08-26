import { randomUUID } from "node:crypto";
import type {
	UserBrowserTab,
	UserBrowserTabFolder,
	UserBrowserTabFolderColor,
} from "@kestrel/shared-types";

type FolderPlan = {
	key: string;
	name: string;
	color: UserBrowserTabFolderColor;
};

type FolderRule = FolderPlan & {
	hosts: readonly string[];
	keywords: readonly string[];
};

const FOLDER_RULES: readonly FolderRule[] = [
	{
		key: "email",
		name: "Email",
		color: "rose",
		hosts: [
			"gmail.com",
			"mail.google.com",
			"outlook.com",
			"outlook.live.com",
			"outlook.office.com",
			"mail.yahoo.com",
		],
		keywords: ["inbox", "email", "mail"],
	},
	{
		key: "work",
		name: "Work",
		color: "blue",
		hosts: [
			"slack.com",
			"notion.so",
			"linear.app",
			"figma.com",
			"asana.com",
			"trello.com",
			"atlassian.com",
			"jira.com",
			"docs.google.com",
			"drive.google.com",
			"sheets.google.com",
			"office.com",
			"microsoft365.com",
		],
		keywords: ["meeting", "project", "roadmap", "workspace", "task"],
	},
	{
		key: "development",
		name: "Development",
		color: "teal",
		hosts: [
			"github.com",
			"gitlab.com",
			"bitbucket.org",
			"stackoverflow.com",
			"stackexchange.com",
			"npmjs.com",
			"vercel.com",
			"localhost",
			"127.0.0.1",
		],
		keywords: [
			"code",
			"developer",
			"repository",
			"pull",
			"api",
			"typescript",
			"javascript",
			"terminal",
		],
	},
	{
		key: "travel",
		name: "Travel",
		color: "green",
		hosts: [
			"maps.google.com",
			"booking.com",
			"airbnb.com",
			"expedia.com",
			"tripadvisor.com",
			"kayak.com",
		],
		keywords: ["flight", "hotel", "itinerary", "directions", "travel"],
	},
	{
		key: "shopping",
		name: "Shopping",
		color: "amber",
		hosts: [
			"amazon.com",
			"ebay.com",
			"etsy.com",
			"walmart.com",
			"target.com",
			"bestbuy.com",
			"shopify.com",
		],
		keywords: ["cart", "checkout", "product", "price", "shopping"],
	},
	{
		key: "finance",
		name: "Finance",
		color: "violet",
		hosts: [
			"paypal.com",
			"stripe.com",
			"chase.com",
			"fidelity.com",
			"robinhood.com",
			"coinbase.com",
		],
		keywords: ["bank", "balance", "billing", "invoice", "payment"],
	},
	{
		key: "media",
		name: "Media",
		color: "rose",
		hosts: [
			"youtube.com",
			"netflix.com",
			"spotify.com",
			"twitch.tv",
			"soundcloud.com",
		],
		keywords: ["watch", "listen", "video", "playlist", "stream"],
	},
	{
		key: "social",
		name: "Social",
		color: "blue",
		hosts: [
			"reddit.com",
			"linkedin.com",
			"twitter.com",
			"x.com",
			"facebook.com",
			"instagram.com",
			"threads.net",
		],
		keywords: ["feed", "profile", "social", "post"],
	},
	{
		key: "news",
		name: "News",
		color: "amber",
		hosts: [
			"nytimes.com",
			"washingtonpost.com",
			"bbc.com",
			"cnn.com",
			"reuters.com",
			"theguardian.com",
			"npr.org",
			"bloomberg.com",
			"wsj.com",
		],
		keywords: ["news", "breaking", "headline"],
	},
	{
		key: "research",
		name: "Research",
		color: "violet",
		hosts: [
			"google.com",
			"bing.com",
			"duckduckgo.com",
			"wikipedia.org",
			"scholar.google.com",
			"arxiv.org",
		],
		keywords: [
			"research",
			"article",
			"study",
			"paper",
			"reference",
			"guide",
			"tutorial",
		],
	},
];

const SITE_COLORS: readonly UserBrowserTabFolderColor[] = [
	"blue",
	"green",
	"amber",
	"rose",
	"violet",
	"teal",
];

function pageHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
		return parsed.hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

function hostMatches(host: string, candidate: string): boolean {
	return host === candidate || host.endsWith(`.${candidate}`);
}

function hasKeyword(value: string, keyword: string): boolean {
	if (keyword.includes(".")) return value.includes(keyword);
	return value.split(/[^a-z0-9]+/).includes(keyword);
}

function folderRuleMatches(tab: UserBrowserTab, host: string, rule: FolderRule) {
	if (rule.hosts.some((candidate) => hostMatches(host, candidate))) return true;
	const searchable = `${host} ${tab.title}`.toLowerCase();
	return rule.keywords.some((keyword) => hasKeyword(searchable, keyword));
}

function siteFolderColor(host: string): UserBrowserTabFolderColor {
	let hash = 0;
	for (const character of host)
		hash = (hash * 31 + character.charCodeAt(0)) | 0;
	return SITE_COLORS[Math.abs(hash) % SITE_COLORS.length] ?? "slate";
}

function siteFolderName(host: string): string {
	const labels = host.split(".").filter(Boolean);
	const ignored = new Set(["app", "blog", "docs", "m", "mail", "web", "www"]);
	const label = labels.find((candidate) => !ignored.has(candidate)) ?? labels[0];
	return (label ?? "Site")
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function folderPlanForTab(
	tab: UserBrowserTab,
	hostCounts: ReadonlyMap<string, number>,
): FolderPlan | undefined {
	const host = pageHost(tab.url);
	if (!host) return undefined;
	for (const rule of FOLDER_RULES) {
		if (folderRuleMatches(tab, host, rule)) {
			return { key: rule.key, name: rule.name, color: rule.color };
		}
	}
	if ((hostCounts.get(host) ?? 0) < 2) return undefined;
	return {
		key: `site:${host}`,
		name: siteFolderName(host),
		color: siteFolderColor(host),
	};
}

export function organizeBrowserTabs(
	tabs: UserBrowserTab[],
	now: () => Date = () => new Date(),
	createId: () => string = randomUUID,
): { tabs: UserBrowserTab[]; tabFolders: UserBrowserTabFolder[] } {
	const unpinnedTabs = tabs.filter((tab) => !tab.pinned);
	const hostCounts = new Map<string, number>();
	for (const tab of unpinnedTabs) {
		const host = pageHost(tab.url);
		if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
	}

	const plans = new Map<string, FolderPlan>();
	const assignments = new Map<string, string>();
	for (const tab of unpinnedTabs) {
		const plan = folderPlanForTab(tab, hostCounts);
		if (!plan) continue;
		if (!plans.has(plan.key)) plans.set(plan.key, plan);
		assignments.set(tab.id, plan.key);
	}

	const createdAt = now().toISOString();
	const folderIds = new Map<string, string>();
	const tabFolders = [...plans.values()].map((plan) => {
		const id = `tab-folder-${createId()}`;
		folderIds.set(plan.key, id);
		return {
			id,
			name: plan.name,
			color: plan.color,
			createdAt,
		};
	});

	const pinnedTabs = tabs
		.filter((tab) => tab.pinned)
		.map((tab) => ({ ...tab, tabFolderId: undefined }));
	const groupedTabs = [...plans.keys()].flatMap((key) =>
		unpinnedTabs
			.filter((tab) => assignments.get(tab.id) === key)
			.map((tab) => ({ ...tab, tabFolderId: folderIds.get(key) })),
	);
	const unfiledTabs = unpinnedTabs
		.filter((tab) => !assignments.has(tab.id))
		.map((tab) => ({ ...tab, tabFolderId: undefined }));

	return { tabs: [...pinnedTabs, ...groupedTabs, ...unfiledTabs], tabFolders };
}
