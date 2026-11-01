import { describe, expect, it, vi } from "vitest";
import { InstalledExtensionSchema, UserBrowserStateSchema } from "../../../../packages/shared-types/src/contracts.ts";
import { createBrowserAdapter } from "./browser.mjs";
import { NATIVE_BROWSER_SETTINGS_URLS } from "../../../../packages/shared-types/src/native-browser-settings";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const uiUrl = `chrome-extension://${extensionId}/index.html`;
const sender = { id: extensionId, url: uiUrl, tab: { id: 91, windowId: 7 } };

function makeChrome() {
	const storage: Record<string, unknown> = {};
	const session: Record<string, unknown> = {};
	const handlers = new Map<string, (...args: any[]) => void>();
	const event = (name: string) => ({ addListener: (listener: (...args: any[]) => void) => handlers.set(name, listener) });
	const tabs = [
		{ id: 11, windowId: 7, active: true, status: "complete", title: "Home", url: uiUrl },
		{ id: 12, windowId: 7, active: false, status: "complete", title: "Settings", url: `${uiUrl}?app=settings` },
	];
	const bookmarks = [
		{ id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: Date.parse("2026-01-01T00:00:00Z"), children: [
			{ id: "2", parentId: "1", title: "Example", url: "https://example.com/", dateAdded: Date.parse("2026-01-02T00:00:00Z") },
		] },
	];
	const downloads = [{ id: 5, url: "https://example.com/file.zip", filename: "/Users/test/Downloads/file.zip", state: "in_progress", bytesReceived: 4, totalBytes: 10, startTime: "2026-01-02T00:00:00Z" }];
	const invoke = (fn: (...args: any[]) => unknown) => (...args: any[]) => {
		const callback = args.pop();
		try { const result = fn(...args); callback?.(result); return Promise.resolve(result); }
		catch (error) { throw error; }
	};
	const chrome = {
		runtime: { id: extensionId },
		storage: { session: {
			get: invoke((key: string) => ({ [key]: session[key] })),
			set: invoke((value: Record<string, unknown>) => Object.assign(session, value)),
		}, local: {
			get: invoke((key: string) => ({ [key]: storage[key] })),
			set: invoke((value: Record<string, unknown>) => Object.assign(storage, value)),
		} },
		tabs: {
			get: invoke((id: number) => { const tab = tabs.find((item) => item.id === id); if (!tab) throw new Error("Missing tab"); return { ...tab }; }),
			query: invoke((query: Record<string, unknown> = {}) => tabs.filter((tab) =>
				(query.windowId === undefined || tab.windowId === query.windowId) &&
				(query.currentWindow !== true || tab.windowId === 7) &&
				(query.active !== true || tab.active),
			)),
			create: invoke((properties: Record<string, any>) => {
				if (properties.active !== false) for (const tab of tabs) tab.active = false;
				const tab = { id: tabs.reduce((max, item) => Math.max(max, item.id), 0) + 1, windowId: properties.windowId ?? 7, active: properties.active !== false, status: "complete", title: "New Tab", url: properties.url };
				tabs.push(tab); return tab;
			}),
			update: invoke((id: number, properties: Record<string, any>) => {
				const tab = tabs.find((item) => item.id === id)!;
				if (properties.active) for (const other of tabs) if (other.windowId === tab.windowId) other.active = other.id === id;
				Object.assign(tab, properties); return tab;
			}),
			remove: invoke((id: number) => { tabs.splice(tabs.findIndex((tab) => tab.id === id), 1); }),
			goBack: invoke(() => undefined), goForward: invoke(() => undefined), reload: invoke(() => undefined),
			duplicate: invoke((id: number) => { const original = tabs.find((tab) => tab.id === id)!; tabs.push({ ...original, id: Math.max(...tabs.map((tab) => tab.id)) + 1, active: false }); }),
			move: invoke(() => undefined),
			onCreated: event("tab-created"), onRemoved: event("tab-removed"), onActivated: event("tab-activated"),
			onUpdated: event("tab-updated"), onMoved: event("tab-moved"), onAttached: event("tab-attached"), onDetached: event("tab-detached"),
		},
		windows: {
			getLastFocused: invoke(() => ({ id: 7 })),
			getAll: invoke(() => [...new Set(tabs.map(tab => tab.windowId))].map(id => ({ id }))),
			update: invoke((id: number) => ({ id })),
			create: invoke(({ url }: { url: string | string[] }) => {
				const id = 8;
				const urls = Array.isArray(url) ? url : [url];
				for (const [index, address] of urls.entries()) tabs.push({ id: 100 + index, windowId: id, active: index === urls.length - 1, status: "complete", title: "New tab", url: address });
				return { id };
			}),
			onFocusChanged: event("window-focused"),
		},
		search: { query: vi.fn(invoke(({ text, tabId }: { text: string; tabId: number }) => {
			const tab = tabs.find(item => item.id === tabId);
			if (!tab) throw new Error("Missing search tab");
			tab.url = `https://native-provider.example/search?q=${encodeURIComponent(text)}`;
		})) },
		bookmarks: {
			getTree: invoke(() => [{ id: "0", children: bookmarks }]),
			search: invoke((query: { url: string }) => bookmarks.flatMap((folder) => folder.children).filter((item) => item.url === query.url)),
			create: invoke((item: Record<string, unknown>) => { const entry = { ...item, id: "3", parentId: "1", dateAdded: Date.now() }; bookmarks[0].children.push(entry); return entry; }),
			remove: invoke((id: string) => { bookmarks[0].children = bookmarks[0].children.filter((item) => item.id !== id); }),
			onChanged: event("bookmark-changed"), onCreated: event("bookmark-created"), onRemoved: event("bookmark-removed"),
		},
		history: { search: invoke(() => [{ url: "https://example.com/", title: "Example", lastVisitTime: Date.parse("2026-01-03T00:00:00Z") }]), deleteAll: invoke(() => undefined), onVisited: event("history-visited") },
		downloads: { search: invoke(() => downloads), cancel: invoke(() => undefined), onChanged: event("download-changed") },
		management: { getAll: invoke(() => [{ id: "b".repeat(32), type: "extension", name: "Fixture", version: "1.0", enabled: true, installType: "normal" }]) },
	};
	return { chrome, tabs, storage, session };
}

describe("native first-party browser adapter", () => {
	it("returns shared-schema state with stable tab IDs, internal routes, and native collections", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const [first, concurrent] = await Promise.all([
			adapter.request({ type: "browser-get-state" }, sender),
			adapter.request({ type: "browser-get-state" }, sender),
		]);
		expect(first.ok).toBe(true);
		const state = UserBrowserStateSchema.parse(first.browserState);
		expect(state.tabs.map((tab) => tab.url)).toEqual(["", "kestrel://settings"]);
		expect(state.tabs.map((tab) => tab.id)).toEqual(concurrent.browserState.tabs.map((tab: any) => tab.id));
		expect(new Set(state.tabs.map((tab) => tab.id)).size).toBe(2);
		expect(state.bookmarks[0]?.id).toMatch(/^bookmark-[a-f0-9-]{36}$/);
		expect(state.bookmarkFolders[0]?.id).toMatch(/^bookmark-folder-[a-f0-9-]{36}$/);
		expect(state.downloads[0]?.id).toMatch(/^download-[a-f0-9-]{36}$/);
		expect(state.bookmarks[0]?.id).toBe(concurrent.browserState.bookmarks[0]?.id);
		expect(state.downloads[0]?.id).toBe(concurrent.browserState.downloads[0]?.id);
		expect(state.settingsOwnership).toBe("chromium");
	});

	it("round-trips internal routes and delegates each search to Chromium's selected provider in the exact tab", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const initial = await adapter.request({ type: "browser-get-state" }, sender);
		const tabId = initial.browserState.tabs[0].id;
		await adapter.request({ type: "browser-navigate", tabId, input: "kestrel://settings" }, sender);
		expect(tabs[0].url).toBe(`${uiUrl}?app=settings`);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.tabs[0].url).toBe("kestrel://settings");
		await adapter.request({ type: "browser-create-tab", input: "cats and dogs" }, sender);
		expect(tabs.at(-1)?.url).toBe("https://native-provider.example/search?q=cats%20and%20dogs");
		expect(chrome.search.query.mock.calls[0]?.[0]).toEqual({ text: "cats and dogs", tabId: tabs.at(-1)?.id });
		await adapter.request({ type: "browser-navigate", tabId, input: "one & two" }, sender);
		expect(tabs[0].url).toBe("https://native-provider.example/search?q=one%20%26%20two");
		expect(chrome.search.query.mock.calls[1]?.[0]).toEqual({ text: "one & two", tabId: 11 });
	});
	it("fails unavailable search before creating a tab and never substitutes a provider", async () => {
		const { chrome, tabs } = makeChrome();
		delete (chrome as any).search;
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		expect(await adapter.request({ type: "browser-create-tab", input: "private query" }, sender)).toMatchObject({ ok: false, error: expect.stringContaining("Native search is unavailable") });
		expect(tabs).toHaveLength(2);
	});

	it("handles bookmark and download actions without requiring a tab ID", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect((await adapter.request({ type: "browser-remove-bookmark", bookmarkId: state.bookmarks[0].id }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-cancel-download", downloadId: state.downloads[0].id }, sender)).ok).toBe(true);
	});

	it("persists Kestrel Home changes while rejecting unapplied Chromium preferences", async () => {
		const { chrome, storage } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const original = (await adapter.request({ type: "browser-get-state" }, sender)).browserState.settings;
		const homeSettings = { ...original, newTabBackground: "paper" };
		expect((await adapter.request({ type: "browser-update-settings", settings: homeSettings }, sender)).ok).toBe(true);
		const after = UserBrowserStateSchema.parse((await adapter.request({ type: "browser-get-state" }, sender)).browserState);
		expect(after.settings.newTabBackground).toBe("paper");
		expect((await adapter.request({ type: "browser-update-settings", settings: { ...after.settings, searchEngine: "bing" } }, sender)).ok).toBe(false);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.settings.searchEngine).toBe(original.searchEngine);
		const image = "data:image/png;base64,aGVsbG8=";
		expect((await adapter.request({ type: "browser-update-settings", settings: { ...after.settings, newTabBackground: "custom", newTabBackgroundCustomDataUrl: image, newTabShortcuts: [{ title: "Example", url: "https://example.com/" }] } }, sender)).ok).toBe(true);
		expect(storage["kestrel.native.browser.settings.v1"]).toMatchObject({ newTabBackground: "custom", newTabBackgroundCustomDataUrl: image, newTabShortcuts: [{ title: "Example", url: "https://example.com/" }] });
		expect(storage["kestrel.native.browser.settings.v1"]).not.toHaveProperty("searchEngine");
		const restored = createBrowserAdapter(chrome, { uiUrl });
		const saved = (await restored.request({ type: "browser-get-state" }, sender)).browserState.settings;
		expect(saved.newTabBackgroundCustomDataUrl).toBe(image);
		expect((await restored.request({ type: "browser-update-settings", settings: { ...saved, newTabBackground: "graphite", newTabBackgroundCustomDataUrl: undefined } }, sender)).ok).toBe(true);
		expect((await restored.request({ type: "browser-get-state" }, sender)).browserState.settings).not.toHaveProperty("newTabBackgroundCustomDataUrl");
	});

	it("limits privileged navigation to native settings pages", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		for (const input of NATIVE_BROWSER_SETTINGS_URLS) {
			expect((await adapter.request({ type: "browser-create-tab", input }, sender)).ok).toBe(true);
			expect(tabs.at(-1)?.url).toBe(input);
		}
		for (const input of ["chrome://flags/", "chrome://settings/?injected=1", "chrome://settings/../flags", "chrome://settings/search#extra", "file:///Users/test/private", "javascript:alert(1)", "https://user:password@example.com/"]) {
			expect((await adapter.request({ type: "browser-create-tab", input }, sender)).ok).toBe(false);
		}
	});
	it("opens an OS link in the existing normal browser window and rejects privileged or credentialed input", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const result = await adapter.openExternalUrl("https://example.com/from-system?q=1#part");
		expect(result).toMatchObject({ tabId: expect.any(Number), windowId: 7 });
		expect(tabs.at(-1)).toMatchObject({ windowId: 7, active: true, url: "https://example.com/from-system?q=1#part" });
		const count = tabs.length;
		for (const value of ["a search", "example.com", "chrome://settings/", "kestrel://settings", "https://user:secret@example.com/", "https://example.com/\n", "https://example.com/" + "x".repeat(8192)])
			await expect(adapter.openExternalUrl(value)).rejects.toThrow();
		expect(tabs).toHaveLength(count);
	});
	it("keeps restored Home duplicates and public tabs while removing only the owned marker", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		const originalCreate = chrome.windows.create;
		chrome.windows.create = vi.fn((properties: any, callback: any) => {
			expect(properties.url).toMatch(/^about:blank#kestrel-window-[a-f0-9-]+$/);
			const result = originalCreate(properties, callback);
			tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Restored Home", url: uiUrl });
			tabs.push({ id: 202, windowId: 8, active: false, status: "complete", title: "Another Home", url: uiUrl });
			tabs.push({ id: 203, windowId: 8, active: false, status: "complete", title: "Website", url: "https://example.com/" });
			tabs.push({ id: 204, windowId: 8, active: false, status: "complete", title: "Blank", url: "about:blank" });
			return result;
		}) as any;
		const result = await createBrowserAdapter(chrome, { uiUrl }).openNativeWindow();
		expect(result).toEqual({ windowId: 8, tabId: 201 });
		expect(chrome.windows.create).toHaveBeenCalledOnce();
		expect(tabs.map(tab => tab.id)).toEqual([201, 202, 203, 204]);
		expect(tabs[0].active).toBe(true);
	});

	it("converts only the owned marker when no Home is restored", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		vi.useFakeTimers();
		try {
			const originalCreate = chrome.windows.create;
			chrome.windows.create = vi.fn((properties: any, callback: any) => {
				const result = originalCreate(properties, callback);
				tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Blank", url: "about:blank" });
				return result;
			}) as any;
			const opening = createBrowserAdapter(chrome, { uiUrl }).openNativeWindow();
			await vi.runAllTimersAsync();
			expect(await opening).toEqual({ windowId: 8, tabId: 100 });
			expect(tabs.map(tab => tab.url)).toEqual([uiUrl, "about:blank"]);
			expect(chrome.windows.create).toHaveBeenCalledOnce();
		} finally { vi.useRealTimers(); }
	});

	it("leaves a marker that a user navigated untouched and reports uncertainty", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		const originalCreate = chrome.windows.create;
		chrome.windows.create = ((properties: any, callback: any) => {
			const result = originalCreate(properties, callback);
			tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Home", url: uiUrl });
			return result;
		}) as any;
		const originalGet = chrome.tabs.get;
		chrome.tabs.get = ((id: number, callback: any) => {
			if (id === 100) tabs.find(tab => tab.id === 100)!.url = "https://example.com/changed";
			return originalGet(id, callback);
		}) as any;
		await expect(createBrowserAdapter(chrome, { uiUrl }).openNativeWindow()).rejects.toThrow(/changed.*Check Kestrel/);
		expect(tabs.map(tab => tab.url)).toEqual(["https://example.com/changed", uiUrl]);
	});

	it("does not treat a different extension or an app route as Kestrel Home", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		vi.useFakeTimers();
		try {
			const originalCreate = chrome.windows.create;
			chrome.windows.create = ((properties: any, callback: any) => {
				const result = originalCreate(properties, callback);
				tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Other extension", url: `chrome-extension://${"b".repeat(32)}/index.html` });
				tabs.push({ id: 202, windowId: 8, active: false, status: "complete", title: "Settings", url: `${uiUrl}?app=settings` });
				return result;
			}) as any;
			const opening = createBrowserAdapter(chrome, { uiUrl }).openNativeWindow();
			await vi.runAllTimersAsync();
			expect(await opening).toEqual({ windowId: 8, tabId: 100 });
			expect(tabs.map(tab => tab.id)).toEqual([100, 201, 202]);
			expect(tabs[0].url).toBe(uiUrl);
		} finally { vi.useRealTimers(); }
	});

	it("lets Chromium create the external tab without adding a duplicate Home to its restored session", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const result = await adapter.openExternalUrl("https://example.com/reopen");
		expect(result).toEqual({ windowId: 8, tabId: 100 });
		expect(tabs.map(tab => tab.url)).toEqual(["https://example.com/reopen"]);
	});
	it("keeps every document tab available without a background UI request changing actual focus", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.push({ id: 13, windowId: 8, active: true, status: "complete", title: "Other window", url: "https://example.com/other" });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const response = await adapter.request({ type: "browser-get-state" }, { ...sender, tab: { id: 13, windowId: 8 } });
		expect(response.browserState.tabs).toHaveLength(3);
		expect(response.browserState.activeTabId).toBe(response.browserState.tabs[0].id);
		expect((await adapter.backend({ operation: "visible-tabs" }))[0]).toMatchObject({ url: "https://example.com/other", active: false });
		expect((await adapter.request({ type: "browser-select-tab", tabId: response.browserState.tabs[2].id }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.activeTabId).toBe(response.browserState.tabs[2].id);
	});

	it("routes Core tools to exact native tabs and excludes protected UI pages", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const initial = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(await adapter.backend({ operation: "visible-tabs" })).toEqual([]);
		const created = await Promise.all([
			adapter.backend({ operation: "visible-create", input: "https://one.example/" }),
			adapter.backend({ operation: "visible-create", input: "https://two.example/" }),
		]);
		expect(new Set(created.map((tab: any) => tab.tabId)).size).toBe(2);
		const visible = await adapter.backend({ operation: "visible-tabs" });
		expect(visible.map((tab: any) => tab.id)).toEqual(created.map((tab: any) => tab.tabId));
		expect(visible.every((tab: any) => tab.trust === "untrusted_browser")).toBe(true);
		await adapter.backend({ operation: "visible-navigate", tabId: created[0].tabId, input: "https://updated.example/" });
		expect(tabs[2].url).toBe("https://updated.example/");
		await expect(adapter.backend({ operation: "visible-close", tabId: initial.tabs[0].id })).rejects.toThrow(/protected/);
		await expect(adapter.backend({ operation: "visible-create", input: "chrome://extensions/" })).rejects.toThrow(/HTTP/);
		await expect(adapter.backend({ operation: "visible-navigate", tabId: created[0].tabId, input: "kestrel://settings" })).rejects.toThrow(/HTTP/);
		await adapter.backend({ operation: "visible-close", tabId: created[0].tabId });
		expect((await adapter.backend({ operation: "visible-tabs" })).map((tab: any) => tab.id)).toEqual([created[1].tabId]);
	});

	it("does not execute a Core operation cancelled before dispatch", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const controller = new AbortController();
		controller.abort();
		await expect(adapter.backend({ operation: "visible-create", input: "https://one.example/" }, controller.signal)).rejects.toThrow();
		expect(tabs).toHaveLength(2);
	});

	it("pins context reads to one main document in Chrome's isolated world", async () => {
		const { chrome, tabs } = makeChrome();
		tabs[0].url = "https://example.com/page?token=private";
		const getFrame = vi.fn(async () => ({ documentId: "document-one", documentLifecycle: "active", url: tabs[0].url }));
		const executeScript = vi.fn(async (options: any) => [{ frameId: 0, documentId: "document-one", result: {
			sourceUrl: tabs[0].url, context: { tabId: options.args[0], url: "https://example.com/page", title: "Example", selectedText: "", visibleText: "Read the page",
				headings: [], links: [], forms: [], viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, capturedAt: new Date().toISOString(), trust: "untrusted_browser" },
		} }]);
		Object.assign(chrome, { webNavigation: { getFrame }, scripting: { executeScript } });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const tabId = (await adapter.backend({ operation: "visible-tabs" }))[0].id;
		const context = await adapter.backend({ operation: "visible-context", tabId });
		expect(context.url).toBe("https://example.com/page");
		expect(executeScript.mock.calls[0][0]).toMatchObject({ target: { tabId: 11, documentIds: ["document-one"] }, world: "ISOLATED", args: [tabId] });
		expect(getFrame).toHaveBeenCalledTimes(2);
		const fromUi = await adapter.request({ type: "browser-get-context", tabId }, sender);
		expect(fromUi).toMatchObject({ ok: true, browserContext: { ...context, capturedAt: expect.any(String) } });
	});

	it("discards context after same-URL navigation and fails before reading protected pages", async () => {
		const { chrome, tabs } = makeChrome();
		const executeScript = vi.fn(async () => [{ frameId: 0, documentId: "document-one", result: { sourceUrl: "https://example.com/", context: {} } }]);
		const getFrame = vi.fn().mockResolvedValueOnce({ documentId: "document-one", documentLifecycle: "active", url: "https://example.com/" })
			.mockResolvedValue({ documentId: "document-two", documentLifecycle: "active", url: "https://example.com/" });
		Object.assign(chrome, { webNavigation: { getFrame }, scripting: { executeScript } });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const protectedId = (await adapter.request({ type: "browser-get-state" }, sender)).browserState.tabs[0].id;
		await expect(adapter.backend({ operation: "visible-context", tabId: protectedId })).rejects.toThrow(/HTTP/);
		expect(executeScript).not.toHaveBeenCalled();
		tabs[0].url = "https://example.com/";
		await expect(adapter.backend({ operation: "visible-context", tabId: protectedId })).rejects.toThrow(/changed while/);
		expect(executeScript).toHaveBeenCalledTimes(1);
	});

	it("does not release a context read cancelled during native script execution", async () => {
		const { chrome, tabs } = makeChrome();
		tabs[0].url = "https://example.com/";
		const controller = new AbortController();
		const getFrame = vi.fn(async () => ({ documentId: "document-one", documentLifecycle: "active", url: tabs[0].url }));
		Object.assign(chrome, { webNavigation: { getFrame }, scripting: { executeScript: async () => { controller.abort(); return []; } } });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		await expect(adapter.backend({ operation: "visible-context" }, controller.signal)).rejects.toThrow();
		expect(getFrame).toHaveBeenCalledTimes(1);
	});

	it("rejects stale tool IDs when Chrome reuses numeric tab IDs after restart", async () => {
		const { chrome, tabs, session } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const opened = await adapter.backend({ operation: "visible-create", input: "https://before.example/" });
		for (const key of Object.keys(session)) delete session[key];
		tabs[2].url = "https://different.example/"; // Same Chrome number in a new session.
		const restarted = createBrowserAdapter(chrome, { uiUrl });
		await expect(restarted.backend({ operation: "visible-close", tabId: opened.tabId })).rejects.toThrow(/no longer open/);
		expect(tabs[2].url).toBe("https://different.example/");
		expect((await restarted.backend({ operation: "visible-tabs" }))[0].id).not.toBe(opened.tabId);
	});

	it("returns the shared installed-extension shape and rejects other extension pages", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const listed = await adapter.request({ type: "browser-list-extensions" }, sender);
		expect(InstalledExtensionSchema.parse(listed.extensions[0]).source).toBe("chrome_web_store");
		expect((await adapter.request({ type: "browser-get-state" }, { ...sender, url: `chrome-extension://${extensionId}/other.html` })).ok).toBe(false);
		expect(adapter.handles("browser-set-content-bounds")).toBe(false);
	});
});
