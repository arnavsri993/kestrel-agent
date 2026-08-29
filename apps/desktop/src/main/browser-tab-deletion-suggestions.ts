import type { UserBrowserTab, UserBrowserTabDeletionSuggestion } from "@kestrel/shared-types";

const STALE_TAB_MS = 14 * 24 * 60 * 60 * 1000;

function normalizedTabUrl(url: string): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
		parsed.hash = "";
		const pathname =
			parsed.pathname.length > 1
				? parsed.pathname.replace(/\/+$/u, "")
				: parsed.pathname;
		return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
	} catch {
		return undefined;
	}
}

function isEmptyTab(tab: UserBrowserTab): boolean {
	return !tab.url && !tab.file;
}

function compareLastActive(left: UserBrowserTab, right: UserBrowserTab): number {
	return Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt);
}

function addSuggestion(
	suggestions: UserBrowserTabDeletionSuggestion[],
	seen: Set<string>,
	tabId: string,
	reason: string,
) {
	if (seen.has(tabId)) return;
	seen.add(tabId);
	suggestions.push({ tabId, reason });
}

export function suggestTabDeletions(
	tabs: UserBrowserTab[],
	activeTabId: string | null,
	now: () => Date = () => new Date(),
): UserBrowserTabDeletionSuggestion[] {
	const suggestions: UserBrowserTabDeletionSuggestion[] = [];
	const seen = new Set<string>();
	const currentTime = now().getTime();

	for (const tab of tabs) {
		if (tab.pinned || tab.id === activeTabId) continue;
		if (tab.error) {
			addSuggestion(suggestions, seen, tab.id, "Page failed to load");
			continue;
		}
		if (tab.crashed) {
			addSuggestion(suggestions, seen, tab.id, "Tab crashed");
		}
	}

	const duplicates = new Map<string, UserBrowserTab[]>();
	for (const tab of tabs) {
		if (tab.pinned) continue;
		const normalized = normalizedTabUrl(tab.url);
		if (!normalized) continue;
		const group = duplicates.get(normalized) ?? [];
		group.push(tab);
		duplicates.set(normalized, group);
	}
	for (const group of duplicates.values()) {
		if (group.length < 2) continue;
		const [, ...rest] = [...group].sort(compareLastActive);
		for (const tab of rest) {
			if (tab.id === activeTabId) continue;
			addSuggestion(suggestions, seen, tab.id, "Duplicate of another open tab");
		}
	}

	const emptyTabs = tabs.filter(
		(tab) =>
			isEmptyTab(tab) && !tab.pinned && tab.id !== activeTabId && !seen.has(tab.id),
	);
	if (emptyTabs.length > 1) {
		const [, ...rest] = [...emptyTabs].sort(compareLastActive);
		for (const tab of rest) {
			addSuggestion(suggestions, seen, tab.id, "Extra empty tab");
		}
	}

	for (const tab of tabs) {
		if (tab.pinned || tab.id === activeTabId || seen.has(tab.id)) continue;
		const lastActive = Date.parse(tab.lastActiveAt);
		if (!Number.isFinite(lastActive)) continue;
		if (currentTime - lastActive < STALE_TAB_MS) continue;
		addSuggestion(suggestions, seen, tab.id, "Not used in the last two weeks");
	}

	return suggestions;
}
