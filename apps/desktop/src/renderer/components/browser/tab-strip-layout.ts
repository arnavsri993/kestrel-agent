import type { CSSProperties } from "react";

export const TAB_CLOSE_REFIT_DELAY_MS = 450;

export function shouldRetainTabWidthOnClose(
	orientation: "horizontal" | "vertical",
	tabCount: number,
): boolean {
	return orientation === "horizontal" && tabCount > 1;
}

export function clampTabWidth(
	width: number,
	minWidth = 0,
	maxWidth = 520,
): number {
	if (!Number.isFinite(width)) return maxWidth;
	return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

export function computeLockedTabStyle(
	lockedWidth: number | null,
	orientation: "horizontal" | "vertical",
): CSSProperties | undefined {
	if (lockedWidth === null || orientation !== "horizontal") {
		return undefined;
	}
	const clamped = clampTabWidth(lockedWidth);
	return {
		flex: `0 0 ${clamped}px`,
		width: `${clamped}px`,
		maxWidth: `${clamped}px`,
	};
}
