import type { UserBrowserTab } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { suggestTabDeletions } from "./browser-tab-deletion-suggestions";

const TAB_IDS = [
	"tab-00000000-0000-0000-0000-000000000001",
	"tab-00000000-0000-0000-0000-000000000002",
	"tab-00000000-0000-0000-0000-000000000003",
	"tab-00000000-0000-0000-0000-000000000004",
] as const;

function tab(
	index: number,
	overrides: Partial<UserBrowserTab> = {},
): UserBrowserTab {
	const timestamp = "2026-08-26T12:00:00.000Z";
	return {
		id: TAB_IDS[index]!,
		url: "",
		title: "Tab",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		discarded: false,
		crashed: false,
		pinned: false,
		muted: false,
		createdAt: timestamp,
		lastActiveAt: timestamp,
		...overrides,
	};
}

describe("suggestTabDeletions", () => {
	it("suggests older duplicate tabs and keeps the most recently active copy", () => {
		const suggestions = suggestTabDeletions(
			[
				tab(0, {
					url: "https://example.com/a",
					title: "Older copy",
					lastActiveAt: "2026-08-20T12:00:00.000Z",
				}),
				tab(1, {
					url: "https://example.com/a/",
					title: "Newer copy",
					lastActiveAt: "2026-08-26T12:00:00.000Z",
				}),
			],
			TAB_IDS[1],
		);

		expect(suggestions).toEqual([
			{
				tabId: TAB_IDS[0],
				reason: "Duplicate of another open tab",
			},
		]);
	});

	it("suggests extra empty tabs and stale inactive tabs", () => {
		const suggestions = suggestTabDeletions(
			[
				tab(0, { title: "New Tab" }),
				tab(1, { title: "Another empty tab" }),
				tab(2, {
					url: "https://example.com/old",
					title: "Old page",
					lastActiveAt: "2026-07-01T12:00:00.000Z",
				}),
				tab(3, {
					url: "https://example.com/active",
					title: "Active page",
					lastActiveAt: "2026-08-26T12:00:00.000Z",
				}),
			],
			TAB_IDS[3],
			() => new Date("2026-08-26T12:00:00.000Z"),
		);

		expect(suggestions.map((item) => item.tabId)).toEqual([
			TAB_IDS[1],
			TAB_IDS[2],
		]);
	});

	it("never suggests pinned or active tabs", () => {
		const suggestions = suggestTabDeletions(
			[
				tab(0, {
					url: "https://example.com/a",
					pinned: true,
					lastActiveAt: "2026-07-01T12:00:00.000Z",
				}),
				tab(1, {
					url: "https://example.com/a",
					lastActiveAt: "2026-08-26T12:00:00.000Z",
				}),
			],
			TAB_IDS[1],
		);

		expect(suggestions).toEqual([]);
	});
});
