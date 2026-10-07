import type {
	MemoryRecord,
	ProviderUsageWindow,
	RuntimeSession,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { agentSessionIsRenderable } from "../../agent-workspace";

const SESSION_STATUS_RANK: Record<RuntimeSession["status"], number> = {
	waiting: 0,
	failed: 1,
	active: 2,
	completed: 3,
	cancelled: 4,
};

const CONFIRMED_MEMORY_STATUSES = new Set<
	NonNullable<MemoryRecord["confirmationStatus"]>
>(["explicit", "provider_confirmed", "user_confirmed"]);

function boundedLimit(limit: number): number {
	return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

function timestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function recentWidgetSessions(
	sessions: RuntimeSession[],
	limit: number,
): RuntimeSession[] {
	const seen = new Set<string>();
	return [...sessions]
		.filter(
			(session) =>
				agentSessionIsRenderable(session) &&
				!session.parentSessionId &&
				session.status !== "cancelled",
		)
		.sort(
			(left, right) =>
				SESSION_STATUS_RANK[left.status] - SESSION_STATUS_RANK[right.status] ||
				timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
				left.id.localeCompare(right.id),
		)
		.filter((session) => {
			if (seen.has(session.id)) return false;
			seen.add(session.id);
			return true;
		})
		.slice(0, boundedLimit(limit));
}

function memoryIsConfirmed(memory: MemoryRecord): boolean {
	return Boolean(
		memory.userConfirmed ||
			(memory.confirmationStatus &&
				CONFIRMED_MEMORY_STATUSES.has(memory.confirmationStatus)),
	);
}

export function homeWidgetMemories(
	memories: MemoryRecord[],
	limit: number,
	now = Date.now(),
): MemoryRecord[] {
	const currentTime = Number.isFinite(now) ? now : Date.now();
	return memories
		.filter((memory) => {
			if (memory.status !== "active") return false;
			if (memory.sensitivity !== "public" && memory.sensitivity !== "personal")
				return false;
			if (memory.archivedAt || memory.layer === "archived") return false;
			if (!memory.validUntil) return true;
			const validUntil = Date.parse(memory.validUntil);
			return Number.isFinite(validUntil) && validUntil > currentTime;
		})
		.slice()
		.sort(
			(left, right) =>
				Number(memoryIsConfirmed(right)) - Number(memoryIsConfirmed(left)) ||
				right.importance - left.importance ||
				(right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) ||
				right.confidence - left.confidence ||
				timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
				left.id.localeCompare(right.id),
		)
		.slice(0, boundedLimit(limit));
}

export function memoryConfirmationLabel(memory: MemoryRecord): "Confirmed" | "Inferred" {
	return memoryIsConfirmed(memory) ? "Confirmed" : "Inferred";
}

function durationFromLabel(label: string): number | undefined {
	const normalized = label.trim().toLowerCase();
	if (/\b5(?:[ -]?h(?:our)?s?)\b/.test(normalized)) return 5 * 60;
	if (/\bweek(?:ly)?\b|\b7(?:[ -]?d(?:ay)?s?)\b/.test(normalized))
		return 7 * 24 * 60;
	return undefined;
}

function usageWindowRank(window: ProviderUsageWindow): number {
	const duration = window.windowDurationMins ?? durationFromLabel(window.label);
	if (duration === 5 * 60) return 0;
	if (duration === 7 * 24 * 60) return 1;
	return 2;
}

export function usageWindowsForWidget(
	windows: ProviderUsageWindow[],
): ProviderUsageWindow[] {
	return windows
		.map((window, index) => ({
			window,
			index,
			rank: usageWindowRank(window),
		}))
		.sort((left, right) => left.rank - right.rank || left.index - right.index)
		.map(({ window }) => window);
}

export function usageResetLabel(
	resetsAt?: string,
	now = Date.now(),
): string | undefined {
	if (!resetsAt || !Number.isFinite(now)) return undefined;
	const resetTime = Date.parse(resetsAt);
	if (!Number.isFinite(resetTime)) return undefined;
	if (resetTime <= now) return "Reset due";

	const totalMinutes = Math.max(1, Math.ceil((resetTime - now) / 60_000));
	if (totalMinutes < 60) return `Resets in ${totalMinutes}m`;
	if (totalMinutes < 24 * 60) {
		const hours = Math.floor(totalMinutes / 60);
		return `Resets in ${hours}h ${totalMinutes % 60}m`;
	}
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	return `Resets in ${days}d ${hours}h`;
}

export function usageSnapshotStale(updatedAt: string, now = Date.now()): boolean {
	const updatedTime = Date.parse(updatedAt);
	if (!Number.isFinite(updatedTime) || !Number.isFinite(now)) return true;
	return now - updatedTime > 5 * 60_000;
}

function normalizedUrlWithoutHash(value: string): string | undefined {
	try {
		const parsed = new URL(value);
		parsed.hash = "";
		return parsed.href;
	} catch {
		return undefined;
	}
}

export function matchingOpenSiteTab(
	siteUrl: string,
	tabs: Pick<UserBrowserTab, "id" | "url">[],
): Pick<UserBrowserTab, "id" | "url"> | undefined {
	const target = normalizedUrlWithoutHash(siteUrl);
	if (!target) return undefined;
	return tabs.find((tab) => normalizedUrlWithoutHash(tab.url) === target);
}
