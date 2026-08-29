import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RendererRequestSchema,
	UserBrowserSettingsSchema,
	UserBrowserTabOrganizationApplySchema,
	UserBrowserTabOrganizationPreviewSchema,
} from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import {
	BrowserTabStore,
	createEmptyBrowserTab,
	describeBrowserLoadFailure,
	freshBrowserState,
	MAX_ORIGIN_FAVICONS,
	normalizeBrowserAddress,
	redactUntrustedBrowserText,
	sanitizeBrowserUrl,
	sanitizeUntrustedBrowserValue,
	upsertOriginFavicon,
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
	const state = freshBrowserState();
	expect(state.settings.searchEngine).toBe("google");
	expect(state.settings.showBookmarksBar).toBe(true);
	expect(state.settings.paymentAutofillEnabled).toBe(true);
	expect(state.settings.newTabGreetingActivity.days).toEqual([]);
	expect(state.tabFolders).toEqual([]);
	expect(UserBrowserSettingsSchema.parse({}).searchEngine).toBe("google");
	expect(UserBrowserSettingsSchema.parse({}).showBookmarksBar).toBe(true);
	expect(UserBrowserSettingsSchema.parse({}).addressBarSuggestionsEnabled).toBe(true);
	expect(UserBrowserSettingsSchema.parse({}).paymentAutofillEnabled).toBe(true);
});

it("accepts bundled backgrounds and bounded local image data", () => {
	const custom = UserBrowserSettingsSchema.safeParse({
		newTabBackground: "custom",
		newTabBackgroundCustomDataUrl: "data:image/png;base64,AAAA",
	});

	expect(custom.success).toBe(true);
	expect(
		UserBrowserSettingsSchema.safeParse({
			newTabBackground: "mountains",
		}).success,
	).toBe(true);
	expect(
		UserBrowserSettingsSchema.safeParse({
			newTabBackground: "custom",
			newTabBackgroundCustomDataUrl: "file:///tmp/private.png",
		}).success,
	).toBe(false);
});

it("persists only the bounded New Tab presence aggregate", () => {
	const path = storePath();
	const store = new BrowserTabStore(path);
	const state = freshBrowserState();
	state.settings.newTabGreetingActivity = {
		version: 1,
		days: [
			{
				day: "2026-08-23",
				visits: 3,
				buckets: {
					"late-night": 0,
					"early-morning": 3,
					morning: 0,
					afternoon: 0,
					evening: 0,
				},
			},
		],
	};
	store.save(state);

	expect(store.load().settings.newTabGreetingActivity).toEqual(
		state.settings.newTabGreetingActivity,
	);
	expect(readFileSync(path, "utf8")).not.toMatch(
		/example\.com|Project notes|https?:\/\/|@/i,
	);
});

it("redacts embedded URLs from untrusted browser text", () => {
	expect(
		redactUntrustedBrowserText(
			"Open https://example.com/path?token=secret",
			500,
		),
	).toBe("Open https://example.com/path");
	expect(
		sanitizeUntrustedBrowserValue({
			name: { value: "javascript:alert(1)" },
		}),
	).toEqual({ name: { value: "[redacted URL]" } });
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

	it("blocks unsafe custom search engine templates", () => {
		expect(() =>
			normalizeBrowserAddress("kestrel docs", "custom", "javascript:alert(1)"),
		).toThrow("HTTP or HTTPS");
		expect(() =>
			normalizeBrowserAddress(
				"kestrel docs",
				"custom",
				"https://search:secret@example.com/?q=",
			),
		).toThrow("embedded credentials");
		expect(
			normalizeBrowserAddress(
				"kestrel docs",
				"custom",
				"https://kagi.com/search?q=%s",
			).url,
		).toBe("https://kagi.com/search?q=kestrel%20docs");
	});

	it("maps browser load failures to actionable copy", () => {
		expect(describeBrowserLoadFailure(-105, "ERR_NAME_NOT_RESOLVED")).toMatch(
			/could not be found/i,
		);
		expect(describeBrowserLoadFailure(-106)).toMatch(/offline/i);
		expect(describeBrowserLoadFailure(-118)).toMatch(/timed out/i);
		expect(
			describeBrowserLoadFailure(0, "net::ERR_INTERNET_DISCONNECTED"),
		).toMatch(/offline/i);
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
	it("persists and restores more than 32 open tabs", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));

		for (let index = 1; index < 40; index += 1) {
			const tab = createEmptyBrowserTab(
				() => new Date("2026-08-11T12:00:00.000Z"),
			);
			tab.title = `Tab ${index}`;
			tab.url = `https://tab-${index}.example/`;
			state.tabs.push(tab);
		}

		store.save(state);

		expect(store.load().tabs).toHaveLength(40);
		expect(
			(JSON.parse(readFileSync(path, "utf8")) as { tabs: unknown[] }).tabs,
		).toHaveLength(40);
		expect(
			UserBrowserTabOrganizationPreviewSchema.safeParse({
				tabs: state.tabs,
				tabFolders: [],
			}).success,
		).toBe(true);
		const organization = {
			tabOrder: state.tabs.map((tab) => tab.id),
			assignments: state.tabs.map((tab) => ({ tabId: tab.id })),
			tabFolders: [],
		};
		expect(UserBrowserTabOrganizationApplySchema.safeParse(organization).success).toBe(
			true,
		);
		expect(
			RendererRequestSchema.safeParse({
				type: "browser-move-tab",
				tabId: state.tabs[0]!.id,
				toIndex: 39,
			}).success,
		).toBe(true);
		expect(
			RendererRequestSchema.safeParse({
				type: "browser-apply-tab-organization",
				...organization,
			}).success,
		).toBe(true);
	});

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

		const saved = JSON.parse(readFileSync(path, "utf8")) as {
			tabs: Array<{ faviconDataUrl?: string }>;
		};
		expect(saved.tabs[0]?.faviconDataUrl).toBeUndefined();
		expect(store.load().tabs[0]).toMatchObject({
			title: "Kestrel",
			url: "https://example.com/",
			loading: false,
			canGoBack: false,
			discarded: true,
			error: undefined,
		});
	});

	it("persists origin favicons for frequent tabs without keeping tab favicons", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.tabs[0] = {
			...state.tabs[0]!,
			url: "https://example.com/",
			faviconDataUrl: "data:image/png;base64,TAB",
		};
		state.originFavicons = [
			{
				origin: "https://example.com",
				faviconDataUrl: "data:image/png;base64,ORIGIN",
				updatedAt: "2026-08-11T12:00:00.000Z",
			},
		];
		store.save(state);

		const saved = JSON.parse(readFileSync(path, "utf8")) as {
			tabs: Array<{ faviconDataUrl?: string }>;
			originFavicons: Array<{ origin: string; faviconDataUrl: string }>;
		};
		expect(saved.tabs[0]?.faviconDataUrl).toBeUndefined();
		expect(saved.originFavicons).toEqual([
			{
				origin: "https://example.com",
				faviconDataUrl: "data:image/png;base64,ORIGIN",
				updatedAt: "2026-08-11T12:00:00.000Z",
			},
		]);
		expect(store.load().originFavicons).toEqual(saved.originFavicons);
	});

	it("persists recently closed tabs without retaining sensitive URL data", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.recentlyClosedTabs = [
			{
				title: "Open https://example.com/private?token=secret",
				url: "https://example.com/callback?q=browser&code=do-not-store",
				closedAt: "2026-08-11T12:00:00.000Z",
			},
		];

		store.save(state);

		expect(store.load().recentlyClosedTabs).toEqual([
			{
				title: "Open https://example.com/private",
				url: "https://example.com/callback?q=browser",
				closedAt: "2026-08-11T12:00:00.000Z",
			},
		]);
		const persisted = readFileSync(path, "utf8");
		expect(persisted).not.toContain("do-not-store");
		expect(persisted).not.toContain("token=secret");
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

	it("persists tab folders with their tab assignments", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		const folderId = "tab-folder-00000000-0000-0000-0000-000000000001";
		state.tabs[0] = {
			...state.tabs[0]!,
			url: "https://github.com/kestrel/app",
			title: "Kestrel repository",
			tabFolderId: folderId,
		};
		state.tabFolders = [
			{
				id: folderId,
				name: "Development",
				color: "teal",
				createdAt: "2026-08-11T12:00:00.000Z",
			},
		];

		store.save(state);

		expect(store.load()).toMatchObject({
			tabFolders: state.tabFolders,
			tabs: [{ tabFolderId: folderId }],
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
			showBookmarksBar: true,
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

	it("persists per-layout widget choices and fails closed for a future payload", () => {
		const path = storePath();
		const store = new BrowserTabStore(path);
		const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
		state.settings.newTabWidgets = {
			version: 1,
			enabled: ["frequent-tabs", "quick-actions"],
			layouts: {
				standard: {
					customized: true,
					items: [
						{ id: "quick-actions", size: "large" },
						{ id: "frequent-tabs", size: "small" },
					],
				},
			},
		};
		store.save(state);
		expect(store.load().settings.newTabWidgets).toEqual(
			state.settings.newTabWidgets,
		);

		const malformed = JSON.parse(readFileSync(path, "utf8"));
		malformed.settings.newTabWidgets = {
			version: 2,
			enabled: ["not-a-widget"],
			layouts: { standard: { items: [{ id: "not-a-widget", size: "giant" }] } },
		};
		writeFileSync(path, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");
		expect(store.load().settings.newTabWidgets).toMatchObject({
			version: 1,
			enabled: ["frequent-tabs", "recent-work", "recent-memories", "quick-actions"],
			layouts: {},
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
		state.originFavicons = [
			{
				origin: "https://example.com",
				faviconDataUrl: "data:image/png;base64,ORIGIN",
				updatedAt: "2026-08-11T12:00:00.000Z",
			},
		];
		store.save(state);

		const restored = store.load(() => new Date("2026-08-12T12:00:00.000Z"));

		expect(restored.tabs).toHaveLength(1);
		expect(restored.tabs[0]?.url).toBe("");
		expect(restored.history).toHaveLength(1);
		expect(restored.originFavicons).toEqual(state.originFavicons);
	});
});

describe("origin favicon cache", () => {
	it("replaces the same origin and drops the oldest extras", () => {
		const first = upsertOriginFavicon(
			[],
			"https://a.example",
			"data:image/png;base64,A",
			"2026-08-11T12:00:00.000Z",
		);
		const updated = upsertOriginFavicon(
			first,
			"https://a.example",
			"data:image/png;base64,A2",
			"2026-08-11T13:00:00.000Z",
		);
		expect(updated).toEqual([
			{
				origin: "https://a.example",
				faviconDataUrl: "data:image/png;base64,A2",
				updatedAt: "2026-08-11T13:00:00.000Z",
			},
		]);

		let current: ReturnType<typeof upsertOriginFavicon> = [];
		for (let index = 0; index < MAX_ORIGIN_FAVICONS + 3; index += 1) {
			current = upsertOriginFavicon(
				current,
				`https://site-${index}.example`,
				`data:image/png;base64,${index}`,
				"2026-08-11T12:00:00.000Z",
			);
		}
		expect(current).toHaveLength(MAX_ORIGIN_FAVICONS);
		expect(current[0]?.origin).toBe("https://site-3.example");
		expect(current.at(-1)?.origin).toBe(
			`https://site-${MAX_ORIGIN_FAVICONS + 2}.example`,
		);
	});
});
