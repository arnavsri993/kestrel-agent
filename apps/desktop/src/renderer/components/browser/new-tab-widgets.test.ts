import type { NewTabWidgetSettings } from "@kestrel/shared-types";
import {
	DEFAULT_NEW_TAB_WIDGET_IDS,
	NEW_TAB_WIDGET_IDS,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	addWidget,
	columnsForLayoutClass,
	layoutClassForWidth,
	layoutItemsForClass,
	moveWidget,
	NEW_TAB_WIDGET_DEFINITIONS,
	normalizedWidgetSettings,
	prioritizeCodexUsageRows,
	remainingUsagePercent,
	removeWidget,
	reorderWidget,
	resizeWidget,
	rowSpanForSize,
	saveLayout,
	setRouteUsageProviderVisible,
	usageBatteryLevel,
	visibleRouteUsageProviderIds,
} from "./new-tab-widgets";

const baseSettings: NewTabWidgetSettings = {
	version: 1,
	enabled: NEW_TAB_WIDGET_IDS.filter((id) => id !== "route-usage"),
	layouts: {},
	routeUsageVisible: [],
};

describe("New Tab widget layout model", () => {
	it("classifies the measured content width instead of the display resolution", () => {
		expect(layoutClassForWidth(500)).toBe("compact");
		expect(layoutClassForWidth(650)).toBe("standard");
		expect(layoutClassForWidth(1_000)).toBe("wide");
		expect(layoutClassForWidth(1_440)).toBe("ultrawide");
		expect(columnsForLayoutClass("compact")).toBe(1);
		expect(columnsForLayoutClass("standard")).toBe(2);
		expect(columnsForLayoutClass("wide")).toBe(3);
		expect(columnsForLayoutClass("ultrawide")).toBe(4);
	});

	it("keeps the first view curated while exposing more local widget sources", () => {
		expect(DEFAULT_NEW_TAB_WIDGET_IDS).toEqual([
			"frequent-tabs",
			"recent-work",
			"route-usage",
			"recent-memories",
		]);
		expect(NEW_TAB_WIDGET_DEFINITIONS["recent-memories"]?.icon).toBe("memory");
		expect(NEW_TAB_WIDGET_DEFINITIONS["open-tabs"]?.defaultSize).toBe("medium");
		expect(NEW_TAB_WIDGET_DEFINITIONS["pinned-tabs"]?.icon).toBe("pin");
		expect(NEW_TAB_WIDGET_DEFINITIONS["recent-pages"]?.description).toContain(
			"Visited pages",
		);
		expect(NEW_TAB_WIDGET_DEFINITIONS["route-usage"]?.title).toBe("Codex usage");
	});

	it("derives a new class from a saved semantic order and preserves enabled widgets", () => {
		const saved = saveLayout(
			baseSettings,
			"compact",
			[
				{ id: "recent-work", size: "large" },
				{ id: "frequent-tabs", size: "small" },
				{ id: "bookmarks", size: "medium" },
			],
		);

		expect(layoutItemsForClass(saved, "wide")).toEqual([
			{ id: "recent-work", size: "large" },
			{ id: "frequent-tabs", size: "small" },
			{ id: "bookmarks", size: "medium" },
			{ id: "downloads", size: "small" },
			{ id: "recent-memories", size: "medium" },
			{ id: "quick-actions", size: "medium" },
			{ id: "open-tabs", size: "medium" },
			{ id: "pinned-tabs", size: "small" },
			{ id: "recent-pages", size: "medium" },
		]);
	});

	it("migrates the untouched five-widget default to the calmer first view", () => {
		const legacySettings: NewTabWidgetSettings = {
			version: 1,
			enabled: [
				"frequent-tabs",
				"bookmarks",
				"downloads",
				"recent-work",
				"quick-actions",
			],
			layouts: {},
			routeUsageVisible: [],
		};

		expect(normalizedWidgetSettings(legacySettings).enabled).toEqual(
			DEFAULT_NEW_TAB_WIDGET_IDS,
		);
		expect(
			normalizedWidgetSettings({
				...legacySettings,
				layouts: {
					standard: {
						customized: false,
						items: legacySettings.enabled.map((id) => ({ id, size: "medium" })),
					},
				},
			}).enabled,
		).toEqual(DEFAULT_NEW_TAB_WIDGET_IDS);
	});

	it("keeps reorder and size changes discrete and supported", () => {
		const items = layoutItemsForClass(baseSettings, "standard");
		expect(reorderWidget(items, "quick-actions", 0)[0]?.id).toBe("quick-actions");
		expect(moveWidget(items, "frequent-tabs", "down")[1]?.id).toBe(
			"frequent-tabs",
		);

		const resized = resizeWidget(baseSettings, "standard", "downloads", "large");
		expect(layoutItemsForClass(resized, "standard")).toContainEqual({
			id: "downloads",
			size: "large",
		});
	});

	it("adds a widget to enabled configuration and removes it from every saved class", () => {
		const withLayout = saveLayout(
			baseSettings,
			"standard",
			layoutItemsForClass(baseSettings, "standard"),
		);
		const withoutQuickActions = removeWidget(withLayout, "quick-actions");
		expect(withoutQuickActions.enabled).not.toContain("quick-actions");
		expect(layoutItemsForClass(withoutQuickActions, "standard")).not.toContainEqual(
			{ id: "quick-actions", size: "medium" },
		);

		const added = addWidget(withoutQuickActions, "standard", "quick-actions");
		expect(added.enabled).toContain("quick-actions");
		expect(layoutItemsForClass(added, "standard")).toContainEqual({
			id: "quick-actions",
			size: "medium",
		});
	});

	it("keeps route-usage optional and normalizes show/hide prefs", () => {
		expect(NEW_TAB_WIDGET_DEFINITIONS["route-usage"].id).toBe("route-usage");
		expect(NEW_TAB_WIDGET_DEFINITIONS["route-usage"].title).toBe("Codex usage");
		expect(NEW_TAB_WIDGET_DEFINITIONS["route-usage"].defaultSize).toBe("large");
		expect(DEFAULT_NEW_TAB_WIDGET_IDS).toContain("route-usage");
		expect(rowSpanForSize("large", "route-usage")).toBe(4);
		expect(rowSpanForSize("medium", "route-usage")).toBe(3);
		expect(rowSpanForSize("large")).toBe(2);

		const withRoute = addWidget(baseSettings, "standard", "route-usage");
		expect(withRoute.enabled).toContain("route-usage");
		expect(withRoute.routeUsageVisible).toEqual([]);

		const hidden = setRouteUsageProviderVisible(
			withRoute,
			"codex-subscription",
			false,
			["codex-subscription", "cursor-subscription"],
		);
		expect(visibleRouteUsageProviderIds(hidden, [
			"codex-subscription",
			"cursor-subscription",
		])).toEqual(["cursor-subscription"]);

		const restored = setRouteUsageProviderVisible(
			hidden,
			"codex-subscription",
			true,
			["codex-subscription", "cursor-subscription"],
		);
		expect(restored.routeUsageVisible).toEqual([]);
		expect(
			visibleRouteUsageProviderIds(restored, [
				"codex-subscription",
				"cursor-subscription",
			]),
		).toEqual(["codex-subscription", "cursor-subscription"]);
	});

	it("upgrades the previous home default to include Codex usage", () => {
		const previous: NewTabWidgetSettings = {
			version: 1,
			enabled: [
				"frequent-tabs",
				"recent-work",
				"recent-memories",
				"quick-actions",
			],
			layouts: {},
			routeUsageVisible: [],
		};
		expect(normalizedWidgetSettings(previous).enabled).toEqual([
			...DEFAULT_NEW_TAB_WIDGET_IDS,
		]);
	});

	it("dedupes legacy Codex mirrors and keeps metered accounts first", () => {
		const ranked = prioritizeCodexUsageRows([
			{
				providerId: "legacy-openrouter",
				label: "OpenRouter",
				status: "ready",
			},
			{
				providerId: "legacy-codex",
				label: "Codex",
				email: "arnavsri992@gmail.com",
				windows: [{ label: "5-hour", usedPercent: 100 }],
			},
			{
				providerId: "account-a",
				label: "arnavsri993@gmail.com — Main",
				email: "arnavsri993@gmail.com",
				windows: [{ label: "5-hour", usedPercent: 40 }],
			},
			{
				providerId: "account-b",
				label: "arnavsri992@gmail.com — Main",
				email: "arnavsri992@gmail.com",
				windows: [{ label: "5-hour", usedPercent: 80 }],
			},
			{
				providerId: "legacy-cursor",
				label: "Cursor",
				status: "ready",
			},
		]);
		expect(ranked.map((row) => row.providerId)).toEqual([
			"account-a",
			"account-b",
		]);
	});

	it("maps used percent to remaining Batteries-style levels", () => {
		expect(remainingUsagePercent(0)).toBe(100);
		expect(remainingUsagePercent(54)).toBe(46);
		expect(remainingUsagePercent(100)).toBe(0);
		expect(usageBatteryLevel(100)).toBe("ok");
		expect(usageBatteryLevel(20)).toBe("low");
		expect(usageBatteryLevel(8)).toBe("critical");
		expect(usageBatteryLevel(0)).toBe("empty");
		expect(usageBatteryLevel(undefined)).toBe("unknown");
	});
});
