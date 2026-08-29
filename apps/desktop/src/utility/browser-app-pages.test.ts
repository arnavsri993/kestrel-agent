import { describe, expect, it } from "vitest";
import {
	isKestrelAppPageUrl,
	kestrelAppPageUrl,
	parseKestrelAppPage,
	parseKestrelFilePage,
} from "./browser-app-pages";

describe("kestrel app page URLs", () => {
	it("accepts the product pages used as browser tabs", () => {
		expect(parseKestrelAppPage("kestrel://settings")).toEqual({
			id: "settings",
			url: "kestrel://settings",
			title: "Settings",
		});
		expect(parseKestrelAppPage("kestrel://history/")).toEqual({
			id: "history",
			url: "kestrel://history",
			title: "History",
		});
		expect(kestrelAppPageUrl("commands")).toBe("kestrel://commands");
		expect(isKestrelAppPageUrl("kestrel://downloads")).toBe(true);
		expect(parseKestrelAppPage("kestrel://projects")).toEqual({
			id: "projects",
			url: "kestrel://projects",
			title: "Projects",
		});
		expect(parseKestrelAppPage("kestrel://bookmarks")).toEqual({
			id: "bookmarks",
			url: "kestrel://bookmarks",
			title: "Bookmarks",
		});
	});

	it("rejects unknown, privileged, or credential-bearing kestrel URLs", () => {
		expect(parseKestrelAppPage("kestrel://unknown")).toBeUndefined();
		expect(parseKestrelAppPage("kestrel://settings/privacy")).toBeUndefined();
		expect(parseKestrelAppPage("kestrel://user:secret@settings")).toBeUndefined();
		expect(parseKestrelAppPage("https://settings")).toBeUndefined();
		expect(isKestrelAppPageUrl("javascript:alert(1)")).toBe(false);
	});

	it("parses opaque file tabs without accepting path or query data", () => {
		expect(
			parseKestrelFilePage(
				"kestrel://file/tab-00000000-0000-0000-0000-000000000000",
			),
		).toEqual({
			tabId: "tab-00000000-0000-0000-0000-000000000000",
			url: "kestrel://file/tab-00000000-0000-0000-0000-000000000000",
		});
		expect(
			parseKestrelFilePage(
				"kestrel://file/tab-00000000-0000-0000-0000-000000000000?path=/etc/passwd",
			),
		).toBeUndefined();
	});
});
