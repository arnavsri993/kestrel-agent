import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";

/** The encrypted private-state key used exclusively for routing outcomes. */
export const ROUTING_OUTCOME_STORE_KEY = "routing.outcomes.v1";
export const DEFAULT_ROUTING_OUTCOME_LIMIT = 200;
export const MAX_ROUTING_OUTCOME_LIMIT = 500;

const THINKING_LEVELS = new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);
const VERIFIER_STATUSES = new Set([
	"passed",
	"failed",
	"skipped",
	"unavailable",
]);
const COST_SCARCITY_LEVELS = new Set([
	"abundant",
	"normal",
	"constrained",
	"exhausted",
	"unknown",
]);

export type RoutingThinkingLevel =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "ultra";
export type RoutingVerifierStatus =
	| "passed"
	| "failed"
	| "skipped"
	| "unavailable";
export type RoutingCostScarcity =
	| "abundant"
	| "normal"
	| "constrained"
	| "exhausted"
	| "unknown";

/**
 * Route identifiers must be opaque, non-secret identifiers. Values such as
 * email addresses, URLs, prompt text, and tokens are rejected rather than
 * attempting to redact them after the fact.
 */
export interface RoutingOutcomeRoute {
	providerId?: string;
	accountId?: string;
	transportId?: string;
	modelId?: string;
}

export interface RoutingOutcomeInput {
	taskProfile?: string;
	route?: RoutingOutcomeRoute;
	thinkingLevel?: RoutingThinkingLevel;
	durationMs?: number;
	retryCount?: number;
	toolFailureCount?: number;
	escalated?: boolean;
	verifierStatus?: RoutingVerifierStatus;
	success?: boolean;
	costScarcity?: RoutingCostScarcity;
	timestamp?: Date | string;
}

export interface RoutingOutcomeRecord {
	id: string;
	timestamp: string;
	taskProfile?: string;
	route?: RoutingOutcomeRoute;
	thinkingLevel?: RoutingThinkingLevel;
	durationMs?: number;
	retryCount?: number;
	toolFailureCount?: number;
	escalated?: boolean;
	verifierStatus?: RoutingVerifierStatus;
	success?: boolean;
	costScarcity?: RoutingCostScarcity;
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return undefined;
	return Math.min(maximum, Math.floor(value));
}

function safeIdentifier(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized.length === 0 ||
		normalized.length > 128 ||
		!/[a-z0-9]/.test(normalized) ||
		!/^[-._:a-z0-9]+$/.test(normalized) ||
		/(?:https?:|www\.|@|(?:^|[-_.])(?:sk|pk)[:-]|\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|credential|password|secret)\b)/.test(
			normalized,
		)
	)
		return undefined;
	return normalized;
}

function safeRoute(value: unknown): RoutingOutcomeRoute | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const providerId = safeIdentifier(candidate.providerId);
	const accountId = safeIdentifier(candidate.accountId);
	const transportId = safeIdentifier(candidate.transportId);
	const modelId = safeIdentifier(candidate.modelId);
	if (!providerId && !accountId && !transportId && !modelId) return undefined;
	return {
		...(providerId ? { providerId } : {}),
		...(accountId ? { accountId } : {}),
		...(transportId ? { transportId } : {}),
		...(modelId ? { modelId } : {}),
	};
}

function enumValue<T extends string>(
	value: unknown,
	allowed: Set<string>,
): T | undefined {
	return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

function timestamp(value: unknown, now: () => Date): string {
	const parsed =
		value instanceof Date
			? value.getTime()
			: typeof value === "string"
				? Date.parse(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type SanitizableOutcome = Omit<RoutingOutcomeInput, "timestamp"> & {
	timestamp?: unknown;
};

function sanitizeOutcome(
	id: string,
	input: SanitizableOutcome,
	now: () => Date,
): RoutingOutcomeRecord {
	const outcome: RoutingOutcomeRecord = { id, timestamp: timestamp(input.timestamp, now) };
	const taskProfile = safeIdentifier(input.taskProfile);
	const route = safeRoute(input.route);
	const thinkingLevel = enumValue<RoutingThinkingLevel>(input.thinkingLevel, THINKING_LEVELS);
	const durationMs = boundedInteger(input.durationMs, 7 * 24 * 60 * 60 * 1000);
	const retryCount = boundedInteger(input.retryCount, 100);
	const toolFailureCount = boundedInteger(input.toolFailureCount, 100);
	const verifierStatus = enumValue<RoutingVerifierStatus>(input.verifierStatus, VERIFIER_STATUSES);
	const costScarcity = enumValue<RoutingCostScarcity>(input.costScarcity, COST_SCARCITY_LEVELS);
	if (taskProfile) outcome.taskProfile = taskProfile;
	if (route) outcome.route = route;
	if (thinkingLevel) outcome.thinkingLevel = thinkingLevel;
	if (durationMs !== undefined) outcome.durationMs = durationMs;
	if (retryCount !== undefined) outcome.retryCount = retryCount;
	if (toolFailureCount !== undefined) outcome.toolFailureCount = toolFailureCount;
	if (typeof input.escalated === "boolean") outcome.escalated = input.escalated;
	if (verifierStatus) outcome.verifierStatus = verifierStatus;
	if (typeof input.success === "boolean") outcome.success = input.success;
	if (costScarcity) outcome.costScarcity = costScarcity;
	return outcome;
}

/**
 * Encrypted, bounded, local-only outcome history for route selection. It never
 * accepts prompt text, errors, endpoint URLs, credentials, or raw tool output.
 */
export class RoutingOutcomeStore {
	constructor(
		private readonly database: KestrelDatabase,
		private readonly now: () => Date = () => new Date(),
		private readonly maximumRecords = DEFAULT_ROUTING_OUTCOME_LIMIT,
	) {}

	record(input: RoutingOutcomeInput): RoutingOutcomeRecord {
		const record = sanitizeOutcome(`routing-outcome-${randomUUID()}`, input, this.now);
		const maximum = Math.max(1, Math.min(MAX_ROUTING_OUTCOME_LIMIT, Math.floor(this.maximumRecords)));
		this.database.setPrivateState(ROUTING_OUTCOME_STORE_KEY, [
			...this.list(MAX_ROUTING_OUTCOME_LIMIT).reverse(),
			record,
		].slice(-maximum));
		return record;
	}

	list(limit = DEFAULT_ROUTING_OUTCOME_LIMIT): RoutingOutcomeRecord[] {
		const stored = this.database.getPrivateState<unknown>(ROUTING_OUTCOME_STORE_KEY);
		const boundedLimit = Math.max(1, Math.min(MAX_ROUTING_OUTCOME_LIMIT, Math.floor(limit)));
		if (!Array.isArray(stored)) return [];
		return stored
			.filter(isRecord)
			.map((value) => this.sanitizeStored(value))
			.filter((value): value is RoutingOutcomeRecord => value !== undefined)
			.slice(-boundedLimit)
			.reverse();
	}

	private sanitizeStored(value: Record<string, unknown>): RoutingOutcomeRecord | undefined {
		if (typeof value.id !== "string" || !value.id.startsWith("routing-outcome-"))
			return undefined;
		return sanitizeOutcome(value.id, value as SanitizableOutcome, this.now);
	}
}
