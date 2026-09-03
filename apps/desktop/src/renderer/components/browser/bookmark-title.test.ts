import { describe, expect, it } from "vitest";
import { recommendedBookmarkTitle } from "./bookmark-title";

describe("recommended bookmark titles", () => {
	it("removes a trailing site brand from a page title", () => {
		expect(
			recommendedBookmarkTitle(
				"https://docs.kestrel.example/getting-started",
				"Getting started | Kestrel",
			),
		).toBe("Getting started");
	});

	it("falls back to a readable hostname when a page has no title", () => {
		expect(
			recommendedBookmarkTitle("https://kestrel-docs.example/", "https://kestrel-docs.example/"),
		).toBe("Kestrel Docs");
	});

	it("collapses whitespace without inventing page content", () => {
		expect(
			recommendedBookmarkTitle("https://example.com/guide", "  A   useful   guide  "),
		).toBe("A useful guide");
	});
});
