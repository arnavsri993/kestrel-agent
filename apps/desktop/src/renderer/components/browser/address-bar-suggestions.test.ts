import { describe, expect, it } from "vitest";
import type {
	UserBrowserBookmark,
	UserBrowserHistoryEntry,
	UserBrowserOriginFavicon,
	UserBrowserTab,
} from "@kestrel/shared-types";
import {
	displayAddress,
	getAddressBarSuggestions,
	getInlineAddressCompletion,
} from "./address-bar-suggestions";

const tabId = "tab-00000000-0000-4000-8000-000000000000";
const now = new Date("2026-08-26T12:00:00.000Z");

function historyEntry(
	url: string,
	title: string,
	id = "00000000-0000-4000-8000-000000000001",
	visitedAt = "2026-08-26T11:00:00.000Z",
): UserBrowserHistoryEntry {
	return {
		id: `visit-${id}`,
		tabId,
		url,
		title,
		visitedAt,
	};
}

function bookmark(url: string, title: string): UserBrowserBookmark {
	return {
		id: "bookmark-00000000-0000-4000-8000-000000000001",
		url,
		title,
		createdAt: "2026-08-20T11:00:00.000Z",
	};
}

function tab(url: string, title: string, id = tabId): UserBrowserTab {
	return {
		id,
		title,
		url,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		discarded: false,
		crashed: false,
		pinned: false,
		muted: false,
		createdAt: "2026-08-20T11:00:00.000Z",
		lastActiveAt: "2026-08-26T11:30:00.000Z",
	};
}

describe("address bar suggestions", () => {
	it("keeps empty-query suggestions local and ordered by recency", () => {
		const suggestions = getAddressBarSuggestions({
			now,
		history: [
			historyEntry(
				"https://older.example/archive",
				"Older page",
				"00000000-0000-4000-8000-000000000002",
				"2026-08-20T11:00:00.000Z",
			),
			historyEntry("https://recent.example/inbox", "Recent page"),
		],
		bookmarks: [],
			tabs: [],
		});

		expect(suggestions.map((item) => item.title)).toEqual([
			"Recent page",
			"Older page",
		]);
		expect(suggestions.every((item) => item.kind !== "search")).toBe(true);
	});

	it("puts an explicit search action before generic local matches", () => {
		const suggestions = getAddressBarSuggestions({
			now,
			query: "chat gpt",
			searchEngineName: "Google",
			history: [historyEntry("https://chatgpt.com/", "ChatGPT")],
			bookmarks: [],
			tabs: [],
		});

		expect(suggestions[0]).toMatchObject({
			kind: "search",
			value: "chat gpt",
		});
		expect(suggestions.some((item) => item.title === "ChatGPT")).toBe(true);
	});

	it("offers inline URL completion without completing from a title alone", () => {
		const suggestions = getAddressBarSuggestions({
			now,
			query: "chatgpt",
			history: [
				historyEntry("https://chatgpt.com/c/example", "ChatGPT"),
				historyEntry("https://example.com/notes", "chatgpt project notes"),
			],
			bookmarks: [],
			tabs: [],
		});
		const completion = getInlineAddressCompletion("chatgpt", suggestions);

		expect(completion?.value).toBe("chatgpt.com/c/example");
		expect(completion?.suggestion.url).toBe("https://chatgpt.com/c/example");
	});

	it("deduplicates a matching tab over its history and bookmark entries", () => {
		const matchingUrl = "https://docs.example.com/project";
		const suggestions = getAddressBarSuggestions({
			now,
			query: "docs.example.com",
			activeTabId: tabId,
			history: [historyEntry(matchingUrl, "Project history")],
			bookmarks: [bookmark(matchingUrl, "Project favorite")],
			tabs: [tab(matchingUrl, "Project tab")],
		});
		const matches = suggestions.filter((item) => item.url === matchingUrl);

		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			kind: "tab",
			tabId,
			title: "Project tab",
		});
	});

	it("supports source filters and an explicit new address", () => {
		const url = "https://new.example/path";
		const filtered = getAddressBarSuggestions({
			filter: "bookmarks",
			query: "docs",
			history: [historyEntry("https://docs.example.com/history", "Docs history")],
			bookmarks: [bookmark("https://docs.example.com/favorite", "Docs favorite")],
			tabs: [],
			now,
		});
		const direct = getAddressBarSuggestions({
			query: url,
			history: [],
			bookmarks: [],
			tabs: [],
			now,
		});

		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.kind).toBe("bookmark");
		expect(direct[0]).toMatchObject({
			kind: "url",
			value: url,
		});
	});

	it("recognizes the same bare hosts and loopback addresses as navigation", () => {
		const cases = [
			["example.com/docs", "https://example.com/docs"],
			["localhost:5173", "http://localhost:5173/"],
			["127.0.0.1:4173", "http://127.0.0.1:4173/"],
		] as const;

		for (const [query, value] of cases) {
			const suggestions = getAddressBarSuggestions({
				now,
				query,
				history: [],
				bookmarks: [],
				tabs: [],
			});
			expect(suggestions[0]).toMatchObject({
				kind: "url",
				value,
			});
		}
	});

	it("does not expose unsupported or credential-bearing URLs", () => {
		const favicons: UserBrowserOriginFavicon[] = [
			{
				origin: "https://safe.example",
				faviconDataUrl: "data:image/png;base64,SAFE",
				updatedAt: "2026-08-26T10:00:00.000Z",
			},
		];
		const suggestions = getAddressBarSuggestions({
			history: [
				historyEntry(
					"https://person:secret@safe.example/private",
					"Private",
					"00000000-0000-4000-8000-000000000003",
				),
				historyEntry("file:///Users/example/private.txt", "Private file"),
				historyEntry("https://safe.example/public", "Safe page"),
			],
			bookmarks: [],
			tabs: [],
			originFavicons: favicons,
			now,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({
			url: "https://safe.example/public",
			faviconDataUrl: "data:image/png;base64,SAFE",
		});
		expect(displayAddress("https://safe.example/public")).toBe("safe.example/public");
	});
});
