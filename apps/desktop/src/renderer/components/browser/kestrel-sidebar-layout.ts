export const KESTREL_SIDEBAR_WIDTH_STORAGE_KEY =
	"kestrel:navigation-sidebar-width";
export const KESTREL_SIDEBAR_DEFAULT_WIDTH = 216;
export const KESTREL_SIDEBAR_MIN_WIDTH = 180;
export const KESTREL_SIDEBAR_MAX_WIDTH = 420;

export function maxKestrelSidebarWidth(): number {
	return KESTREL_SIDEBAR_MAX_WIDTH;
}

export function clampKestrelSidebarWidth(width: number): number {
	const safeWidth = Number.isFinite(width)
		? width
		: KESTREL_SIDEBAR_DEFAULT_WIDTH;
	return Math.min(
		maxKestrelSidebarWidth(),
		Math.max(KESTREL_SIDEBAR_MIN_WIDTH, safeWidth),
	);
}
