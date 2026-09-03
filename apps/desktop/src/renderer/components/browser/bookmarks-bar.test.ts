import { describe, expect, it } from "vitest";
import {
	bookmarkBarFaviconDataUrl,
	bookmarkBarGlyph,
	bookmarkBarLabel,
	bookmarkBarDisplayLabel,
	hostnameFromBookmarkUrl,
} from "./bookmarks-bar";

describe("bookmarks bar labels", () => {
	it("prefers the page title over the raw URL", () => {
		expect(
			bookmarkBarLabel("Kestrel docs", "https://docs.kestrel.example/start"),
		).toBe("Kestrel docs");
	});

	it("falls back to a hostname when the title is empty or just the URL", () => {
		expect(bookmarkBarLabel("", "https://www.example.com/path")).toBe(
			"example.com",
		);
		expect(
			bookmarkBarLabel(
				"https://www.example.com/path",
				"https://www.example.com/path",
			),
		).toBe("example.com");
	});

	it("truncates long titles without overflowing the bar", () => {
		expect(
			bookmarkBarLabel(
				"A very long bookmark title that should compress",
				"https://example.com",
				12,
			),
		).toBe("A very long…");
	});

	it("uses a stable glyph from the visible label", () => {
		expect(bookmarkBarGlyph("Kestrel docs", "https://example.com")).toBe("K");
		expect(bookmarkBarGlyph("", "https://www.example.com")).toBe("E");
	});

	it("uses the selected presentation mode for the bar label", () => {
		expect(
			bookmarkBarDisplayLabel(
				"Kestrel docs",
				"https://docs.example/guide",
				"full",
			),
		).toBe("https://docs.example/guide");
		expect(
			bookmarkBarDisplayLabel(
				"Kestrel docs",
				"https://docs.example/guide",
				"icon",
			),
		).toBe("");
	});

	it("uses the cached favicon for a bookmarked page origin", () => {
		expect(
			bookmarkBarFaviconDataUrl("https://example.com/docs", [
				{
					origin: "https://example.com",
					faviconDataUrl: "data:image/png;base64,EXAMPLE",
				},
			]),
		).toBe("data:image/png;base64,EXAMPLE");
		expect(
			bookmarkBarFaviconDataUrl(
				"https://example.com/docs",
				[
					{
						origin: "https://example.com",
						faviconDataUrl: "data:image/png;base64,ORIGIN",
					},
				],
				"data:image/png;base64,BOOKMARK",
			),
		).toBe("data:image/png;base64,BOOKMARK");
	});

	it("does not borrow a favicon from another origin", () => {
		expect(
			bookmarkBarFaviconDataUrl("https://other.example/docs", [
				{
					origin: "https://example.com",
					faviconDataUrl: "data:image/png;base64,EXAMPLE",
				},
			]),
		).toBeUndefined();
	});

	it("ignores invalid bookmark URLs", () => {
		expect(hostnameFromBookmarkUrl("not a url")).toBe("");
	});
});
