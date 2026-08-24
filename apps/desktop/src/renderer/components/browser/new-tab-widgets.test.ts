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
	removeWidget,
	reorderWidget,
	resizeWidget,
	saveLayout,
} from "./new-tab-widgets";

const baseSettings: NewTabWidgetSettings = {
	version: 1,
	enabled: [...NEW_TAB_WIDGET_IDS],
	layouts: {},
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
			"quick-actions",
		]);
		expect(NEW_TAB_WIDGET_DEFINITIONS["open-tabs"]?.defaultSize).toBe("medium");
		expect(NEW_TAB_WIDGET_DEFINITIONS["pinned-tabs"]?.icon).toBe("pin");
		expect(NEW_TAB_WIDGET_DEFINITIONS["recent-pages"]?.description).toContain(
			"local browsing history",
		);
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
});
