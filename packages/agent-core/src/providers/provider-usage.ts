import type {
	ProviderUsageSnapshot,
	ProviderUsageStatus,
	ProviderUsageWindow,
} from "@kestrel/shared-types";
import {
	CodexAppServerProvider,
	earliestCodexResetAt,
	type CodexAccountUsageSnapshot,
	type CodexRateLimitWindow,
} from "./codex-app-server";
import type { ProviderPool } from "./provider-pool";
import type { ModelProvider } from "./types";

const CODEX_USAGE_THROTTLE_MS = 60_000;
const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10_080;

export function providerUsageLabel(provider: ModelProvider): string {
	const named = provider.account?.displayName?.trim();
	if (named) return named;
	const id = provider.poolId ?? provider.id;
	switch (id) {
		case "codex":
		case "codex-subscription":
			return "Codex";
		case "claude-subscription":
			return "Claude Code";
		case "opencode-subscription":
			return "OpenCode";
		case "cursor":
		case "cursor-subscription":
			return "Cursor";
		case "ollama":
			return "Ollama";
		default:
			return id;
	}
}

function windowLabel(window: CodexRateLimitWindow): string | undefined {
	const mins = window.windowDurationMins;
	if (mins === FIVE_HOUR_MINS) return "5-hour";
	if (mins === WEEKLY_MINS) return "Weekly";
	if (mins !== undefined && mins >= 28 * 24 * 60 && mins <= 31 * 24 * 60)
		return "Monthly";
	if (mins !== undefined && mins > 0) {
		if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}-day`;
		if (mins % 60 === 0) return `${mins / 60}-hour`;
		return `${mins}-minute`;
	}
	return undefined;
}

export function usageWindowsFromCodex(
	snapshot: CodexAccountUsageSnapshot,
): ProviderUsageWindow[] {
	const windows: ProviderUsageWindow[] = [];
	for (const slot of [snapshot.primary, snapshot.secondary]) {
		if (!slot) continue;
		const label = windowLabel(slot);
		if (!label) continue;
		windows.push({
			label,
			usedPercent: slot.usedPercent,
			...(slot.windowDurationMins !== undefined
				? { windowDurationMins: slot.windowDurationMins }
				: {}),
			...(slot.resetsAt ? { resetsAt: slot.resetsAt } : {}),
		});
	}
	return windows;
}

function statusFromHealth(
	provider: ModelProvider,
	pool: ProviderPool,
	codex?: CodexAccountUsageSnapshot,
): { status: ProviderUsageStatus; statusDetail?: string } {
	if (codex?.rateLimitReached) {
		const reset = earliestCodexResetAt(codex);
		return {
			status: "rate_limited",
			statusDetail: reset
				? `Rate limited until ${new Date(reset).toLocaleString()}`
				: "Rate limited",
		};
	}
	const health = pool.health().find((entry) => entry.providerId === provider.id);
	if (
		health?.unhealthyUntil &&
		Date.parse(health.unhealthyUntil) > Date.now()
	) {
		if (health.unhealthyReason === "rate_limit") {
			return {
				status: "rate_limited",
				statusDetail: `Rate limited until ${new Date(health.unhealthyUntil).toLocaleString()}`,
			};
		}
		return {
			status: "unhealthy",
			statusDetail: `Temporarily unavailable (${health.unhealthyReason ?? "unknown"})`,
		};
	}
	return { status: "ready" };
}

async function probeStatus(
	provider: ModelProvider,
	signal?: AbortSignal,
): Promise<{ status: ProviderUsageStatus; statusDetail?: string } | undefined> {
	if (!provider.probe) return undefined;
	try {
		await provider.probe(signal);
		return { status: "ready" };
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const lower = message.toLowerCase();
		if (
			lower.includes("not signed") ||
			lower.includes("sign in") ||
			lower.includes("authentication") ||
			lower.includes("401")
		) {
			return {
				status: "not_signed_in",
				statusDetail: "Not signed in",
			};
		}
		return {
			status: "unknown",
			statusDetail: "Could not verify this route",
		};
	}
}

export class ProviderUsageCollector {
	/** Per Codex endpoint — never share one home's meters across accounts. */
	private lastCodexPollAt = new Map<string, number>();
	private lastCodexSnapshot = new Map<string, CodexAccountUsageSnapshot>();

	constructor(
		private readonly pool: ProviderPool,
		private readonly now: () => Date = () => new Date(),
	) {}

	async collect(signal?: AbortSignal): Promise<ProviderUsageSnapshot[]> {
		const snapshots = await Promise.all(
			this.pool.list().map((provider) => this.snapshotFor(provider, signal)),
		);
		return snapshots.sort((left, right) => {
			const rank = (row: ProviderUsageSnapshot): number => {
				if (row.windows && row.windows.length > 0) return 0;
				const id = row.providerId.toLowerCase();
				const label = row.label.toLowerCase();
				if (id.includes("codex") || label.includes("codex") || label.includes("@"))
					return 1;
				return 2;
			};
			const delta = rank(left) - rank(right);
			if (delta !== 0) return delta;
			return left.label.localeCompare(right.label);
		});
	}

	private async snapshotFor(
		provider: ModelProvider,
		signal?: AbortSignal,
	): Promise<ProviderUsageSnapshot> {
		const updatedAt = this.now().toISOString();
		const label = providerUsageLabel(provider);

		if (provider instanceof CodexAppServerProvider) {
			const codex = await this.readCodex(provider, signal);
			this.applyCodexHealth(provider, codex);
			if (
				!codex.primary &&
				!codex.secondary &&
				codex.ordinaryUsageAllowed === false &&
				!codex.email &&
				!codex.plan
			) {
				return {
					providerId: provider.id,
					label,
					status: "not_signed_in",
					statusDetail: "Not signed in",
					updatedAt: codex.updatedAt || updatedAt,
				};
			}
			const { status, statusDetail } = statusFromHealth(
				provider,
				this.pool,
				codex,
			);
			const windows = usageWindowsFromCodex(codex);
			return {
				providerId: provider.id,
				label,
				...(codex.email ? { email: codex.email } : {}),
				...(codex.plan ? { plan: codex.plan } : {}),
				status,
				...(statusDetail ? { statusDetail } : {}),
				...(windows.length ? { windows } : {}),
				...(codex.ordinaryUsageAllowed !== undefined
					? { ordinaryUsageAllowed: codex.ordinaryUsageAllowed }
					: {}),
				updatedAt: codex.updatedAt || updatedAt,
			};
		}

		const healthStatus = statusFromHealth(provider, this.pool);
		if (healthStatus.status !== "ready") {
			return {
				providerId: provider.id,
				label,
				status: healthStatus.status,
				...(healthStatus.statusDetail
					? { statusDetail: healthStatus.statusDetail }
					: {}),
				updatedAt,
			};
		}

		const probed = await probeStatus(provider, signal);
		const status = probed ?? { status: "ready" as const };
		return {
			providerId: provider.id,
			label,
			status: status.status,
			...(status.statusDetail ? { statusDetail: status.statusDetail } : {}),
			updatedAt,
		};
	}

	private async readCodex(
		provider: CodexAppServerProvider,
		signal?: AbortSignal,
	): Promise<CodexAccountUsageSnapshot> {
		const nowMs = this.now().getTime();
		const lastPoll = this.lastCodexPollAt.get(provider.id) ?? 0;
		const cached =
			provider.lastRateLimits() ?? this.lastCodexSnapshot.get(provider.id);
		if (cached && nowMs - lastPoll < CODEX_USAGE_THROTTLE_MS) {
			return cached;
		}
		try {
			const snapshot = await provider.readRateLimits(signal);
			this.lastCodexPollAt.set(provider.id, nowMs);
			this.lastCodexSnapshot.set(provider.id, snapshot);
			return snapshot;
		} catch (error) {
			if (signal?.aborted) throw error;
			if (cached) return cached;
			const message = error instanceof Error ? error.message : String(error);
			const notSignedIn =
				message.toLowerCase().includes("not signed") ||
				message.toLowerCase().includes("authentication");
			return {
				rateLimitReached: false,
				updatedAt: this.now().toISOString(),
				...(notSignedIn
					? { ordinaryUsageAllowed: false }
					: {}),
			};
		}
	}

	private applyCodexHealth(
		provider: CodexAppServerProvider,
		codex: CodexAccountUsageSnapshot,
	): void {
		if (codex.rateLimitReached) {
			const reset = earliestCodexResetAt(codex);
			this.pool.markUnavailable(
				provider.id,
				"rate_limit",
				reset ? Date.parse(reset) : undefined,
			);
			return;
		}
		this.pool.clearUnavailable(provider.id, "rate_limit");
	}
}
