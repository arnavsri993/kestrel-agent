export const PROJECT_APPEARANCE_STORAGE_KEY = "kestrel:project-appearance";

export const PROJECT_ICON_OPTIONS = [
	{ id: "folder", label: "Folder" },
	{ id: "sparkle", label: "Spark" },
	{ id: "agent", label: "Agent" },
	{ id: "star", label: "Star" },
	{ id: "writing", label: "Pencil" },
	{ id: "browser", label: "Browser" },
	{ id: "work", label: "Briefcase" },
	{ id: "compass", label: "Compass" },
] as const;

export const PROJECT_COLOR_OPTIONS = [
	{ id: "neutral", label: "Graphite", value: "#aeb3bd" },
	{ id: "red", label: "Coral", value: "#ff707c" },
	{ id: "orange", label: "Amber", value: "#f5a15d" },
	{ id: "yellow", label: "Gold", value: "#e9c85c" },
	{ id: "green", label: "Leaf", value: "#6fd19a" },
	{ id: "blue", label: "Sky", value: "#70b9ff" },
	{ id: "purple", label: "Iris", value: "#b695ff" },
	{ id: "pink", label: "Rose", value: "#ee8fc1" },
] as const;

export type ProjectIcon = (typeof PROJECT_ICON_OPTIONS)[number]["id"];
export type ProjectColor = (typeof PROJECT_COLOR_OPTIONS)[number]["id"];

export type ProjectAppearance = {
	icon: ProjectIcon;
	color: ProjectColor;
};

export type ProjectAppearanceMap = Record<string, ProjectAppearance>;

export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearance = {
	icon: "folder",
	color: "neutral",
};

export function projectColorValue(color: ProjectColor): string {
	return (
		PROJECT_COLOR_OPTIONS.find((option) => option.id === color)?.value ??
		PROJECT_COLOR_OPTIONS[0].value
	);
}

function isProjectIcon(value: unknown): value is ProjectIcon {
	return PROJECT_ICON_OPTIONS.some((option) => option.id === value);
}

function isProjectColor(value: unknown): value is ProjectColor {
	return PROJECT_COLOR_OPTIONS.some((option) => option.id === value);
}

export function readProjectAppearances(storage?: Pick<Storage, "getItem">): ProjectAppearanceMap {
	if (!storage) return {};
	try {
		const parsed = JSON.parse(
			storage.getItem(PROJECT_APPEARANCE_STORAGE_KEY) ?? "{}",
		) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const appearances: ProjectAppearanceMap = {};
		for (const [path, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const appearance = value as Record<string, unknown>;
			if (!isProjectIcon(appearance.icon) || !isProjectColor(appearance.color)) continue;
			appearances[path] = {
				icon: appearance.icon,
				color: appearance.color,
			};
		}
		return appearances;
	} catch {
		return {};
	}
}

export function writeProjectAppearances(
	storage: Pick<Storage, "setItem"> | undefined,
	appearances: ProjectAppearanceMap,
): void {
	try {
		storage?.setItem(PROJECT_APPEARANCE_STORAGE_KEY, JSON.stringify(appearances));
	} catch {
		// Appearance preferences are helpful but never block navigation.
	}
}
