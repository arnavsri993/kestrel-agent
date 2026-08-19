import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserBrowserSettingsSchema } from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import {
	BrowserTabStore,
	freshBrowserState,
	normalizeBrowserAddress,
	sanitizeBrowserUrl,
} from "./browser-tab-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function storePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-browser-store-"));
	temporaryDirectories.push(directory);
	return join(directory, "browser-state.json");
}

it("defaults new browser settings to Google", () => {
	expect(freshBrowserState().settings.searchEngine).toBe("google");
	expect(UserBrowserSettingsSchema.parse({}).searchEngine).toBe("google");
});

describe("browser address normalization", () => {
	it("navigates hosts and searches ordinary language with Google as default", () => {
		expect(normalizeBrowserAddress("example.com/docs")).toEqual({
			kind: "url",
			url: "https://example.com/docs",
		});
		expect(normalizeBrowserAddress("localhost:5173")).toEqual({
			kind: "url",
			url: "http://localhost:5173/",
		});
		expect(normalizeBrowserAddress("quiet browser design")).toEqual({
			kind: "search",
			url: "https://www.google.com/search?q=quiet%20browser%20design",
		});
	});

	it("supports custom search engine URL templates", () => {
		expect(
			normalizeBrowserAddress(
				"kestrel agent",
				"custom",
				"https://kagi.com/search?q=%s",
			),
		).toEqual({
			kind: "search",
			url: "https://kagi.com/search?q=kestrel%20agent",
		});

		expect(
			normalizeBrowserAddress(
				"custom query",
				"custom",
				"https://myintranet.corp/find",
			),
		).toEqual({
			kind: "search",
			url: "https://myintranet.corp/find?q=custom%20query",
		});
	});

	it("respects the selected search engine", () => {
		const searches = {
			duckduckgo: "https://duckduckgo.com/?q=kestrel%20browser",
			google: "https://www.google.com/search?q=kestrel%20browser",
			bing: "https://www.bing.com/search?q=kestrel%20browser",
			brave: "https://search.brave.com/search?q=kestrel%20browser",
			ecosia: "https://www.ecosia.org/search?q=kestrel%20browser",
			startpage: "https://www.startpage.com/sp/search?query=kestrel%20browser",
			yahoo: "https://search.yahoo.com/search?p=kestrel%20browser",
			kagi: "https://kagi.com/search?q=kestrel%20browser",
			qwant: "https://www.qwant.com/?q=kestrel%20browser",
			mojeek: "https://www.mojeek.com/search?q=kestrel%20browser",
			baidu: "https://www.baidu.com/s?wd=kestrel%20browser",
			yandex: "https://yandex.com/search/?text=kestrel%20browser",
		} as const;

		for (const [engine, url] of Object.entries(searches))
			expect(
				normalizeBrowserAddress(
					"kestrel browser",
					engine as keyof typeof searches,
				).url,
			).toBe(url);
	});

	it("accepts only supported search engines and tab layouts", () => {
		const base = {
			searchEngine: "duckduckgo",
			tabLayout: "horizontal",
			restoreSession: true,
			historyRetentionDays: 90,
		};
		const parsed = UserBrowserSettingsSchema.safeParse(base);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.newTabBackground).toBe("graphite");
		expect(
			UserBrowserSettingsSchema.safeParse({ ...base, tabLayout: "stacked" })
				.success,
		).toBe(false);
		expect(
			UserBrowserSettingsSchema.safeParse({ ...base, searchEngine: "unknown" })
				.success,
		).toBe(false);
	});

	it("blocks privileged protocols and credential-bearing URLs", () => {
		expect(() => normalizeBrowserAddress("file:///etc/passwd")).toThrow(
			"HTTP and HTTPS",
		);
		expect(() =>
			normalizeBrowserAddress("https://person:secret@example.com"),
		).toThrow("embedded usernames or passwords");
		expect(() => normalizeBrowserAddress("javascript:alert(1)")).toThrow(
			"HTTP and HTTPS",
		);
	});

	it("redacts credential-like URL values without discarding useful searches", () => {
		expect(
			sanitizeBrowserUrl(
				"https://example.com/callback?q=kestrel&code=secret&access_token=hidden&api_key=private#section",
			),
		).toBe("https://example.com/callback?q=kestrel#section");
		expect(
			sanitizeBrowserUrl(
				"https://example.com/#access_token=hidden&view=summary",
			),
		).toBe("https://example.com/#view=summary");
		expect(sanitizeBrowserUrl("file:///etc/passwd")).toBe("");
		expect(sanitizeBrowserUrl("kestrel://settings")).toBe("kestrel://settings");
		expect(sanitizeBrowserUrl("kestrel://unknown")).toBe("");
	});

	it("allows typed kestrel app pages and still blocks other schemes", () => {
		expect(normalizeBrowserAddress("kestrel://history")).toEqual({
			kind: "url",
			url: "kestrel://history",
		});
		expect(() => normalizeBrowserAddress("kestrel://unknown")).toThrow(
			"HTTP and HTTPS",
		);
	});
});

describe("browser tab persistence", () => {
	it("restores safe tabs as discarded without persisting favicons", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.tabs[0] = {
			...state.tabs[0]!,
			title: "Kestrel",
			url: "https://example.com/",
			faviconDataUrl: "data:image/png;base64,AAAA",
			loading: true,
			canGoBack: true,
			error: "A stale failure",
		};

		store.save(state);

		expect(readFileSync(path, "utf8")).not.toContain("faviconDataUrl");
		expect(store.load().tabs[0]).toMatchObject({
			title: "Kestrel",
			url: "https://example.com/",
			loading: false,
			canGoBack: false,
			discarded: true,
			error: undefined,
		});
	});

	it("restores kestrel app pages without treating them as sleeping web views", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.tabs[0] = {
			...state.tabs[0]!,
			title: "Settings",
			url: "kestrel://settings",
		};
		store.save(state);
		expect(store.load().tabs[0]).toMatchObject({
			title: "Settings",
			url: "kestrel://settings",
			discarded: false,
		});
	});

	it("persists the selected tab layout and migrates legacy settings", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.settings.tabLayout = "vertical";
		state.settings.searchEngine = "ecosia";
		store.save(state);

		expect(store.load().settings).toMatchObject({
			tabLayout: "vertical",
			searchEngine: "ecosia",
		});

		const legacy = JSON.parse(readFileSync(path, "utf8"));
		delete legacy.settings.tabLayout;
		writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
		expect(store.load().settings).toMatchObject({
			tabLayout: "horizontal",
			searchEngine: "ecosia",
			newTabBackground: "graphite",
		});
	});

	it("does not persist credential-like URL parameters", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.tabs[0]!.url =
			"https://example.com/callback?q=browser&code=do-not-store";
		state.history.push({
			id: "visit-00000000-0000-4000-8000-000000000000",
			tabId: state.tabs[0]!.id,
			url: "https://example.com/callback?q=browser&session_token=secret",
			title: "Callback",
			visitedAt: "2026-08-11T12:00:00.000Z",
		});

		store.save(state);

		const persisted = readFileSync(path, "utf8");
		expect(persisted).toContain("q=browser");
		expect(persisted).not.toContain("do-not-store");
		expect(persisted).not.toContain("session_token");
	});

	it("fails closed to a fresh tab when state is corrupt", () => {
		const path = storePath();
		writeFileSync(path, "{not json", "utf8");

		const state = new BrowserTabStore(path).load(
			() => new Date("2026-08-11T12:00:00.000Z"),
		);

		expect(state.tabs).toHaveLength(1);
		expect(state.tabs[0]?.title).toBe("New Tab");
		expect(state.history).toEqual([]);
	});

	it("keeps history but starts blank when session restore is disabled", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.settings.restoreSession = false;
		state.history.push({
			id: "visit-00000000-0000-4000-8000-000000000000",
			tabId: state.tabs[0]!.id,
			url: "https://example.com/",
			title: "Example",
			visitedAt: "2026-08-11T12:00:00.000Z",
		});
		store.save(state);

		const restored = store.load(() => new Date("2026-08-12T12:00:00.000Z"));

		expect(restored.tabs).toHaveLength(1);
		expect(restored.tabs[0]?.url).toBe("");
		expect(restored.history).toHaveLength(1);
	});
});
