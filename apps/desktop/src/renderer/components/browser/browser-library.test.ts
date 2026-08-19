import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserHistory, BrowserDownloads } from "./BrowserLibrary";
import type { UserBrowserController } from "../../browser/useUserBrowser";

const fakeBrowser: UserBrowserController = {
	state: {
		tabs: [],
		activeTabId: null,
		history: [
			{
				id: "hist-1",
				tabId: "tab-1",
				url: "https://example.com",
				title: "Example Page",
				visitedAt: "2026-08-16T00:00:00.000Z",
			},
		],
		downloads: [
			{
				id: "download-00000000-0000-0000-0000-000000000001",
				filename: "report.pdf",
				sourceUrl: "https://example.com/report.pdf",
				receivedBytes: 1024,
				totalBytes: 2048,
				status: "completed",
				startedAt: "2026-08-16T00:00:00.000Z",
				canReveal: true,
			},
		],
		settings: {
			searchEngine: "duckduckgo",
			tabLayout: "horizontal",
			newTabBackground: "graphite",
			restoreSession: true,
			historyRetentionDays: 30,
			sleepingTabsEnabled: true,
			sleepingTabTimeoutMinutes: 30,
			sleepingTabExcludedDomains: [],
			memorySaverMode: true,
			offerToSavePasswords: true,
			autofillPasswords: true,
			autofillAddresses: true,
			autofillPayments: true,
		},
	},
	createTab: vi.fn(),
	selectTab: vi.fn(),
	closeTab: vi.fn(),
	reopenClosedTab: vi.fn(),
	navigate: vi.fn(),
	reload: vi.fn(),
	stop: vi.fn(),
	back: vi.fn(),
	forward: vi.fn(),
	zoomIn: vi.fn(),
	zoomOut: vi.fn(),
	zoomReset: vi.fn(),
	clearHistory: vi.fn(),
	revealDownload: vi.fn(),
	updateSettings: vi.fn(),
	setContentBounds: vi.fn(),
	error: "",
	pageContext: vi.fn(),
	sleepTab: vi.fn(),
	sleepInactiveTabs: vi.fn(),
	listPasswords: vi.fn().mockResolvedValue([]),
	savePassword: vi.fn().mockResolvedValue(undefined),
	deletePassword: vi.fn().mockResolvedValue(undefined),
	listAddresses: vi.fn().mockResolvedValue([]),
	saveAddress: vi.fn().mockResolvedValue(undefined),
	deleteAddress: vi.fn().mockResolvedValue(undefined),
	listPaymentMethods: vi.fn().mockResolvedValue([]),
	savePaymentMethod: vi.fn().mockResolvedValue(undefined),
	deletePaymentMethod: vi.fn().mockResolvedValue(undefined),
	queryAutofill: vi.fn().mockResolvedValue({ passwords: [], addresses: [], paymentMethods: [] }),
	applyAutofill: vi.fn().mockResolvedValue(undefined),
};

import { createElement } from "react";

describe("BrowserLibrary navigation", () => {
	it("renders History with back button and history entry", () => {
		const onOpenBrowser = vi.fn();
		const html = renderToStaticMarkup(
			createElement(BrowserHistory, {
				browser: fakeBrowser,
				onOpenBrowser,
			}),
		);
		expect(html).toContain("Back to browser");
		expect(html).toContain("Browser");
		expect(html).toContain("History");
		expect(html).toContain("Example Page");
	});

	it("renders History empty state with back button when no entries", () => {
		const emptyBrowser = {
			...fakeBrowser,
			state: { ...fakeBrowser.state!, history: [] },
		};
		const onOpenBrowser = vi.fn();
		const html = renderToStaticMarkup(
			createElement(BrowserHistory, {
				browser: emptyBrowser,
				onOpenBrowser,
			}),
		);
		expect(html).toContain("Back to browser");
		expect(html).toContain("No history");
	});

	it("renders Downloads empty state with back button when no entries", () => {
		const emptyBrowser = {
			...fakeBrowser,
			state: { ...fakeBrowser.state!, downloads: [] },
		};
		const onOpenBrowser = vi.fn();
		const html = renderToStaticMarkup(
			createElement(BrowserDownloads, {
				browser: emptyBrowser,
				onOpenBrowser,
			}),
		);
		expect(html).toContain("Back to browser");
		expect(html).toContain("No downloads");
	});

	it("renders CommandCenter with back button to browser and search", async () => {
		const { CommandCenter } = await import("./CommandCenter");
		const onClose = vi.fn();
		const onSelect = vi.fn();
		const html = renderToStaticMarkup(
			createElement(CommandCenter, {
				destinations: [
					{
						id: "browser",
						label: "Browser",
						detail: "Open tabs",
						icon: "browser",
						group: "Browse",
					},
					{
						id: "leaderboard",
						label: "Arena",
						detail: "Token leaderboard",
						icon: "activity",
						group: "Agent",
					},
				],
				onSelect,
				onClose,
			}),
		);
		expect(html).toContain("Back to browser");
		expect(html).toContain("Capabilities");
		expect(html).toContain("Arena");
		expect(html).toContain("Token leaderboard");
	});
});
