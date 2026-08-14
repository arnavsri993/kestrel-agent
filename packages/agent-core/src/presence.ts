import type { PresenceEntry } from "@kestrel/shared-types";

export interface PresenceBeacon {
	instanceId: string;
	mode: PresenceEntry["mode"];
	version?: string;
	reason?: string;
}

const MAX_ENTRIES = 200;
const IDLE_AFTER_MS = 60_000;
const EXPIRE_AFTER_MS = 300_000;

export class PresenceManager {
	private readonly entries = new Map<string, Omit<PresenceEntry, "status">>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	beacon(input: PresenceBeacon): PresenceEntry {
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.instanceId))
			throw new Error("Presence instance ID is invalid.");
		if (!["ui", "webchat", "node", "test"].includes(input.mode))
			throw new Error("Presence mode is invalid.");
		if (input.version && input.version.length > 100)
			throw new Error("Presence version is invalid.");
		if (input.reason && input.reason.length > 200)
			throw new Error("Presence reason is invalid.");
		this.prune();
		const timestamp = this.now().toISOString();
		const existing = this.entries.get(input.instanceId);
		const record: Omit<PresenceEntry, "status"> = {
			instanceId: input.instanceId,
			mode: input.mode,
			...(input.version ? { version: input.version } : {}),
			...(input.reason ? { reason: input.reason } : {}),
			firstSeenAt: existing?.firstSeenAt ?? timestamp,
			lastSeenAt: timestamp,
		};
		this.entries.set(input.instanceId, record);
		if (this.entries.size > MAX_ENTRIES) {
			const oldest = [...this.entries.values()].sort((left, right) =>
				left.lastSeenAt.localeCompare(right.lastSeenAt),
			)[0];
			if (oldest) this.entries.delete(oldest.instanceId);
		}
		return { ...record, status: "active" };
	}

	list(): PresenceEntry[] {
		this.prune();
		const now = this.now().getTime();
		return [...this.entries.values()]
			.map((entry) => ({
				...entry,
				status:
					now - new Date(entry.lastSeenAt).getTime() >= IDLE_AFTER_MS
						? ("idle" as const)
						: ("active" as const),
			}))
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
	}

	remove(instanceId: string): void {
		this.entries.delete(instanceId);
	}

	private prune(): void {
		const cutoff = this.now().getTime() - EXPIRE_AFTER_MS;
		for (const [instanceId, entry] of this.entries) {
			if (new Date(entry.lastSeenAt).getTime() <= cutoff)
				this.entries.delete(instanceId);
		}
	}
}
