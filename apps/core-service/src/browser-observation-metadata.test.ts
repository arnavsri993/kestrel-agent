import { describe, expect, it } from "vitest";
import { normalizeBrowserVisibleTabs, normalizeBrowserHistory, normalizeBrowserDownloads } from "./browser-observation-metadata";

const tabId = "tab-00000000-0000-0000-0000-000000000001";
const tab = { id: tabId, title: "Documentation", url: "https://example.com/docs?access_token=fixture-query-secret#fixture-fragment-secret", active: true, loading: false, discarded: false, trust: "untrusted_browser" };
const visit = { id: "visit-00000000-0000-0000-0000-000000000001", tabId, title: "Documentation", url: tab.url, visitedAt: "2026-10-28T12:00:00.000Z" };
const download = { id: "download-00000000-0000-0000-0000-000000000001", filename: "Documentation.pdf", sourceUrl: tab.url, receivedBytes: 12, totalBytes: 12, status: "completed", startedAt: visit.visitedAt, canReveal: false };

describe("Core browser observation metadata boundary", () => {
	it("strips credential-bearing URL data and secret text from tab listings", () => {
		const output = normalizeBrowserVisibleTabs([{ ...tab, title: "password=fixture-title-secret", unknown: "fixture-unknown-secret" },
			{ ...tab, url: "about:blank" }, { ...tab, url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html" },
			{ ...tab, url: "https://user:fixture-credential-secret@example.com/" }]);
		expect(output).toHaveLength(2);
		expect(output.map(tab => tab.url)).toEqual(["https://example.com/docs", "about:blank"]);
		expect(output[0]?.trust).toBe("untrusted_browser");
		expect(JSON.stringify(output)).not.toContain("fixture-");
	});

	it("sanitizes history entries independently of the host implementation", () => {
		const output = normalizeBrowserHistory({ entries: [{ ...visit, title: "Read https://example.com/docs?session=fixture-title-secret" }, { ...visit, url: "file:///private/fixture-private-secret" }], trust: "untrusted_browser" });
		expect(output.entries).toHaveLength(1);
		expect(output.entries[0]).toMatchObject({ url: "https://example.com/docs", title: "Read https://example.com/docs" });
		expect(JSON.stringify(output)).not.toContain("fixture-");
	});

	it("bounds downloads and redacts their source, filename, and reputation text", () => {
		const output = normalizeBrowserDownloads({ downloads: [{ ...download, filename: "api_key=fixture-filename-secret", reputation: { verdict: "unknown", provider: "https://example.com/?token=fixture-provider-secret", threatTypes: [], checkedAt: visit.visitedAt } }, { ...download, sourceUrl: "https://user:fixture-private-secret@example.com/" }], trust: "untrusted_browser" });
		expect(output.downloads).toHaveLength(1);
		expect(output.downloads[0]).toMatchObject({ sourceUrl: "https://example.com/docs", reputation: { provider: "https://example.com/" } });
		expect(JSON.stringify(output)).not.toContain("fixture-");
	});

	it("rejects malformed host contracts without reflecting their contents in errors", () => {
		for (const run of [
			() => normalizeBrowserVisibleTabs([{ ...tab, id: "fixture-malformed-secret" }]),
			() => normalizeBrowserHistory([{ ...visit }]),
			() => normalizeBrowserDownloads({ downloads: [download], trust: "fixture-trusted-secret" }),
			() => normalizeBrowserVisibleTabs(Array(1_001).fill(tab)),
			() => normalizeBrowserHistory({ entries: Array(101).fill(visit), trust: "untrusted_browser" }),
			() => normalizeBrowserDownloads({ downloads: Array(501).fill(download), trust: "untrusted_browser" }),
		]) expect(run).toThrow("The browser returned invalid observation metadata.");
	});
});
