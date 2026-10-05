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
	small: "Shows fewer items",
	medium: "Shows more items",
	large: "Shows the most items",
};

const LEGACY_DEFAULT_NEW_TAB_WIDGET_IDS: readonly NewTabWidgetId[] = [
	"frequent-tabs",
	"bookmarks",
	"downloads",
	"recent-work",
	"quick-actions",
];

/** Pre–Codex-usage home layout; untouched profiles upgrade to include route-usage. */
const PREVIOUS_DEFAULT_NEW_TAB_WIDGET_IDS: readonly NewTabWidgetId[] = [
	"frequent-tabs",
	"recent-work",
	"recent-memories",
	"quick-actions",
];

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
		description: "Most visited sites",
		icon: "history",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 10,
	},
	bookmarks: {
		id: "bookmarks",
		title: "Bookmarks",
		description: "Saved pages",
		icon: "star",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 20,
	},
	downloads: {
		id: "downloads",
		title: "Downloads",
		description: "Recent files",
		icon: "downloads",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "small",
		priority: 30,
	},
	"recent-work": {
		id: "recent-work",
		title: "Recent work",
		description: "Recent chats",
		icon: "agent",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 40,
	},
	"recent-memories": {
		id: "recent-memories",
		title: "Recent memories",
		description: "Saved memories",
		icon: "memory",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 45,
	},
	"quick-actions": {
		id: "quick-actions",
		title: "Suggested next steps",
		description: "Actions based on recent work",
		icon: "sparkle",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 50,
	},
	"open-tabs": {
		id: "open-tabs",
		title: "Open tabs",
		description: "Tabs open in Kestrel",
		icon: "browser",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 60,
	},
	"pinned-tabs": {
		id: "pinned-tabs",
		title: "Pinned tabs",
		description: "Tabs you pinned",
		icon: "pin",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "small",
		priority: 70,
	},
	"recent-pages": {
		id: "recent-pages",
		title: "Recent pages",
		description: "Visited pages",
		icon: "readiness",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "medium",
		priority: 80,
	},
	"route-usage": {
		id: "route-usage",
		title: "Codex usage",
		description: "Batteries-style 5h and weekly remaining per Codex account",
		icon: "activity",
		supportedSizes: ["small", "medium", "large"],
		defaultSize: "large",
		priority: 40,
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
			return 3;
		case "ultrawide":
			return 4;
	}
}

export type NewTabWidgetViewportDensity = "compact" | "comfortable";

export type NewTabWidgetViewportPlan = {
	columns: number;
	rows: number;
	pageSize: number;
	pageCount: number;
	density: NewTabWidgetViewportDensity;
};

/**
 * Fit the configured widgets into the measured Home remainder. Pagination is
 * balanced so the final page never turns into one oversized, off-center card
 * when the widgets can be split more evenly.
 */
export function widgetViewportPlan(
	layoutClass: NewTabWidgetLayoutClass,
	height: number,
	itemCount: number,
	editing = false,
): NewTabWidgetViewportPlan {
	const columns = columnsForLayoutClass(layoutClass);
	const safeCount = Math.max(0, Math.floor(itemCount));
	const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
	const toolbarHeight = editing ? 46 : 0;
	const rowGap = 12;
	const targetCardHeight = 146;
	const availableWithoutPager = Math.max(0, safeHeight - toolbarHeight);
	let rows = Math.max(
		1,
		Math.min(
			2,
			Math.floor((availableWithoutPager + rowGap) / (targetCardHeight + rowGap)),
		),
	);
	let capacity = Math.max(1, columns * rows);
	let pageCount = safeCount === 0 ? 1 : Math.ceil(safeCount / capacity);

	if (pageCount > 1) {
		const availableWithPager = Math.max(0, availableWithoutPager - 34);
		rows = Math.max(
			1,
			Math.min(
				2,
				Math.floor((availableWithPager + rowGap) / (targetCardHeight + rowGap)),
			),
		);
		capacity = Math.max(1, columns * rows);
		pageCount = Math.ceil(safeCount / capacity);
	}

	const pageSize = safeCount === 0 ? capacity : Math.ceil(safeCount / pageCount);
	const itemsOnLargestPage = Math.min(pageSize, safeCount);
	const pageColumns = Math.max(1, Math.min(columns, itemsOnLargestPage || columns));
	const occupiedRows = Math.max(1, Math.ceil(itemsOnLargestPage / pageColumns));
	const pagerHeight = pageCount > 1 ? 34 : 0;
	const cardHeight =
		(safeHeight - toolbarHeight - pagerHeight - rowGap * (occupiedRows - 1)) /
		occupiedRows;

	return {
		columns,
		rows,
		pageSize,
		pageCount,
		density: cardHeight < 280 ? "compact" : "comfortable",
	};
}

export function widgetPages<T>(
	items: readonly T[],
	pageSize: number,
): T[][] {
	if (items.length === 0) return [[]];
	const safePageSize = Math.max(1, Math.floor(pageSize));
	const pages: T[][] = [];
	for (let index = 0; index < items.length; index += safePageSize) {
		pages.push(items.slice(index, index + safePageSize));
	}
	return pages;
}

export function widgetPageGeometry(maxColumns: number, itemCount: number): {
	columns: number;
	rows: number;
	lastRowStartIndex: number;
	centeredColumnStart?: number;
} {
	const safeMaxColumns = Math.max(1, Math.floor(maxColumns));
	const safeItemCount = Math.max(0, Math.floor(itemCount));
	const balancedRows = Math.max(1, Math.ceil(safeItemCount / safeMaxColumns));
	const columns = Math.max(
		1,
		Math.min(
			safeMaxColumns,
			Math.ceil((safeItemCount || safeMaxColumns) / balancedRows),
		),
	);
	const rows = Math.max(1, Math.ceil(safeItemCount / columns));
	const finalRowCount = safeItemCount % columns;
	if (rows === 1 || finalRowCount === 0) {
		return { columns, rows, lastRowStartIndex: -1 };
	}
	return {
		columns,
		rows,
		lastRowStartIndex: safeItemCount - finalRowCount,
		centeredColumnStart: columns - finalRowCount + 1,
	};
}

export function fittedWidgetSize(
	size: NewTabWidgetSize,
	density: NewTabWidgetViewportDensity,
): NewTabWidgetSize {
	if (density === "compact") return "small";
	return size === "large" ? "medium" : size;
}

export function columnSpanForSize(
	size: NewTabWidgetSize,
	layoutClass: NewTabWidgetLayoutClass,
): number {
	if (layoutClass === "compact") return 1;
	if (size !== "large") return 1;
	return Math.min(2, columnsForLayoutClass(layoutClass));
}

export function rowSpanForSize(
	size: NewTabWidgetSize,
	widgetId?: NewTabWidgetId,
): number {
	// Codex usage needs room for several isolated account meters; a normal
	// large card (~2 rows) clips after the first account with overflow:hidden.
	if (widgetId === "route-usage") {
		if (size === "large") return 4;
		if (size === "medium") return 3;
		return 2;
	}
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

function isLegacyDefaultSettings(settings: NewTabWidgetSettings): boolean {
	const savedLayouts = Object.values(settings.layouts).filter(
		(layout): layout is NewTabWidgetLayout => Boolean(layout),
	);
	const untouchedLegacyLayouts = savedLayouts.every(
		(layout) =>
			!layout.customized &&
			layout.items.length === LEGACY_DEFAULT_NEW_TAB_WIDGET_IDS.length &&
			new Set(layout.items.map((item) => item.id)).size ===
				LEGACY_DEFAULT_NEW_TAB_WIDGET_IDS.length &&
			layout.items.every((item) =>
				LEGACY_DEFAULT_NEW_TAB_WIDGET_IDS.includes(item.id),
			),
	);
	return (
		settings.enabled.length === LEGACY_DEFAULT_NEW_TAB_WIDGET_IDS.length &&
		LEGACY_DEFAULT_NEW_TAB_WIDGET_IDS.every((id) => settings.enabled.includes(id)) &&
		untouchedLegacyLayouts
	);
}

function isPreviousDefaultSettings(settings: NewTabWidgetSettings): boolean {
	const savedLayouts = Object.values(settings.layouts).filter(
		(layout): layout is NewTabWidgetLayout => Boolean(layout),
	);
	const untouchedLayouts = savedLayouts.every(
		(layout) =>
			!layout.customized &&
			layout.items.length === PREVIOUS_DEFAULT_NEW_TAB_WIDGET_IDS.length &&
			new Set(layout.items.map((item) => item.id)).size ===
				PREVIOUS_DEFAULT_NEW_TAB_WIDGET_IDS.length &&
			layout.items.every((item) =>
				PREVIOUS_DEFAULT_NEW_TAB_WIDGET_IDS.includes(item.id),
			),
	);
	return (
		settings.enabled.length === PREVIOUS_DEFAULT_NEW_TAB_WIDGET_IDS.length &&
		PREVIOUS_DEFAULT_NEW_TAB_WIDGET_IDS.every((id) =>
			settings.enabled.includes(id),
		) &&
		untouchedLayouts
	);
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
	const enabled = normalizeEnabled(
		isLegacyDefaultSettings(settings) || isPreviousDefaultSettings(settings)
			? DEFAULT_NEW_TAB_WIDGET_IDS
			: settings.enabled,
	);
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
	const routeUsageVisible = normalizeRouteUsageVisible(settings.routeUsageVisible);
	return { version: 1, enabled, layouts, routeUsageVisible };
}

function normalizeRouteUsageVisible(
	ids: readonly string[] | undefined,
): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const id of ids ?? []) {
		const trimmed = id.trim();
		if (!trimmed || trimmed.length > 100 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
		if (normalized.length >= 64) break;
	}
	return normalized;
}

/**
 * Empty / missing means show every configured route. A non-empty allowlist is
 * an explicit show/hide preference for the route-usage widget.
 */
export function visibleRouteUsageProviderIds(
	settings: NewTabWidgetSettings,
	providerIds: readonly string[],
): string[] {
	const allowlist = normalizeRouteUsageVisible(settings.routeUsageVisible);
	if (allowlist.length === 0) return [...providerIds];
	const allowed = new Set(allowlist);
	return providerIds.filter((id) => allowed.has(id));
}

type RouteUsageRowLike = {
	providerId: string;
	providerPoolId?: string | undefined;
	label: string;
	email?: string | undefined;
	windows?: readonly unknown[] | undefined;
};

function isLegacyCodexRow(row: RouteUsageRowLike): boolean {
	return (
		row.providerId === "legacy-codex" ||
		row.providerId === "codex-subscription" ||
		(row.label.trim().toLowerCase() === "codex" && !row.providerId.startsWith("account-"))
	);
}

function isCodexUsageRow(row: RouteUsageRowLike): boolean {
	const providerPoolId = (row.providerPoolId ?? row.providerId)
		.trim()
		.toLowerCase();
	return (
		providerPoolId === "codex" ||
		providerPoolId === "codex-subscription" ||
		isLegacyCodexRow(row)
	);
}

/** Remaining capacity from a used-percent window (Apple Batteries style). */
export function remainingUsagePercent(usedPercent: number): number {
	if (!Number.isFinite(usedPercent)) return 0;
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export type UsageBatteryLevel = "ok" | "low" | "critical" | "empty" | "unknown";

export function usageBatteryLevel(
	remainingPercent: number | undefined,
): UsageBatteryLevel {
	if (remainingPercent === undefined) return "unknown";
	if (remainingPercent <= 0) return "empty";
	if (remainingPercent <= 10) return "critical";
	if (remainingPercent <= 25) return "low";
	return "ok";
}

/**
 * Prefer real per-account Codex meters. Drop the legacy ~/.codex mirror when a
 * profile-backed account already publishes the same email, and keep status-only
 * non-Codex routes after the metered accounts.
 */
export function prioritizeCodexUsageRows<T extends RouteUsageRowLike>(
	rows: readonly T[],
): T[] {
	const codexRows = rows.filter(isCodexUsageRow);
	const metered = codexRows.filter((row) => (row.windows?.length ?? 0) > 0);
	const profileEmails = new Set(
		metered
			.filter((row) => !isLegacyCodexRow(row) && row.email)
			.map((row) => row.email!.trim().toLowerCase()),
	);
	const droppedIds = new Set<string>();
	const dedupedMetered = metered.filter((row) => {
		if (!isLegacyCodexRow(row)) return true;
		const email = row.email?.trim().toLowerCase();
		if (email && profileEmails.has(email)) {
			droppedIds.add(row.providerId);
			return false;
		}
		return true;
	});
	const meteredIds = new Set(dedupedMetered.map((row) => row.providerId));
	const remainder = codexRows.filter(
		(row) => !meteredIds.has(row.providerId) && !droppedIds.has(row.providerId),
	);
	// This card is explicitly titled Codex usage. Keep other providers out even
	// when no Codex meter is available, rather than attributing their status to Codex.
	return [...dedupedMetered, ...remainder];
}

export function setRouteUsageProviderVisible(
	settings: NewTabWidgetSettings,
	providerId: string,
	visible: boolean,
	configuredProviderIds: readonly string[],
): NewTabWidgetSettings {
	const next = normalizedWidgetSettings(settings);
	const configured = configuredProviderIds.filter(Boolean);
	const currentVisible = visibleRouteUsageProviderIds(next, configured);
	const nextVisible = visible
		? [...new Set([...currentVisible, providerId])]
		: currentVisible.filter((id) => id !== providerId);
	// Persist an explicit allowlist only when it differs from "show all".
	const showAll =
		configured.length > 0 &&
		configured.every((id) => nextVisible.includes(id)) &&
		nextVisible.length === configured.length;
	return {
		...next,
		routeUsageVisible: showAll ? [] : nextVisible,
	};
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
		...next,
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
	return { ...next, enabled, layouts };
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
