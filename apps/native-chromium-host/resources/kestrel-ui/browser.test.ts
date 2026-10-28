import { describe, expect, it } from "vitest";
import { InstalledExtensionSchema, UserBrowserStateSchema } from "../../../../packages/shared-types/src/contracts.ts";
import { createBrowserAdapter } from "./browser.mjs";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const uiUrl = `chrome-extension://${extensionId}/index.html`;
const sender = { id: extensionId, url: uiUrl, tab: { id: 91, windowId: 7 } };

function makeChrome() {
	const storage: Record<string, unknown> = {};
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
		storage: { local: {
			get: invoke((key: string) => ({ [key]: storage[key] })),
			set: invoke((value: Record<string, unknown>) => Object.assign(storage, value)),
		} },
		tabs: {
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
		windows: { getLastFocused: invoke(() => ({ id: 7 })), onFocusChanged: event("window-focused") },
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
	return { chrome, tabs, storage };
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
		expect(state.settings.searchEngine).toBe("google");
	});

	it("round-trips internal routes and creates a single correctly encoded search URL", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const initial = await adapter.request({ type: "browser-get-state" }, sender);
		const tabId = initial.browserState.tabs[0].id;
		await adapter.request({ type: "browser-navigate", tabId, input: "kestrel://settings" }, sender);
		expect(tabs[0].url).toBe(`${uiUrl}?app=settings`);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.tabs[0].url).toBe("kestrel://settings");
		await adapter.request({ type: "browser-create-tab", input: "cats and dogs" }, sender);
		expect(tabs.at(-1)?.url).toBe("https://www.google.com/search?q=cats%20and%20dogs");
	});

	it("handles bookmark and download actions without requiring a tab ID", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect((await adapter.request({ type: "browser-remove-bookmark", bookmarkId: state.bookmarks[0].id }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-cancel-download", downloadId: state.downloads[0].id }, sender)).ok).toBe(true);
	});

	it("persists Kestrel Home changes while rejecting unapplied Chromium preferences", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const original = (await adapter.request({ type: "browser-get-state" }, sender)).browserState.settings;
		const homeSettings = { ...original, newTabBackground: "paper" };
		expect((await adapter.request({ type: "browser-update-settings", settings: homeSettings }, sender)).ok).toBe(true);
		const after = UserBrowserStateSchema.parse((await adapter.request({ type: "browser-get-state" }, sender)).browserState);
		expect(after.settings.newTabBackground).toBe("paper");
		expect((await adapter.request({ type: "browser-update-settings", settings: { ...after.settings, searchEngine: "bing" } }, sender)).ok).toBe(false);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.settings.searchEngine).toBe(original.searchEngine);
	});

	it("limits privileged navigation to native settings pages", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		expect((await adapter.request({ type: "browser-create-tab", input: "chrome://extensions/" }, sender)).ok).toBe(true);
		expect(tabs.at(-1)?.url).toBe("chrome://extensions/");
		for (const input of ["chrome://flags/", "file:///Users/test/private", "javascript:alert(1)", "https://user:password@example.com/"]) {
			expect((await adapter.request({ type: "browser-create-tab", input }, sender)).ok).toBe(false);
		}
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
