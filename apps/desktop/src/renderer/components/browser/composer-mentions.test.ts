import { describe, expect, it } from "vitest";
import {
	composerMentions,
	mentionQuery,
	replaceMention,
} from "./composer-mentions";

describe("composer mentions", () => {
	it("detects an @ query at the cursor", () => {
		expect(mentionQuery("Look at @tab")).toBe("tab");
		expect(mentionQuery("plain text")).toBeNull();
	});

	it("replaces the active mention", () => {
		expect(replaceMention("Use @fi", "README.md")).toBe("Use README.md ");
	});

	it("ranks open tabs, bookmarks, and files", () => {
		const mentions = composerMentions({
			query: "doc",
			tabs: [
				{
					id: "tab-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
					title: "Docs",
					url: "https://docs.example/",
					loading: false,
					canGoBack: false,
					canGoForward: false,
					discarded: false,
					crashed: false,
					pinned: false,
					muted: false,
					createdAt: "2026-08-19T12:00:00.000Z",
					lastActiveAt: "2026-08-19T12:00:00.000Z",
				},
			],
			bookmarks: [],
			files: [
				{
					path: "/tmp/project/README.md",
					name: "README.md",
					mediaType: "text/markdown",
					size: 12,
				},
			],
		});
		expect(mentions.map((item) => item.kind)).toEqual(["tab"]);
		expect(
			composerMentions({
				query: "read",
				tabs: [],
				bookmarks: [],
				files: [
					{
						path: "/tmp/project/README.md",
						name: "README.md",
						mediaType: "text/markdown",
						size: 12,
					},
				],
			}).map((item) => item.kind),
		).toEqual(["file"]);
	});
});
