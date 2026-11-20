import { describe, expect, it } from "vitest";
import { normalizeBrowserPageContext } from "./browser-page-context";

const context = () => ({
	tabId: "tab-00000000-0000-0000-0000-000000000001",
	url: "https://example.com/docs?access_token=fixture-url-secret#token=fixture-fragment-secret",
	title: "Documentation",
	selectedText: "",
	visibleText: "A useful page",
	headings: ["Documentation"],
	links: [],
	forms: [],
	viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0 },
	capturedAt: "2026-10-15T12:00:00.000Z",
	trust: "untrusted_browser",
});

describe("host-independent browser context", () => {
	it("validates the host contract and keeps the untrusted label", () => {
		expect(normalizeBrowserPageContext(context())).toMatchObject({ url: "https://example.com/docs", trust: "untrusted_browser" });
		expect(() => normalizeBrowserPageContext({ ...context(), trust: "trusted" })).toThrow();
		expect(() => normalizeBrowserPageContext({ ...context(), viewport: { width: 0 } })).toThrow();
		expect(() => normalizeBrowserPageContext({ ...context(), url: "file:///private/test" })).toThrow();
	});

	it("redacts credentials from text and URLs before the model receives them", () => {
		const value = normalizeBrowserPageContext({
			...context(),
			visibleText: "password=fixture-password https://example.com/path?session=fixture-session#fixture-fragment",
			links: [
				{ text: "Read documentation", url: "https://example.com/read?code=fixture-oauth" },
				{ text: "Private", url: "https://user:fixture-private@example.com/" },
				{ text: "Local", url: "file:///private/test" },
			],
		});
		expect(value.links).toEqual([{ text: "Read documentation", url: "https://example.com/read" }]);
		expect(JSON.stringify(value)).not.toMatch(/fixture-(?:url-secret|fragment-secret|password|session|fragment|oauth|private)/);
	});

	it("rejects malformed or over-limit host data", () => {
		expect(() => normalizeBrowserPageContext({ ...context(), visibleText: "x".repeat(40_001) })).toThrow();
		expect(() => normalizeBrowserPageContext({ ...context(), links: [{ text: "Bad", url: "invalid" }] })).toThrow();
	});
});
