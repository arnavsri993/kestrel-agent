import { describe, expect, it } from "vitest";
import { isKestrelInternalTabUrl, tabFaviconDataUrl } from "./tab-favicon";

describe("kestrel internal tab urls", () => {
	it("treats app pages and new tabs as Kestrel-owned", () => {
		expect(isKestrelInternalTabUrl(undefined)).toBe(true);
		expect(isKestrelInternalTabUrl("about:blank")).toBe(true);
		expect(isKestrelInternalTabUrl("kestrel://settings")).toBe(true);
		expect(isKestrelInternalTabUrl("kestrel://file/tab-00000000-0000-0000-0000-000000000000")).toBe(
			true,
		);
	});

	it("does not treat normal web pages as Kestrel-owned", () => {
		expect(isKestrelInternalTabUrl("https://example.com")).toBe(false);
	});
});

describe("tab favicon lookup", () => {
	const cached = "data:image/png;base64,CACHED";

	it("uses the durable origin favicon when a sleeping tab has no live image", () => {
		expect(
			tabFaviconDataUrl(
				{ url: "https://example.com/docs", faviconDataUrl: undefined },
				[{ origin: "https://example.com", faviconDataUrl: cached }],
			),
		).toBe(cached);
	});

	it("prefers a live tab favicon over the cached origin value", () => {
		const live = "data:image/png;base64,LIVE";
		expect(
			tabFaviconDataUrl(
				{ url: "https://example.com/docs", faviconDataUrl: live },
				[{ origin: "https://example.com", faviconDataUrl: cached }],
			),
		).toBe(live);
	});

	it("does not use another site's cached favicon", () => {
		expect(
			tabFaviconDataUrl(
				{ url: "https://other.example/docs", faviconDataUrl: undefined },
				[{ origin: "https://example.com", faviconDataUrl: cached }],
			),
		).toBeUndefined();
	});
});
