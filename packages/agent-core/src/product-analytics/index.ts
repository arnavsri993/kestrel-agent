/**
 * Privacy-preserving product analytics. Events must never include prompts,
 * page text, memory contents, tool argument payloads, credentials, or message
 * bodies. Local aggregation is the default; external export is opt-in only.
 */
import { z } from "zod";

export const ProductAnalyticsEventNameSchema = z.enum([
	"first_run_completed",
	"model_connected",
	"first_successful_task",
	"first_verified_tool_execution",
	"first_recurring_agent_created",
	"browser_task_success",
	"browser_task_failure",
	"approval_recorded",
	"integration_connected",
	"plugin_installed",
	"crash_restart_recovery",
	"performance_sample",
]);
export type ProductAnalyticsEventName = z.infer<
	typeof ProductAnalyticsEventNameSchema
>;

export const ProductAnalyticsEventSchema = z.object({
	name: ProductAnalyticsEventNameSchema,
	occurredAt: z.string().datetime(),
	/** Opaque install-scoped id. Never a user email, account id, or device name. */
	installationId: z.string().min(8).max(128).optional(),
	/** Content-free counters and enums only. */
	properties: z
		.record(
			z.string().max(64),
			z.union([z.string().max(64), z.number(), z.boolean()]),
		)
		.default({}),
});
export type ProductAnalyticsEvent = z.infer<typeof ProductAnalyticsEventSchema>;

export interface ProductAnalyticsTotals {
	events: number;
	byName: Record<string, number>;
	firstSeenAt?: string;
	lastSeenAt?: string;
}

export interface RetentionSketch {
	/** Distinct active installation days observed locally. Not a cloud DAU. */
	activeInstallationDays: number;
	status: "local_only" | "not_measured";
}

const FORBIDDEN_PROPERTY_KEYS =
	/prompt|message|memory|credential|password|token|cookie|body|page.?text|url|email|content/i;

export function assertContentFreeProperties(
	properties: Record<string, string | number | boolean>,
): void {
	for (const key of Object.keys(properties)) {
		if (FORBIDDEN_PROPERTY_KEYS.test(key))
			throw new Error(
				`Product analytics property "${key}" is not content-free.`,
			);
		const value = properties[key];
		if (typeof value === "string" && value.length > 64)
			throw new Error("Product analytics string properties must stay bounded.");
	}
}

export class LocalProductAnalytics {
	private readonly events: ProductAnalyticsEvent[] = [];
	private readonly maxEvents: number;

	constructor(options: { maxEvents?: number } = {}) {
		this.maxEvents = options.maxEvents ?? 5_000;
	}

	record(input: ProductAnalyticsEvent): void {
		const event = ProductAnalyticsEventSchema.parse(input);
		assertContentFreeProperties(event.properties);
		this.events.push(event);
		if (this.events.length > this.maxEvents)
			this.events.splice(0, this.events.length - this.maxEvents);
	}

	totals(): ProductAnalyticsTotals {
		const byName: Record<string, number> = {};
		for (const event of this.events)
			byName[event.name] = (byName[event.name] ?? 0) + 1;
		return {
			events: this.events.length,
			byName,
			...(this.events[0] ? { firstSeenAt: this.events[0].occurredAt } : {}),
			...(this.events.at(-1)
				? { lastSeenAt: this.events.at(-1)!.occurredAt }
				: {}),
		};
	}

	/**
	 * Local sketch only. External DAU/WAU/retention requires an opt-in exporter
	 * and operator infrastructure; report not_measured until then.
	 */
	retentionSketch(): RetentionSketch {
		const days = new Set(
			this.events
				.filter((event) => event.installationId)
				.map((event) => event.occurredAt.slice(0, 10)),
		);
		return {
			activeInstallationDays: days.size,
			status: "local_only",
		};
	}

	snapshot(): ProductAnalyticsEvent[] {
		return this.events.map((event) => ({ ...event, properties: { ...event.properties } }));
	}
}

export function retentionFormulas(): Record<string, string> {
	return {
		DAU: "count distinct installationId with any event on calendar day D (opt-in export only)",
		WAU: "count distinct installationId with any event in rolling 7 days ending D",
		D1: "share of first_run_completed cohorts with any event on day+1",
		D7: "share of first_run_completed cohorts with any event on day+7",
		D30: "share of first_run_completed cohorts with any event on day+30",
		task_success_rate: "first_successful_task / model_connected cohorts (content-free)",
		verified_tasks_per_user: "first_verified_tool_execution count / active installationId",
		agent_executions_per_user: "approval_recorded + recurring agent events / active installationId",
	};
}
