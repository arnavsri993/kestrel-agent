import type { UserBrowserTab } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { organizeBrowserTabs } from "./browser-tab-folders";

const TAB_IDS = [
	"tab-00000000-0000-0000-0000-000000000001",
	"tab-00000000-0000-0000-0000-000000000002",
	"tab-00000000-0000-0000-0000-000000000003",
	"tab-00000000-0000-0000-0000-000000000004",
	"tab-00000000-0000-0000-0000-000000000005",
	"tab-00000000-0000-0000-0000-000000000006",
	"tab-00000000-0000-0000-0000-000000000007",
] as const;

function tab(
	index: number,
	url: string,
	title: string,
	pinned = false,
): UserBrowserTab {
	const timestamp = "2026-08-26T12:00:00.000Z";
	return {
		id: TAB_IDS[index]!,
		url,
		title,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		discarded: false,
		crashed: false,
		pinned,
		muted: false,
		createdAt: timestamp,
		lastActiveAt: timestamp,
	};
}

describe("organizeBrowserTabs", () => {
	it("groups tabs by meaning in first-seen order instead of alphabetizing them", () => {
		const result = organizeBrowserTabs(
			[
				tab(0, "https://notion.so/team/roadmap", "Project roadmap"),
				tab(1, "https://www.google.com/search?q=browser", "Google Search"),
				tab(2, "https://github.com/kestrel/app", "Kestrel repository"),
				tab(3, "https://notion.so/team/notes", "Meeting notes"),
				tab(4, "https://github.com/kestrel/app/issues", "Issues"),
				tab(5, "https://example.com/one", "Example page"),
				tab(6, "", "New Tab", true),
			],
			() => new Date("2026-08-26T12:30:00.000Z"),
			(() => {
				const ids = [
					"00000000-0000-0000-0000-000000000011",
					"00000000-0000-0000-0000-000000000012",
					"00000000-0000-0000-0000-000000000013",
				];
				return () => ids.shift()!;
			})(),
		);

		expect(result.tabFolders.map((folder) => folder.name)).toEqual([
			"Work",
			"Research",
			"Development",
		]);
		expect(result.tabFolders.map((folder) => folder.color)).toEqual([
			"blue",
			"violet",
			"teal",
		]);
		expect(result.tabs.map((candidate) => candidate.id)).toEqual([
			TAB_IDS[6],
			TAB_IDS[0],
			TAB_IDS[3],
			TAB_IDS[1],
			TAB_IDS[2],
			TAB_IDS[4],
			TAB_IDS[5],
		]);
		expect(result.tabs[0]?.tabFolderId).toBeUndefined();
		expect(result.tabs.at(-1)?.tabFolderId).toBeUndefined();
		expect(result.tabs[1]?.tabFolderId).toBe(result.tabFolders[0]?.id);
		expect(result.tabs[2]?.tabFolderId).toBe(result.tabFolders[0]?.id);
		expect(result.tabFolders[0]?.createdAt).toBe("2026-08-26T12:30:00.000Z");
	});

	it("creates a site folder only when an otherwise unknown site has multiple tabs", () => {
		const result = organizeBrowserTabs([
			tab(0, "https://docs.example.test/one", "First document"),
			tab(1, "https://docs.example.test/two", "Second document"),
			tab(2, "https://single.example.test", "One-off page"),
		]);

		expect(result.tabFolders).toHaveLength(1);
		expect(result.tabFolders[0]?.name).toBe("Example");
		expect(result.tabs.slice(0, 2).every((candidate) => candidate.tabFolderId)).toBe(
			true,
		);
		expect(result.tabs[2]?.tabFolderId).toBeUndefined();
	});
});
