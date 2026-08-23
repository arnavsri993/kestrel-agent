import type {
	NewTabWidgetId,
	NewTabWidgetLayout,
	NewTabWidgetLayoutClass,
	NewTabWidgetLayoutItem,
	NewTabWidgetSettings,
	NewTabWidgetSize,
} from "@kestrel/shared-types";
import { DEFAULT_NEW_TAB_WIDGET_IDS, NEW_TAB_WIDGET_IDS } from "@kestrel/shared-types";

export const NEW_TAB_WIDGET_LAYOUT_CLASSES = [
	"compact",
	"standard",
	"wide",
	"ultrawide",
] as const satisfies readonly NewTabWidgetLayoutClass[];

export const NEW_TAB_WIDGET_SIZES = ["small", "medium", "large"] as const;

export const WIDGET_SIZE_LABELS: Record<NewTabWidgetSize, string> = {
	small: "Small",
	medium: "Medium",
	large: "Large",
};

export const WIDGET_SIZE_DESCRIPTIONS: Record<NewTabWidgetSize, string> = {
	small: "A focused glance",
	medium: "A comfortable view",
	large: "More room to explore",
};

export interface NewTabWidgetDefinition {
	id: NewTabWidgetId;
	title: string;
	description: string;
	icon: string;
	supportedSizes: readonly NewTabWidgetSize[];
	defaultSize: NewTabWidgetSize;
	priority: number;
}

/**
 * The registry is intentionally small and product-owned. A future widget only
 * needs a real data source, a renderer, and a supported-size declaration here.
 */
export const NEW_TAB_WIDGET_DEFINITIONS: Record<
	NewTabWidgetId,
	NewTabWidgetDefinition
> = {
	"frequent-tabs": {
		id: "frequent-tabs",
		title: "Frequent tabs",
		description: "Your most-used local browsing destinations",
		icon: "history",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 10,
	},
	bookmarks: {
		id: "bookmarks",
		title: "Bookmarks",
		description: "Saved links from this Kestrel profile",
		icon: "star",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 20,
	},
	downloads: {
		id: "downloads",
		title: "Downloads",
		description: "The files you recently brought in",
		icon: "downloads",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "small",
		priority: 30,
	},
	"recent-work": {
		id: "recent-work",
		title: "Recent work",
		description: "Continue a recent Kestrel conversation",
		icon: "agent",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 40,
	},
	"quick-actions": {
		id: "quick-actions",
		title: "Quick actions",
		description: "Useful starting points for your next task",
		icon: "sparkle",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 50,
	},
};

export function layoutClassForWidth(width: number): NewTabWidgetLayoutClass {
	if (!Number.isFinite(width) || width < 640) return "compact";
	if (width < 960) return "standard";
	if (width < 1_280) return "wide";
	return "ultrawide";
}

export function columnsForLayoutClass(
	layoutClass: NewTabWidgetLayoutClass,
): number {
	switch (layoutClass) {
		case "compact":
			return 1;
		case "standard":
			return 2;
		case "wide":
			return 4;
		case "ultrawide":
			return 6;
	}
}

export function columnSpanForSize(
	size: NewTabWidgetSize,
	layoutClass: NewTabWidgetLayoutClass,
): number {
	if (layoutClass === "compact") return 1;
	if (size === "small") return 1;
	return Math.min(2, columnsForLayoutClass(layoutClass));
}

export function rowSpanForSize(size: NewTabWidgetSize): number {
	return size === "large" ? 2 : 1;
}

function isWidgetId(value: string): value is NewTabWidgetId {
	return (NEW_TAB_WIDGET_IDS as readonly string[]).includes(value);
}

function supportedSize(
	id: NewTabWidgetId,
	size: NewTabWidgetSize | undefined,
): NewTabWidgetSize {
	const definition = NEW_TAB_WIDGET_DEFINITIONS[id];
	if (size && definition.supportedSizes.includes(size)) return size;
	return definition.defaultSize;
}

function normalizeEnabled(
	ids: readonly NewTabWidgetId[] | undefined,
): NewTabWidgetId[] {
	const seen = new Set<NewTabWidgetId>();
	const normalized: NewTabWidgetId[] = [];
	for (const id of ids ?? DEFAULT_NEW_TAB_WIDGET_IDS) {
		if (seen.has(id) || !isWidgetId(id)) continue;
		seen.add(id);
		normalized.push(id);
	}
	return normalized;
}

function normalizeItems(
	items: readonly NewTabWidgetLayoutItem[] | undefined,
	enabled: readonly NewTabWidgetId[],
): NewTabWidgetLayoutItem[] {
	const enabledSet = new Set(enabled);
	const seen = new Set<NewTabWidgetId>();
	const result: NewTabWidgetLayoutItem[] = [];
	for (const item of items ?? []) {
		if (
			!enabledSet.has(item.id) ||
			seen.has(item.id) ||
			!isWidgetId(item.id)
		)
			continue;
		seen.add(item.id);
		result.push({ id: item.id, size: supportedSize(item.id, item.size) });
	}
	return result;
}

function sourceLayoutFor(
	settings: NewTabWidgetSettings,
	excluded: NewTabWidgetLayoutClass,
): NewTabWidgetLayout | undefined {
	const preferenceOrder: NewTabWidgetLayoutClass[] = [
		excluded === "compact" ? "standard" : "compact",
		excluded === "standard" ? "wide" : "standard",
		excluded === "wide" ? "ultrawide" : "wide",
		excluded === "ultrawide" ? "wide" : "ultrawide",
	];
	for (const candidate of preferenceOrder) {
		const layout = settings.layouts[candidate];
		if (layout?.items.length) return layout;
	}
	return undefined;
}

/**
 * Return the current class's semantic order. Missing classes are derived from
 * the closest saved class and then filled from enabled priority order; no
 * pixel coordinates or monitor dimensions enter the model.
 */
export function layoutItemsForClass(
	settings: NewTabWidgetSettings,
	layoutClass: NewTabWidgetLayoutClass,
): NewTabWidgetLayoutItem[] {
	const enabled = normalizeEnabled(settings.enabled);
	const saved = settings.layouts[layoutClass];
	const source = saved ?? sourceLayoutFor(settings, layoutClass);
	const items = normalizeItems(source?.items, enabled);
	const seen = new Set(items.map((item) => item.id));
	for (const id of enabled) {
		if (seen.has(id)) continue;
		items.push({
			id,
			size: supportedSize(id, undefined),
		});
		seen.add(id);
	}
	return items;
}

export function normalizedWidgetSettings(
	settings: NewTabWidgetSettings,
): NewTabWidgetSettings {
	const enabled = normalizeEnabled(settings.enabled);
	const layouts = Object.fromEntries(
		NEW_TAB_WIDGET_LAYOUT_CLASSES.flatMap((layoutClass) => {
			const saved = settings.layouts[layoutClass];
			if (!saved) return [];
			return [
				[
					layoutClass,
					{
						items: normalizeItems(saved.items, enabled),
						customized: Boolean(saved.customized),
					},
				],
			];
		}),
	) as NewTabWidgetSettings["layouts"];
	return { version: 1, enabled, layouts };
}

export function saveLayout(
	settings: NewTabWidgetSettings,
	layoutClass: NewTabWidgetLayoutClass,
	items: readonly NewTabWidgetLayoutItem[],
	customized = true,
): NewTabWidgetSettings {
	const next = normalizedWidgetSettings(settings);
	return {
		...next,
		layouts: {
			...next.layouts,
			[layoutClass]: {
				items: normalizeItems(items, next.enabled),
				customized,
			},
		},
	};
}

export function addWidget(
	settings: NewTabWidgetSettings,
	layoutClass: NewTabWidgetLayoutClass,
	id: NewTabWidgetId,
): NewTabWidgetSettings {
	const next = normalizedWidgetSettings(settings);
	if (next.enabled.includes(id)) return next;
	const enabled = [...next.enabled, id];
	const layouts = Object.fromEntries(
		NEW_TAB_WIDGET_LAYOUT_CLASSES.flatMap((candidate) => {
			const saved = next.layouts[candidate];
			if (!saved) return [];
			const currentItems = layoutItemsForClass(next, candidate);
			return [
				[
					candidate,
					{
						items: [
							...currentItems,
							{ id, size: supportedSize(id, undefined) },
						],
						customized: saved.customized,
					},
				],
			];
		}),
	) as NewTabWidgetSettings["layouts"];
	return {
		version: 1,
		enabled,
		layouts: {
			...layouts,
			...(next.layouts[layoutClass]
				? {}
				: {
					[layoutClass]: {
						items: layoutItemsForClass({ ...next, enabled }, layoutClass),
						customized: true,
					},
				}),
		},
	};
}

export function removeWidget(
	settings: NewTabWidgetSettings,
	id: NewTabWidgetId,
): NewTabWidgetSettings {
	const next = normalizedWidgetSettings(settings);
	const enabled = next.enabled.filter((candidate) => candidate !== id);
	const layouts = Object.fromEntries(
		NEW_TAB_WIDGET_LAYOUT_CLASSES.flatMap((layoutClass) => {
			const saved = next.layouts[layoutClass];
			if (!saved) return [];
			return [
				[
					layoutClass,
					{
						items: saved.items.filter((item) => item.id !== id),
						customized: saved.customized,
					},
				],
			];
		}),
	) as NewTabWidgetSettings["layouts"];
	return { version: 1, enabled, layouts };
}

export function resizeWidget(
	settings: NewTabWidgetSettings,
	layoutClass: NewTabWidgetLayoutClass,
	id: NewTabWidgetId,
	size: NewTabWidgetSize,
): NewTabWidgetSettings {
	const definition = NEW_TAB_WIDGET_DEFINITIONS[id];
	if (!definition.supportedSizes.includes(size)) return settings;
	const items = layoutItemsForClass(settings, layoutClass).map((item) =>
		item.id === id ? { ...item, size } : item,
	);
	return saveLayout(settings, layoutClass, items);
}

export function reorderWidget(
	items: readonly NewTabWidgetLayoutItem[],
	fromId: NewTabWidgetId,
	toIndex: number,
): NewTabWidgetLayoutItem[] {
	const currentIndex = items.findIndex((item) => item.id === fromId);
	if (currentIndex < 0) return [...items];
	const next = [...items];
	const [item] = next.splice(currentIndex, 1);
	if (!item) return next;
	const boundedIndex = Math.max(0, Math.min(toIndex, next.length));
	next.splice(boundedIndex, 0, item);
	return next;
}

export function moveWidget(
	items: readonly NewTabWidgetLayoutItem[],
	fromId: NewTabWidgetId,
	direction: "up" | "down",
): NewTabWidgetLayoutItem[] {
	const index = items.findIndex((item) => item.id === fromId);
	if (index < 0) return [...items];
	const target = direction === "up" ? index - 1 : index + 1;
	if (target < 0 || target >= items.length) return [...items];
	return reorderWidget(items, fromId, target);
}
