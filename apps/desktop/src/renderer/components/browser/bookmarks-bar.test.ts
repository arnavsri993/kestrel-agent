import { describe, expect, it } from "vitest";
import {
	bookmarkBarGlyph,
	bookmarkBarLabel,
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

	it("ignores invalid bookmark URLs", () => {
		expect(hostnameFromBookmarkUrl("not a url")).toBe("");
	});
});
