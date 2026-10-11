import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";

export function newestBrowserHistory(history: readonly UserBrowserHistoryEntry[]): UserBrowserHistoryEntry[] {
	// Imports append older visits. Sort a display copy, retaining the existing
	// last-appended-first ordering for visits with identical timestamps.
	return [...history].reverse().sort((a, b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt));
}
