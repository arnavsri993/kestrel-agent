import { randomUUID } from "node:crypto";
import type { MigrationPlan } from "@kestrel/agent-core";
import type { MigrationPlanPreviewContract } from "@kestrel/shared-types";

const DEFAULT_PLAN_TTL_MS = 15 * 60_000;
const MAX_PENDING_PLANS = 20;

interface PendingMigrationPlan {
	senderId: number;
	plan: MigrationPlan;
	expiresAt: number;
}

/**
 * Keeps the filesystem-bearing migration plan inside the main process. The
 * renderer only receives a display-safe preview and an expiring approval id.
 */
export class PendingMigrationPlanStore {
	private readonly plans = new Map<string, PendingMigrationPlan>();

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly ttlMs = DEFAULT_PLAN_TTL_MS,
	) {}

	create(senderId: number, plan: MigrationPlan): string {
		this.removeExpired();
		while (this.plans.size >= MAX_PENDING_PLANS) {
			const oldest = this.plans.keys().next().value;
			if (typeof oldest !== "string") break;
			this.plans.delete(oldest);
		}
		const id = randomUUID();
		this.plans.set(id, {
			senderId,
			plan,
			expiresAt: this.now() + this.ttlMs,
		});
		return id;
	}

	consume(senderId: number, id: string): MigrationPlan {
		this.removeExpired();
		const pending = this.plans.get(id);
		if (!pending)
			throw new Error("Migration review expired. Inspect the source again.");
		if (pending.senderId !== senderId)
			throw new Error("Migration review does not belong to this window.");
		this.plans.delete(id);
		return pending.plan;
	}

	private removeExpired(): void {
		const now = this.now();
		for (const [id, pending] of this.plans)
			if (pending.expiresAt <= now) this.plans.delete(id);
	}
}

export function migrationPlanPreview(
	plan: MigrationPlan,
): MigrationPlanPreviewContract {
	return {
		targetRoot: plan.targetRoot,
		items: plan.items.map((item) => ({
			category: item.category,
			sourcePath: item.sourcePath,
			status: item.status,
		})),
		translatedSettings: plan.translations.length,
		warnings: plan.warnings,
		reviewItems: plan.reviewItems,
	};
}
