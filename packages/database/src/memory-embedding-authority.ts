import { randomUUID } from "node:crypto";
import { embeddingMac, type EmbeddingOwnerType, type EmbeddingStateSecret } from "./memory-embedding-state.js";

export const EMBEDDING_AUTHORITY_STATE_PREFIX = "kestrel.embedding-authority.v1.ref.";
export const EMBEDDING_AUTHORITY_LIMITS = { nodes: 2_048, depth: 64, bytes: 4_000_000 } as const;
export type EmbeddingAuthorityScope = "owner" | "runtime_session" | "runtime_message" | "agent_identity" | "provenance" | "provenance_set" | "capture" | "source_tombstone" | "source_alias";
export interface EmbeddingAuthorityState {
	version: 1;
	scope: EmbeddingAuthorityScope;
	identity: string;
	epoch: string;
	fingerprint: string;
}
const SCOPES = new Set<string>(["owner", "runtime_session", "runtime_message", "agent_identity", "provenance", "provenance_set", "capture", "source_tombstone", "source_alias"]);
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function embeddingAuthorityStateKey(secret: EmbeddingStateSecret, scope: EmbeddingAuthorityScope, identity: string): string {
	return `${EMBEDDING_AUTHORITY_STATE_PREFIX}${scope}.${embeddingMac(secret, "authority-ref", JSON.stringify([scope, identity]))}`;
}
export function newEmbeddingAuthorityState(scope: EmbeddingAuthorityScope, identity: string, fingerprint: string): EmbeddingAuthorityState {
	return { version: 1, scope, identity, epoch: randomUUID(), fingerprint };
}
/** Reserved encrypted state is strict, including identity-to-key binding when its secret is available. */
export function parseReservedEmbeddingAuthorityState(key: string, value: unknown, secret?: EmbeddingStateSecret): EmbeddingAuthorityState | undefined {
	if (!key.startsWith(EMBEDDING_AUTHORITY_STATE_PREFIX)) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid embedding authority state.");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 5 || record.version !== 1 || typeof record.scope !== "string" || !SCOPES.has(record.scope) ||
		typeof record.identity !== "string" || !record.identity || record.identity.length > 4_000 ||
		typeof record.epoch !== "string" || !UUID.test(record.epoch) || typeof record.fingerprint !== "string" || !HEX.test(record.fingerprint))
		throw new Error("Invalid embedding authority state.");
	const parsed = record as unknown as EmbeddingAuthorityState;
	const prefix = `${EMBEDDING_AUTHORITY_STATE_PREFIX}${parsed.scope}.`;
	if (!key.startsWith(prefix) || !HEX.test(key.slice(prefix.length)) ||
		(secret && embeddingAuthorityStateKey(secret, parsed.scope, parsed.identity) !== key)) throw new Error("Invalid embedding authority binding.");
	return parsed;
}

export class EmbeddingAuthorityDenied extends Error {
	constructor() { super("Memory embedding authority is unavailable."); }
}
export class EmbeddingAuthorityBudget {
	private nodes = 0;
	private bytes = 0;
	consume(value: unknown): void {
		this.nodes++;
		this.readBytes(Buffer.byteLength(JSON.stringify(value)));
		if (this.nodes > EMBEDDING_AUTHORITY_LIMITS.nodes) throw new EmbeddingAuthorityDenied();
	}
	readBytes(length: number): void {
		this.bytes += length;
		if (!Number.isSafeInteger(length) || length < 0 || this.bytes > EMBEDDING_AUTHORITY_LIMITS.bytes) throw new EmbeddingAuthorityDenied();
	}
}
export interface EmbeddingAuthorityOwner {
	record: Record<string, unknown>;
	epoch: string;
}
export interface EmbeddingAuthorityReference { type: EmbeddingOwnerType; id: string }
export interface EmbeddingAuthorityAdapter {
	owner(type: EmbeddingOwnerType, id: string, budget: EmbeddingAuthorityBudget): EmbeddingAuthorityOwner | undefined;
	provenance(type: EmbeddingOwnerType, id: string, budget: EmbeddingAuthorityBudget): Iterable<EmbeddingAuthorityOwner>;
	provenanceSet(type: EmbeddingOwnerType, id: string): string;
	/** Opaque labels remain opaque; recognized references must resolve or fail closed. */
	source(id: string, scanEvents: boolean, budget: EmbeddingAuthorityBudget): Iterable<EmbeddingAuthorityReference | { token: string }>;
	session(id: string, required: boolean, budget: EmbeddingAuthorityBudget): string | undefined;
	agent(id: string, budget: EmbeddingAuthorityBudget): { token: string; sessionId?: string } | undefined;
	capture(event: Record<string, unknown>, budget: EmbeddingAuthorityBudget): string;
}

/** Canonical direct authority excludes access times, scores, ciphertext IVs and other maintenance metadata. */
export function embeddingOwnerAuthorityFields(type: EmbeddingOwnerType, record: Record<string, unknown>): unknown[] {
	const fields: Record<EmbeddingOwnerType, string[]> = {
		timeline_event: ["source", "sourceId", "sourceSessionId", "sessionId", "agentId", "sensitivity", "status", "url", "filePath", "browserTabId", "applicationContext", "retentionPolicy", "retentionDays"],
		timeline_session: ["eventIds", "sourceSessionIds", "status"],
		activity_block: ["sessionId", "eventIds", "status"],
		daily_summary: ["eventIds", "activityBlockIds"],
		memory: ["sourceIds", "sourceType", "sensitivity", "status", "validUntil", "relatedEventIds"],
		agent_memory: ["agentId", "sourceIds", "taskIds", "sensitivity", "status", "validUntil"],
		task: ["agentId", "sessionId", "sourceIds", "dependencyTaskIds", "evidence"],
	};
	return fields[type].map(field => field === "evidence" && Array.isArray(record.evidence)
		? record.evidence.map(item => [item.type, item.id]) : record[field] ?? null);
}

/** Resolve the whole dependency graph. Traversal never uses the product's capped listing APIs. */
export function resolveEmbeddingAuthority(
	adapter: EmbeddingAuthorityAdapter, rootType: EmbeddingOwnerType, rootId: string,
	options: { enforceCapture?: boolean } = {},
): string {
	const budget = new EmbeddingAuthorityBudget();
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const tokens: string[] = [];
	const strings = (value: unknown): string[] => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new EmbeddingAuthorityDenied();
		return value as string[];
	};
	const session = (id: unknown, required = false) => {
		if (id === undefined) return;
		if (typeof id !== "string" || !id) throw new EmbeddingAuthorityDenied();
		const token = adapter.session(id, required, budget);
		if (token) tokens.push(token);
	};
	const source = (id: string, type: EmbeddingOwnerType, ownerId: string, depth: number, scanEvents = true) => {
		for (const ref of adapter.source(id, scanEvents, budget)) {
			if ("token" in ref) { tokens.push(ref.token); continue; }
			// Self-naming source labels/provenance describe the record itself, not a dependency cycle.
			if (ref.type === type && ref.id === ownerId && !/^(timeline_event|timeline_session|activity_block|daily_summary|memory|agent_memory|task):/.test(id)) continue;
			visit(ref.type, ref.id, depth + 1);
		}
	};
	const visit = (type: EmbeddingOwnerType, id: string, depth: number): void => {
		if (depth > EMBEDDING_AUTHORITY_LIMITS.depth) throw new EmbeddingAuthorityDenied();
		const key = `${type}:${id}`;
		if (visiting.has(key)) throw new EmbeddingAuthorityDenied();
		if (visited.has(key)) return;
		visiting.add(key);
		const node = adapter.owner(type, id, budget);
		if (!node) throw new EmbeddingAuthorityDenied();
		budget.consume(node.record);
		tokens.push(`${key}:${node.epoch}`);
		const record = node.record;
		if (record.id !== id || record.status === "deleted") throw new EmbeddingAuthorityDenied();
		if (type === "timeline_event") {
			if (record.source === "connected-source" || id.startsWith("observation-")) throw new EmbeddingAuthorityDenied();
			session(record.sourceSessionId);
			// Timeline session IDs are aggregation identities; actual runtime ownership stays in sourceSessionId.
			if (typeof record.sessionId === "string" && !record.sessionId.startsWith("timeline-session-")) session(record.sessionId);
			if (typeof record.sourceId === "string") source(record.sourceId, type, id, depth, false);
			if (options.enforceCapture !== false) tokens.push(adapter.capture(record, budget));
		} else if (type === "timeline_session" || type === "activity_block" || type === "daily_summary") {
			for (const eventId of strings(record.eventIds)) visit("timeline_event", eventId, depth + 1);
			if (type === "timeline_session") for (const sourceSessionId of strings(record.sourceSessionIds)) session(sourceSessionId);
			// Sessions enumerate evidence directly; their block index is a structural back-reference.
			if (type === "activity_block") {
				if (typeof record.sessionId !== "string") throw new EmbeddingAuthorityDenied();
				visit("timeline_session", record.sessionId, depth + 1);
			}
			if (type === "daily_summary") for (const blockId of strings(record.activityBlockIds)) visit("activity_block", blockId, depth + 1);
		} else {
			for (const ref of strings(record.sourceIds)) source(ref, type, id, depth);
			if (type === "memory") for (const eventId of strings(record.relatedEventIds)) visit("timeline_event", eventId, depth + 1);
			if (type === "agent_memory") for (const taskId of strings(record.taskIds)) visit("task", taskId, depth + 1);
			if (type === "task") {
				session(record.sessionId);
				for (const taskId of strings(record.dependencyTaskIds)) visit("task", taskId, depth + 1);
				if (!Array.isArray(record.evidence)) throw new EmbeddingAuthorityDenied();
				for (const evidence of record.evidence) {
					if (!evidence || typeof evidence !== "object" || typeof evidence.id !== "string") throw new EmbeddingAuthorityDenied();
					if (["timeline_event", "timeline_session", "activity_block", "daily_summary", "memory", "agent_memory", "task"].includes(evidence.type))
						visit(evidence.type as EmbeddingOwnerType, evidence.id, depth + 1);
					else source(evidence.id, type, id, depth);
				}
			}
		}
		if (typeof record.agentId === "string") {
			const agent = adapter.agent(record.agentId, budget);
			if (agent) { tokens.push(agent.token); session(agent.sessionId, true); }
		}
		tokens.push(adapter.provenanceSet(type, id));
		for (const provenance of adapter.provenance(type, id, budget)) {
			const row = provenance.record;
			budget.consume(row);
			if (row.ownerType !== type || row.ownerId !== id || typeof row.sourceId !== "string") throw new EmbeddingAuthorityDenied();
			if (row.sourceType === "connected-source") throw new EmbeddingAuthorityDenied();
			tokens.push(`provenance:${String(row.id)}:${provenance.epoch}`);
			source(row.sourceId, type, id, depth, type !== "timeline_event");
			if (typeof row.timelineEventId === "string" && !(type === "timeline_event" && row.timelineEventId === id)) visit("timeline_event", row.timelineEventId, depth + 1);
			if (typeof row.originalContentRef === "string") source(row.originalContentRef, type, id, depth, type !== "timeline_event");
		}
		visiting.delete(key);
		visited.add(key);
	};
	visit(rootType, rootId, 0);
	return JSON.stringify(tokens.sort());
}
