import { createHash, createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { decryptText, encryptText } from "@kestrel/encryption";
import { ActionReceiptSchema, AgentRunSchema, MemoryJobSchema, RuntimeToolExecutionSchema } from "@kestrel/shared-types";
import * as Contracts from "@kestrel/shared-types";
import { listMigrationVersions, loadMigrationSql } from "./migrations.js";

export const HOST_PROFILE_TRANSFER_VERSION = 1 as const;
export const HOST_PROFILE_TRANSFER_POLICY = "kestrel-host-profile-transfer-in-flight-v1" as const;
export const HOST_PROFILE_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const HOST_PROFILE_TRANSFER_MAX_ROWS = 100_000;
const SCHEMA_VERSION = 18;

type SqlValue = null | string | number | Buffer;
type CipherGroup = { ciphertext: string; iv: string; tag: string; nullable?: boolean };
type TableSpec = { columns: readonly string[]; cipher?: readonly CipherGroup[]; logicalJson?: readonly string[]; special?: "tool-executions" | "idempotency-keys"; termIndex?: "runtime" | "timeline" };
type TransferRow = { values: Record<string, SqlValue>; cleartext?: Record<string, unknown> };
type TransferTables = Record<string, TransferRow[]>;

export type HostProfileTransferSnapshot = {
	format: "kestrel-host-profile-transfer";
	version: typeof HOST_PROFILE_TRANSFER_VERSION;
	schemaVersion: number;
	policy: typeof HOST_PROFILE_TRANSFER_POLICY;
	rows: TransferTables;
	counts: Record<string, number>;
	excluded: { idempotencyClaims: number; runningMemoryJobsCancelled: number; activeAgentRunsCancelled: number; activeToolExecutionsRetired: number; activeWorkingTasksCancelled: number; unexecutedApprovalsRetired: number; unsettledActionReceiptsRetired: number };
	semanticSha256: string;
};

// Frozen table-and-column inventory for migrations 001-018. Derived keyed
// indexes are validated as schema, then regenerated from logical payloads.
const TABLES: Record<string, TableSpec> = {
	schema_migrations: { columns: ["version", "applied_at"] },
	memories: { columns: ["id", "type", "content_ciphertext", "content_iv", "content_auth_tag", "structured_data", "source_ids", "source_type", "created_at", "updated_at", "valid_from", "valid_until", "confidence", "importance", "sensitivity", "status", "entity_ids", "user_confirmed", "inferred"], cipher: [{ ciphertext: "content_ciphertext", iv: "content_iv", tag: "content_auth_tag" }], logicalJson: ["structured_data", "source_ids", "entity_ids"] },
	approvals: { columns: ["id", "payload", "status", "updated_at"], logicalJson: ["payload"] },
	audit_events: { columns: ["id", "payload", "created_at"], logicalJson: ["payload"] },
	idempotency_keys: { columns: ["key", "result", "created_at"], special: "idempotency-keys" },
	runtime_state: { columns: ["key", "value", "updated_at"], logicalJson: ["value"] },
	runtime_sessions: { columns: ["id", "payload", "status", "updated_at"], logicalJson: ["payload"] },
	tool_executions: { columns: ["id", "session_id", "tool_name", "payload", "status", "started_at"], special: "tool-executions" },
	runtime_messages: { columns: ["id", "session_id", "role", "content_ciphertext", "content_iv", "content_auth_tag", "parent_message_id", "tool_execution_id", "created_at"], cipher: [{ ciphertext: "content_ciphertext", iv: "content_iv", tag: "content_auth_tag" }], termIndex: "runtime" },
	runtime_message_terms: { columns: ["message_id", "term_hash"] },
	workspace_mutations: { columns: ["id", "session_id", "tool_execution_id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "created_at", "undone_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	agent_runs: { columns: ["id", "session_id", "payload", "status", "created_at", "updated_at"], logicalJson: ["payload"] },
	model_call_audits: { columns: ["id", "run_id", "session_id", "payload", "status", "started_at"], logicalJson: ["payload"] },
	runtime_message_order: { columns: ["session_id", "message_id", "sequence"] },
	private_runtime_state: { columns: ["key", "value_ciphertext", "value_iv", "value_auth_tag", "updated_at"], cipher: [{ ciphertext: "value_ciphertext", iv: "value_iv", tag: "value_auth_tag" }] },
	idempotency_claims: { columns: ["key", "owner_token", "owner_pid", "pending_result", "created_at"], logicalJson: ["pending_result"] },
	memory_metadata: { columns: ["memory_id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_versions: { columns: ["id", "memory_id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "changed_at", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	people: { columns: ["id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "status", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	calendar_events: { columns: ["id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "provider_id", "status", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	context_usage: { columns: ["id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "created_at", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	calendar_sync_state: { columns: ["provider_id", "payload_ciphertext", "payload_iv", "payload_auth_tag", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	agent_configuration_records: { columns: ["id", "kind", "status", "payload_ciphertext", "payload_iv", "payload_auth_tag", "created_at", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	browser_activity_events: { columns: ["id", "owner_session_id", "surface", "outcome", "created_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	action_receipts: { columns: ["id", "session_id", "tool_execution_id", "status", "started_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_timeline_events: { columns: ["id", "started_at", "ended_at", "event_type", "source", "session_id", "actor", "agent_id", "subagent_id", "task_id", "importance", "sensitivity", "retention_policy", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag", "source_id", "source_session_id"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }], termIndex: "timeline" },
	memory_timeline_event_terms: { columns: ["event_id", "term_hash"] },
	memory_timeline_sessions: { columns: ["id", "started_at", "ended_at", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_activity_blocks: { columns: ["id", "session_id", "started_at", "ended_at", "importance", "confidence", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_daily_summaries: { columns: ["id", "day", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_entities: { columns: ["id", "kind", "canonical_name_hash", "sensitivity", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_entity_edges: { columns: ["id", "from_entity_id", "to_entity_id", "relation", "weight", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_agent_identities: { columns: ["id", "kind", "parent_agent_id", "session_id", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_agent_memories: { columns: ["id", "agent_id", "horizon", "status", "importance", "confidence", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_working_tasks: { columns: ["id", "session_id", "parent_task_id", "agent_id", "status", "started_at", "completed_at", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_provenance: { columns: ["id", "owner_type", "owner_id", "source_type", "source_id", "timeline_event_id", "actor", "extraction_method", "confidence", "created_at", "payload_ciphertext", "payload_iv", "payload_auth_tag", "updated_at"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_capture_policies: { columns: ["id", "scope", "enabled", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_jobs: { columns: ["id", "kind", "dedupe_key", "status", "attempts", "max_attempts", "run_after", "locked_at", "lease_until", "last_error", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_embeddings: { columns: ["id", "owner_type", "owner_id", "provider", "model", "dimension", "content_hash", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
	memory_timeline_event_links: { columns: ["event_id", "link_type", "link_id"] },
	memory_workspace_documents: { columns: ["id", "version", "status", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag", nullable: true }] },
	memory_workspace_day_summaries: { columns: ["id", "viewer_id", "domain_id", "day", "version", "created_at", "updated_at", "payload_ciphertext", "payload_iv", "payload_auth_tag"], cipher: [{ ciphertext: "payload_ciphertext", iv: "payload_iv", tag: "payload_auth_tag" }] },
};

const DERIVED_TABLES = new Set(["runtime_message_terms", "memory_timeline_event_terms"]);
const OMIT_TABLES = new Set(["schema_migrations", "idempotency_claims"]);
const JSON_ENCRYPTED_TABLES = new Set(Object.entries(TABLES).filter(([table, spec]) => spec.cipher?.length && table !== "memories" && table !== "runtime_messages" && table !== "memory_workspace_documents").map(([table]) => table));
const CLEAR_ENVELOPE_COLUMNS = new Set(Object.values(TABLES).flatMap(spec => (spec.cipher ?? []).flatMap(group => [group.ciphertext, group.iv, group.tag])));
const REQUIRED_SCHEMA_VERSIONS = Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1);
const ENCRYPTED_IDEMPOTENCY_PREFIX = "kestrel-encrypted-idempotency-v1:";
const PROTECTED_TOOL_NAMES = new Set(["sources.read", "computer.screenshot", "browser.screenshot", "browser.visible-screenshot"]);

function fail(message: string): never { throw new Error(message); }
function objectJson(value: string, label: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`Profile transfer rejected malformed ${label}.`);
	return parsed as Record<string, unknown>;
}
function canonical(value: unknown): string { return JSON.stringify(value); }
export function computeHostProfileTransferSemanticHash(rows: HostProfileTransferSnapshot["rows"]): string {
	const logical: Record<string, unknown> = {};
	for (const table of Object.keys(rows).sort()) {
		if (DERIVED_TABLES.has(table)) continue;
		logical[table] = rows[table]!.map(row => {
			const values = { ...row.values };
			delete values.canonical_name_hash;
			return { values, cleartext: row.cleartext ?? {} };
		});
	}
	return createHash("sha256").update(canonical(logical)).digest("hex");
}
function hmac(key: Buffer, domain: string, term: string): string {
	return createHmac("sha256", key).update(`${domain}:${term}`).digest("hex");
}
function runtimeTerms(value: string): string[] {
	return [...new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 512);
}
function memoryTerms(value: string): string[] {
	return [...new Set(value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 512);
}
function verifyKey(key: Buffer): void { if (!Buffer.isBuffer(key) || key.length !== 32) fail("Profile transfer requires a 32-byte host database key."); }
function assertPayloadBindings(table: string, values: Record<string, SqlValue>, payload: Record<string, unknown>): void {
	const bindings: Record<string, Record<string, string>> = {
		memories: { id: "id", type: "type", sourceType: "source_type", createdAt: "created_at", updatedAt: "updated_at", validFrom: "valid_from", validUntil: "valid_until", confidence: "confidence", importance: "importance", sensitivity: "sensitivity", status: "status", userConfirmed: "user_confirmed", inferred: "inferred" },
		workspace_mutations: { id: "id", sessionId: "session_id", toolExecutionId: "tool_execution_id", createdAt: "created_at", undoneAt: "undone_at" },
		memory_versions: { id: "id", memoryId: "memory_id", changedAt: "changed_at" },
		people: { id: "id", status: "status", updatedAt: "updated_at" },
		calendar_events: { id: "id", providerId: "provider_id", status: "status", updatedAt: "updated_at" },
		context_usage: { id: "id", createdAt: "created_at" },
		calendar_sync_state: {}, // The canonical payload is an arbitrary provider-owned record.
		agent_configuration_records: { id: "id", createdAt: "created_at" },
		browser_activity_events: { id: "id", ownerSessionId: "owner_session_id", surface: "surface", outcome: "outcome", createdAt: "created_at" },
		action_receipts: { id: "id", sessionId: "session_id", toolExecutionId: "tool_execution_id", outcome: "status", startedAt: "started_at" },
		memory_timeline_events: { id: "id", startedAt: "started_at", endedAt: "ended_at", eventType: "event_type", source: "source", sessionId: "session_id", actor: "actor", agentId: "agent_id", subagentId: "subagent_id", taskId: "task_id", importance: "importance", sensitivity: "sensitivity", retentionPolicy: "retention_policy", status: "status", createdAt: "created_at", updatedAt: "updated_at", sourceId: "source_id", sourceSessionId: "source_session_id" },
		memory_timeline_sessions: { id: "id", startedAt: "started_at", endedAt: "ended_at", status: "status", createdAt: "created_at", updatedAt: "updated_at" },
		memory_activity_blocks: { id: "id", sessionId: "session_id", startedAt: "started_at", endedAt: "ended_at", importance: "importance", confidence: "confidence", status: "status", createdAt: "created_at", updatedAt: "updated_at" },
		memory_daily_summaries: { id: "id", day: "day", createdAt: "created_at", updatedAt: "updated_at" },
		memory_entities: { id: "id", kind: "kind", sensitivity: "sensitivity", status: "status", createdAt: "created_at", updatedAt: "updated_at" },
		memory_entity_edges: { id: "id", fromEntityId: "from_entity_id", toEntityId: "to_entity_id", relation: "relation", weight: "weight", status: "status", createdAt: "created_at", updatedAt: "updated_at" },
		memory_agent_identities: { id: "id", kind: "kind", parentAgentId: "parent_agent_id", sessionId: "session_id", status: "status", createdAt: "created_at", updatedAt: "updated_at" },
		memory_agent_memories: { id: "id", agentId: "agent_id", horizon: "horizon", status: "status", importance: "importance", confidence: "confidence", createdAt: "created_at", updatedAt: "updated_at" },
		memory_working_tasks: { id: "id", sessionId: "session_id", parentTaskId: "parent_task_id", agentId: "agent_id", status: "status", startedAt: "started_at", completedAt: "completed_at", createdAt: "created_at", updatedAt: "updated_at" },
		memory_provenance: { id: "id", ownerType: "owner_type", ownerId: "owner_id", sourceType: "source_type", sourceId: "source_id", timelineEventId: "timeline_event_id", actor: "actor", extractionMethod: "extraction_method", confidence: "confidence", createdAt: "created_at", updatedAt: "updated_at" },
		memory_capture_policies: { id: "id", scope: "scope", enabled: "enabled", createdAt: "created_at", updatedAt: "updated_at" },
		memory_jobs: { id: "id", kind: "kind", dedupeKey: "dedupe_key", status: "status", attempts: "attempts", maxAttempts: "max_attempts", runAfter: "run_after", lockedAt: "locked_at", leaseUntil: "lease_until", lastError: "last_error", createdAt: "created_at", updatedAt: "updated_at" },
		memory_embeddings: { id: "id", ownerType: "owner_type", ownerId: "owner_id", provider: "provider", model: "model", dimension: "dimension", contentHash: "content_hash", status: "status", createdAt: "created_at", updatedAt: "updated_at" },
		memory_workspace_documents: { id: "id", createdAt: "created_at" },
		memory_workspace_day_summaries: { id: "id", viewerId: "viewer_id", domainId: "domain_id", day: "day", version: "version", createdAt: "created_at", updatedAt: "updated_at" },
	};
	for (const [payloadField, rowField] of Object.entries(bindings[table] ?? {})) {
		const expected = values[rowField];
		if (expected === undefined) continue;
		const actual = payload[payloadField];
		if (expected === null && actual === undefined) continue;
		const normalizedActual = typeof actual === "boolean" ? Number(actual) : actual;
		if (actual === undefined || normalizedActual !== expected) fail(`Profile transfer found inconsistent ${table} payload field ${payloadField}.`);
	}
}

// Use the same contracts as the database's normal writers/readers. Preserve
// original JSON rather than schema.parse() output so opaque metadata survives.
const PAYLOAD_SCHEMAS: Record<string, { parse(value: unknown): unknown }> = {
	workspace_mutations: Contracts.WorkspaceMutationSchema,
	memory_versions: Contracts.MemoryVersionSchema,
	people: Contracts.PersonRecordSchema,
	calendar_events: Contracts.UnifiedCalendarEventSchema,
	context_usage: Contracts.AgentContextBundleSchema,
	browser_activity_events: Contracts.BrowserActivityEventSchema,
	action_receipts: Contracts.ActionReceiptSchema,
	memory_timeline_events: Contracts.TimelineEventSchema,
	memory_timeline_sessions: Contracts.TimelineSessionSchema,
	memory_activity_blocks: Contracts.ActivityBlockSchema,
	memory_daily_summaries: Contracts.DailySummarySchema,
	memory_entities: Contracts.EntityRecordSchema,
	memory_entity_edges: Contracts.EntityEdgeSchema,
	memory_agent_identities: Contracts.AgentIdentitySchema,
	memory_agent_memories: Contracts.AgentMemoryRecordSchema,
	memory_working_tasks: Contracts.WorkingTaskSchema,
	memory_provenance: Contracts.ProvenanceRecordSchema,
	memory_capture_policies: Contracts.CapturePolicySchema,
	memory_jobs: Contracts.MemoryJobSchema,
	memory_embeddings: Contracts.EmbeddingRecordSchema,
	memory_workspace_documents: Contracts.MemoryDocumentSchema,
	memory_workspace_day_summaries: Contracts.MemoryWorkspaceDaySummarySchema,
};
function validateProtectedPayload(table: string, values: Record<string, SqlValue>, plaintext: string): void {
	const payload: unknown = JSON.parse(plaintext);
	if (table === "private_runtime_state") return; // This API accepts any JSON value.
	const object = objectJson(plaintext, `${table} payload`);
	PAYLOAD_SCHEMAS[table]?.parse(payload);
	assertPayloadBindings(table, values, object);
	const equals = (actual: unknown, expected: unknown) => { if (actual !== expected) fail(`Profile transfer found inconsistent ${table} metadata.`); };
	if (table === "context_usage") equals(values.updated_at, object.createdAt);
	if (table === "memory_versions") equals(values.updated_at, object.changedAt);
	if (table === "action_receipts") equals(values.updated_at, object.completedAt ?? object.startedAt);
	if (table === "agent_configuration_records") {
		const kind = values.kind;
		const schemas: Record<string, { parse(value: unknown): unknown }> = {
			version: Contracts.AgentConfigurationVersionSchema, proposal: Contracts.AgentConfigurationProposalSchema,
			audit: Contracts.AgentConfigurationAuditEventSchema, improvement: Contracts.AgentImprovementProposalSchema,
		};
		if (typeof kind !== "string" || !schemas[kind]) fail("Profile transfer rejected an unknown agent configuration record kind.");
		schemas[kind]!.parse(payload);
		equals(values.status, kind === "version" ? (object.knownGood ? "known_good" : "verified") : kind === "audit" ? object.action : object.status);
		equals(values.updated_at, kind === "version" || kind === "audit" ? object.createdAt : object.updatedAt);
	}
	if (table === "memory_workspace_documents") {
		if (values.status === "active") { equals(values.version, object.version); equals(values.updated_at, object.updatedAt); }
		else if (values.status !== "deleted" || typeof values.version !== "number" || typeof object.version !== "number" ||
			values.version <= object.version || typeof values.updated_at !== "string" || typeof object.updatedAt !== "string" ||
			Date.parse(values.updated_at) < Date.parse(object.updatedAt)) fail("Profile transfer found an invalid workspace document tombstone.");
	}
}

function retiredToolValue(value: unknown): unknown {
	const parsed = RuntimeToolExecutionSchema.safeParse(value);
	if (!parsed.success || !["running", "blocked"].includes(parsed.data.status)) return value;
	const execution = parsed.data;
	return { ...(value as Record<string, unknown>), status: execution.status === "running" ? "failed" : "cancelled",
		error: [execution.error, execution.status === "running" ? "Action outcome is uncertain after profile transfer; it will not be retried automatically." : "Cancelled by explicit profile transfer; approval must be requested again."].filter(Boolean).join("\n"),
		...(execution.status === "running" ? { outcomeUncertain: true } : {}),
		...(execution.output ? { output: { ...execution.output, approvalRequired: false } } : {}),
		completedAt: execution.completedAt ?? execution.startedAt };
}
function validateMemoryRow(values: Record<string, SqlValue>, cleartext: Record<string, unknown>): void {
	if (![0, 1].includes(Number(values.user_confirmed)) || ![0, 1].includes(Number(values.inferred))) fail("Profile transfer found invalid memory flags.");
	Contracts.MemoryRecordSchema.parse({ id: values.id, type: values.type, content: cleartext.content_ciphertext,
		structuredData: JSON.parse(String(values.structured_data)), sourceIds: JSON.parse(String(values.source_ids)), sourceType: values.source_type,
		createdAt: values.created_at, updatedAt: values.updated_at, ...(values.valid_from === null ? {} : { validFrom: values.valid_from }),
		...(values.valid_until === null ? {} : { validUntil: values.valid_until }), confidence: values.confidence, importance: values.importance,
		sensitivity: values.sensitivity, status: values.status, entityIds: JSON.parse(String(values.entity_ids)),
		userConfirmed: values.user_confirmed === 1, inferred: values.inferred === 1 });
}

function validateSchema(db: Database.Database): void {
	const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
	const actualTables = tableRows.map(row => row.name).sort();
	const expectedTables = Object.keys(TABLES).sort();
	if (canonical(actualTables) !== canonical(expectedTables)) fail("Profile transfer rejected unknown or missing database tables.");
	const unexpectedObjects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('view','trigger')").all();
	if (unexpectedObjects.length) fail("Profile transfer rejected an unsupported schema object.");
	for (const [table, spec] of Object.entries(TABLES)) {
		const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
		if (canonical(columns.map(column => column.name)) !== canonical(spec.columns)) fail(`Profile transfer rejected an unsupported ${table} schema.`);
	}
	const expected = new Database(":memory:");
	try {
		for (const version of listMigrationVersions()) expected.exec(loadMigrationSql(version));
		const schemaRows = (database: Database.Database) => database.prepare(`
			SELECT type, name, tbl_name, sql FROM sqlite_master
			WHERE type IN ('table','index','view','trigger')
			AND name NOT LIKE 'sqlite_%'
			ORDER BY type, name
		`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
		const normalized = (items: ReturnType<typeof schemaRows>) => items.map(item => ({ ...item, sql: item.sql?.replace(/\s+/gu, " ").trim() ?? null }));
		if (canonical(normalized(schemaRows(db))) !== canonical(normalized(schemaRows(expected)))) fail("Profile transfer rejected a database schema that differs from canonical migrations 001-018.");
	} finally { expected.close(); }
	const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(row => row.version);
	if (canonical(versions) !== canonical(REQUIRED_SCHEMA_VERSIONS)) fail("Profile transfer requires exact schema migration versions 1 through 18.");
	const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
	if (version.version !== SCHEMA_VERSION) fail("Profile transfer rejected an unsupported schema version.");
}

function jsonByteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

export function createHostProfileTransferSnapshot(db: Database.Database, key: Buffer, maxBytes = HOST_PROFILE_TRANSFER_MAX_BYTES): HostProfileTransferSnapshot {
	return db.transaction(() => createHostProfileTransferSnapshotInReadTransaction(db, key, maxBytes)).deferred();
}

function createHostProfileTransferSnapshotInReadTransaction(db: Database.Database, key: Buffer, maxBytes: number): HostProfileTransferSnapshot {
	verifyKey(key);
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HOST_PROFILE_TRANSFER_MAX_BYTES) fail("Profile transfer byte limit is invalid.");
	validateSchema(db);
	const rows: TransferTables = {};
	const counts: Record<string, number> = {};
	let totalRows = 0;
	let conservativeBytes = 0;
	let idempotencyClaims = 0;
	let runningMemoryJobsCancelled = 0;
	let activeAgentRunsCancelled = 0;
	let activeToolExecutionsRetired = 0;
	let activeWorkingTasksCancelled = 0;
	let unexecutedApprovalsRetired = 0;
	let unsettledActionReceiptsRetired = 0;
	const retiredToolExecutionStatuses = new Map<string, "failed" | "cancelled">();
	const tableCounts = new Map<string, number>();
	for (const [table, spec] of Object.entries(TABLES)) {
		const byteTerms = spec.columns.map((column, index) => `COALESCE(SUM(LENGTH(CAST(${column} AS BLOB))), 0) AS bytes_${index}`).join(", ");
		const aggregate = db.prepare(`SELECT COUNT(*) AS count, ${byteTerms} FROM ${table}`).get() as Record<string, number>;
		const count = aggregate.count!;
		counts[table] = count;
		tableCounts.set(table, count);
		totalRows += count;
		if (totalRows > HOST_PROFILE_TRANSFER_MAX_ROWS) fail("Profile transfer exceeds the row limit.");
		const rawBytes = spec.columns.reduce((sum, _column, index) => sum + aggregate[`bytes_${index}`]!, 0);
		// JSON can expand control bytes sixfold; this also bounds per-row object,
		// envelope, and array overhead before any row content is materialized.
		conservativeBytes += rawBytes * 6 + count * 1_024;
		if (conservativeBytes > maxBytes) fail("Profile transfer exceeds the byte limit; no records were read into the snapshot.");
	}
	for (const [table, spec] of Object.entries(TABLES)) {
		const expectedCount = tableCounts.get(table)!;
		if (table === "idempotency_claims") { idempotencyClaims = expectedCount; continue; }
		if (OMIT_TABLES.has(table) || DERIVED_TABLES.has(table)) continue;
		const result: TransferRow[] = [];
		const sourceRows = db.prepare(`SELECT ${spec.columns.join(", ")} FROM ${table} ORDER BY rowid`).iterate() as Iterable<Record<string, SqlValue>>;
		for (const source of sourceRows) {
			const values: Record<string, SqlValue> = { ...source };
			const cleartext: Record<string, unknown> = {};
			for (const group of spec.cipher ?? []) {
				const ciphertext = values[group.ciphertext];
				const iv = values[group.iv];
				const tag = values[group.tag];
				if (group.nullable && ciphertext === null && iv === null && tag === null) {
					cleartext[group.ciphertext] = null;
				} else {
					if (typeof ciphertext !== "string" || typeof iv !== "string" || typeof tag !== "string") fail(`Profile transfer found a partial encrypted envelope in ${table}.`);
					const plaintext = decryptText({ ciphertext, iv, authTag: tag }, key);
					if (JSON_ENCRYPTED_TABLES.has(table)) JSON.parse(plaintext);
					cleartext[group.ciphertext] = plaintext;
				}
				delete values[group.ciphertext]; delete values[group.iv]; delete values[group.tag];
			}
			if (spec.special === "tool-executions") {
				const payload = values.payload;
				if (typeof payload !== "string") fail("Profile transfer found a malformed tool execution payload.");
				const parsed = objectJson(payload, "tool execution payload");
				if (parsed.kestrelEncryptedTool === 1) {
					if (typeof parsed.ciphertext !== "string" || typeof parsed.iv !== "string" || typeof parsed.authTag !== "string") fail("Profile transfer found a malformed encrypted tool execution envelope.");
					const clear = JSON.parse(decryptText({ ciphertext: parsed.ciphertext, iv: parsed.iv, authTag: parsed.authTag }, key));
					cleartext.payload = { value: clear };
				} else cleartext.payload = { value: parsed };
				delete values.payload;
			}
			if (spec.special === "idempotency-keys") {
				const result = values.result;
				if (typeof result !== "string") fail("Profile transfer found a malformed idempotency result.");
				if (result.startsWith(ENCRYPTED_IDEMPOTENCY_PREFIX)) {
					const envelope = objectJson(result.slice(ENCRYPTED_IDEMPOTENCY_PREFIX.length), "encrypted idempotency result");
					if (typeof envelope.ciphertext !== "string" || typeof envelope.iv !== "string" || typeof envelope.authTag !== "string") fail("Profile transfer found a malformed encrypted idempotency envelope.");
					const clear = decryptText({ ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.authTag }, key);
					const value: unknown = JSON.parse(clear);
					RuntimeToolExecutionSchema.parse(value);
					cleartext.idempotency_result = { value: retiredToolValue(value) };
				} else {
					const value: unknown = JSON.parse(result);
					cleartext.idempotency_result = { value: retiredToolValue(value) };
				}
				delete values.result;
			}
			for (const column of spec.logicalJson ?? []) if (typeof values[column] === "string") JSON.parse(values[column] as string);
			for (const group of spec.cipher ?? []) {
				const plaintext = cleartext[group.ciphertext];
				if (typeof plaintext !== "string" || !JSON_ENCRYPTED_TABLES.has(table)) continue;
				validateProtectedPayload(table, values, plaintext);
			}
			if (table === "memories") validateMemoryRow(values, cleartext);
			if (table === "runtime_sessions") {
				const session = Contracts.RuntimeSessionSchema.parse(objectJson(String(values.payload), "runtime session"));
				if (session.id !== values.id || session.status !== values.status || session.updatedAt !== values.updated_at) fail("Profile transfer found inconsistent runtime session metadata.");
			}
			if (table === "runtime_messages") {
				const value = cleartext.content_ciphertext;
				if (typeof value !== "string") fail("Profile transfer found a malformed runtime message.");
				try { const parsed = JSON.parse(value) as { version?: unknown; content?: unknown }; if (parsed?.version === 2 && typeof parsed.content !== "string") fail("Profile transfer found malformed versioned runtime message content."); } catch (error) { if (error instanceof SyntaxError) { /* v1 stores raw message text */ } else throw error; }
			}
			if (table === "memory_entities") {
				const value = cleartext.payload_ciphertext;
				const entity = objectJson(String(value), "memory entity");
				if (typeof entity.canonicalName !== "string" || entity.id !== values.id || entity.status !== values.status || entity.kind !== values.kind) fail("Profile transfer found inconsistent memory entity metadata.");
				values.canonical_name_hash = "";
			}
			if (table === "memory_workspace_documents") {
				if (cleartext.payload_ciphertext === null) {
					if (values.status !== "deleted" || typeof values.version !== "number" || values.version < 1) fail("Profile transfer found a missing active workspace document payload.");
				} else validateProtectedPayload(table, values, String(cleartext.payload_ciphertext));
			}
			if (table === "memory_timeline_events") {
				const event = objectJson(String(cleartext.payload_ciphertext), "timeline event");
				if (typeof event.textSummary !== "string" || !Array.isArray(event.projectIds) || !Array.isArray(event.personIds) || !Array.isArray(event.entityIds) || event.id !== values.id || event.status !== values.status || event.startedAt !== values.started_at) fail("Profile transfer found malformed or inconsistent timeline event content.");
			}
			if (table === "approvals") {
				const approval = Contracts.ApprovalSchema.parse(JSON.parse(String(values.payload)));
				if (approval.id !== values.id || approval.status !== values.status) fail("Profile transfer found inconsistent approval metadata.");
				if (["pending", "approved"].includes(approval.status)) {
					values.payload = JSON.stringify({ ...JSON.parse(String(values.payload)), status: "failed", policySuggestion: [approval.policySuggestion, "Profile transferred; review and request approval again before execution."].filter(Boolean).join("\n") });
					values.status = "failed"; unexecutedApprovalsRetired++;
				}
			}
			if (table === "model_call_audits") {
				const audit = Contracts.ModelCallAuditSchema.parse(JSON.parse(String(values.payload)));
				if (audit.id !== values.id || audit.runId !== values.run_id || audit.sessionId !== values.session_id || audit.status !== values.status || audit.startedAt !== values.started_at) fail("Profile transfer found inconsistent model audit metadata.");
			}
			if (table === "memory_working_tasks" && ["running", "waiting"].includes(String(values.status))) {
				const task = objectJson(String(cleartext.payload_ciphertext), "working task");
				const next = { ...task, status: "cancelled", completedAt: task.completedAt ?? task.startedAt };
				Contracts.WorkingTaskSchema.parse(next);
				values.status = "cancelled"; values.completed_at = String(next.completedAt);
				cleartext.payload_ciphertext = JSON.stringify(next); activeWorkingTasksCancelled++;
			}
			if (table === "agent_runs") {
				const rawRun = objectJson(String(values.payload), "agent run");
				const run = AgentRunSchema.parse(rawRun);
				if (run.id !== values.id || run.sessionId !== values.session_id || run.status !== values.status || run.createdAt !== values.created_at || run.updatedAt !== values.updated_at) fail("Profile transfer found inconsistent agent run metadata.");
				if (["running", "waiting_approval", "waiting_input"].includes(String(values.status))) {
				delete run.pendingToolExecutionId; delete run.pendingProviderToolCallId; delete run.pendingToolName;
				delete rawRun.pendingToolExecutionId; delete rawRun.pendingProviderToolCallId; delete rawRun.pendingToolName;
				run.status = "cancelled"; run.error = [run.error, "Cancelled by explicit profile transfer; resume requires user action."].filter(Boolean).join("\n");
				const reconciled = AgentRunSchema.parse(run);
				values.status = "cancelled"; values.payload = JSON.stringify({ ...rawRun, ...reconciled }); activeAgentRunsCancelled++;
				}
			}
			if (table === "tool_executions") {
				const clear = cleartext.payload as { value: Record<string, unknown> };
				let execution = RuntimeToolExecutionSchema.parse(clear.value);
				const status = String(values.status);
				if (execution.id !== values.id || execution.sessionId !== values.session_id || execution.toolName !== values.tool_name || execution.status !== status || execution.startedAt !== values.started_at) fail("Profile transfer found inconsistent tool execution metadata.");
				if (["running", "blocked"].includes(status)) {
					const retired = retiredToolValue(clear.value) as Record<string, unknown>;
					execution = RuntimeToolExecutionSchema.parse(retired);
					clear.value = retired;
					values.status = execution.status;
					retiredToolExecutionStatuses.set(execution.id, execution.status as "failed" | "cancelled");
					activeToolExecutionsRetired++;
				}
			}
			if (table === "action_receipts") {
				const receipt = ActionReceiptSchema.parse(objectJson(String(cleartext.payload_ciphertext), "action receipt"));
				if (receipt.id !== values.id || receipt.sessionId !== values.session_id || receipt.toolExecutionId !== values.tool_execution_id || receipt.startedAt !== values.started_at || receipt.outcome !== values.status) fail("Profile transfer found inconsistent action receipt metadata.");
				const retiredStatus = retiredToolExecutionStatuses.get(receipt.toolExecutionId);
				if (["in_progress", "waiting_approval"].includes(receipt.outcome)) {
					receipt.outcome = retiredStatus === "failed" || receipt.outcome === "in_progress" ? "uncertain" : "cancelled";
					unsettledActionReceiptsRetired++;
					receipt.approval = { required: false, result: receipt.approval.result === "pending" ? "unknown" : receipt.approval.result };
					receipt.completedAt ??= receipt.startedAt;
					values.status = receipt.outcome;
					values.updated_at = receipt.completedAt;
					cleartext.payload_ciphertext = JSON.stringify(ActionReceiptSchema.parse(receipt));
				}
			}
			if (table === "memory_jobs") {
				const rawJob = objectJson(String(cleartext.payload_ciphertext), "memory job");
				const job = MemoryJobSchema.parse(rawJob);
				if (job.id !== values.id || job.status !== values.status) fail("Profile transfer found inconsistent memory job metadata.");
				if (values.status === "running") {
				job.status = "cancelled"; delete job.lockedAt; delete job.leaseUntil;
				job.lastError ??= "Cancelled by explicit profile transfer; job will not be resumed automatically.";
				delete rawJob.lockedAt; delete rawJob.leaseUntil;
				cleartext.payload_ciphertext = JSON.stringify({ ...rawJob, ...MemoryJobSchema.parse(job) });
				values.status = "cancelled"; values.locked_at = null; values.lease_until = null;
				values.last_error = job.lastError as string;
				runningMemoryJobsCancelled++;
				}
			}
			if (spec.termIndex) {
				const runtime = spec.termIndex === "runtime";
				const indexTable = runtime ? "runtime_message_terms" : "memory_timeline_event_terms";
				const identityColumn = runtime ? "message_id" : "event_id";
				const rows = db.prepare(`SELECT term_hash FROM ${indexTable} WHERE ${identityColumn} = ? LIMIT 513`).all(String(values.id)) as Array<{ term_hash: string }>;
				if (rows.length > 512) fail("Profile transfer found an oversized search index entry.");
				const indexedHashes = new Set(rows.map(row => row.term_hash));
				let text = String(runtime ? cleartext.content_ciphertext : objectJson(String(cleartext.payload_ciphertext), "timeline event").textSummary);
				if (runtime) { try { const parsed = JSON.parse(text); if (parsed?.version === 2 && typeof parsed.content === "string") text = parsed.content; } catch { /* Legacy raw text. */ } }
				const terms = runtime ? runtimeTerms(text) : memoryTerms(text);
				const domain = runtime ? "runtime-message" : "memory-substrate";
				const retained = terms.filter(term => indexedHashes.has(hmac(key, domain, term)));
				if (retained.length !== indexedHashes.size) fail("Profile transfer could not bind a search index to its retained plaintext.");
				cleartext.indexedTerms = retained;
			}
			const row: TransferRow = { values, ...(Object.keys(cleartext).length ? { cleartext } : {}) };
			result.push(row);
		}
		if (result.length !== expectedCount) fail(`Profile transfer source changed while reading ${table}.`);
		rows[table] = result;
	}
	const snapshot: HostProfileTransferSnapshot = {
		format: "kestrel-host-profile-transfer",
		version: HOST_PROFILE_TRANSFER_VERSION,
		schemaVersion: SCHEMA_VERSION,
		policy: HOST_PROFILE_TRANSFER_POLICY,
		rows,
		counts,
		excluded: { idempotencyClaims, runningMemoryJobsCancelled, activeAgentRunsCancelled, activeToolExecutionsRetired, activeWorkingTasksCancelled, unexecutedApprovalsRetired, unsettledActionReceiptsRetired },
		semanticSha256: "",
	};
	snapshot.semanticSha256 = computeHostProfileTransferSemanticHash(rows);
	if (jsonByteLength(snapshot) > maxBytes) fail("Profile transfer exceeds the byte limit; no records were truncated.");
	return snapshot;
}

function validateSnapshot(snapshot: HostProfileTransferSnapshot): void {
	if (!snapshot || snapshot.format !== "kestrel-host-profile-transfer" || snapshot.version !== HOST_PROFILE_TRANSFER_VERSION || snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.policy !== HOST_PROFILE_TRANSFER_POLICY) fail("Profile transfer snapshot format, schema, or policy is unsupported.");
	if (canonical(Object.keys(snapshot).sort()) !== canonical(["format", "version", "schemaVersion", "policy", "rows", "counts", "excluded", "semanticSha256"].sort())) fail("Profile transfer snapshot contains unsupported metadata.");
	if (!snapshot.counts || !snapshot.excluded || canonical(Object.keys(snapshot.counts).sort()) !== canonical(Object.keys(TABLES).sort()) || Object.values(snapshot.counts).some(count => !Number.isSafeInteger(count) || count < 0)) fail("Profile transfer snapshot table counts are malformed.");
	if (canonical(Object.keys(snapshot.excluded).sort()) !== canonical(["idempotencyClaims", "runningMemoryJobsCancelled", "activeAgentRunsCancelled", "activeToolExecutionsRetired", "activeWorkingTasksCancelled", "unexecutedApprovalsRetired", "unsettledActionReceiptsRetired"].sort())) fail("Profile transfer snapshot policy report contains unsupported fields.");
	if (snapshot.counts.schema_migrations !== SCHEMA_VERSION || snapshot.counts.idempotency_claims !== snapshot.excluded.idempotencyClaims) fail("Profile transfer snapshot schema or exclusion counts are inconsistent.");
	for (const key of ["idempotencyClaims", "runningMemoryJobsCancelled", "activeAgentRunsCancelled", "activeToolExecutionsRetired", "activeWorkingTasksCancelled", "unexecutedApprovalsRetired", "unsettledActionReceiptsRetired"] as const) if (!Number.isSafeInteger(snapshot.excluded[key]) || snapshot.excluded[key] < 0) fail("Profile transfer snapshot policy report is malformed.");
	const expectedDataTables = Object.keys(TABLES).filter(table => !OMIT_TABLES.has(table) && !DERIVED_TABLES.has(table)).sort();
	if (canonical(Object.keys(snapshot.rows).sort()) !== canonical(expectedDataTables)) fail("Profile transfer snapshot has missing or unknown table data.");
	const rowCount = Object.values(snapshot.rows).reduce((total, rows) => total + rows.length, 0);
	if (rowCount > HOST_PROFILE_TRANSFER_MAX_ROWS || Object.values(snapshot.counts).reduce((total, count) => total + count, 0) > HOST_PROFILE_TRANSFER_MAX_ROWS) fail("Profile transfer snapshot exceeds the row limit.");
	for (const table of expectedDataTables) {
		const spec = TABLES[table]!;
		if (!DERIVED_TABLES.has(table) && snapshot.rows[table]!.length !== snapshot.counts[table]) fail(`Profile transfer snapshot row counts disagree for ${table}.`);
		for (const row of snapshot.rows[table]!) {
			if (!row || typeof row !== "object" || !row.values || typeof row.values !== "object") fail(`Profile transfer snapshot contains malformed ${table} rows.`);
			const expectedFields = spec.columns.filter(column => !CLEAR_ENVELOPE_COLUMNS.has(column) && !(table === "tool_executions" && column === "payload") && !(table === "idempotency_keys" && column === "result"));
			if (canonical(Object.keys(row.values).sort()) !== canonical(expectedFields.sort())) fail(`Profile transfer snapshot has unsupported fields in ${table}.`);
			const expectedClear = [ ...(spec.cipher ?? []).map(group => group.ciphertext), ...(table === "tool_executions" ? ["payload"] : []), ...(table === "idempotency_keys" ? ["idempotency_result"] : []), ...(spec.termIndex ? ["indexedTerms"] : []) ].sort();
			if (canonical(Object.keys(row.cleartext ?? {}).sort()) !== canonical(expectedClear)) fail(`Profile transfer snapshot has malformed protected fields in ${table}.`);
			if (Object.values(row.values).some(value => value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))) fail(`Profile transfer snapshot has an invalid SQLite value in ${table}.`);
			for (const group of spec.cipher ?? []) {
				const value = row.cleartext?.[group.ciphertext];
				if (value !== null && typeof value !== "string") fail(`Profile transfer snapshot has malformed protected content in ${table}.`);
				if (!group.nullable && value === null) fail(`Profile transfer snapshot omits protected content in ${table}.`);
			}
			if (table === "tool_executions") {
				const payload = row.cleartext?.payload as { value?: unknown } | undefined;
				if (!payload || !payload.value || typeof payload.value !== "object" || Array.isArray(payload.value)) fail("Profile transfer snapshot has malformed tool execution content.");
			}
			if (spec.termIndex) {
				const terms = row.cleartext?.indexedTerms;
				if (!Array.isArray(terms) || terms.length > 512 || terms.some(term => typeof term !== "string") || new Set(terms).size !== terms.length) fail("Profile transfer snapshot has malformed search eligibility.");
			}
			if (table === "idempotency_keys") {
				const result = row.cleartext?.idempotency_result as { value?: unknown } | undefined;
				if (!result || !Object.hasOwn(result, "value")) fail("Profile transfer snapshot has malformed idempotency result content.");
			}
		}
	}
	if (computeHostProfileTransferSemanticHash(snapshot.rows) !== snapshot.semanticSha256) fail("Profile transfer snapshot semantic checksum does not match.");
	if (jsonByteLength(snapshot) > HOST_PROFILE_TRANSFER_MAX_BYTES) fail("Profile transfer snapshot exceeds the byte limit.");
}

function rebuildDerivedIndexes(db: Database.Database, key: Buffer, snapshot: HostProfileTransferSnapshot): void {
	for (const [table, indexTable, column, domain] of [
		["runtime_messages", "runtime_message_terms", "message_id", "runtime-message"],
		["memory_timeline_events", "memory_timeline_event_terms", "event_id", "memory-substrate"],
	] as const) {
		const insert = db.prepare(`INSERT INTO ${indexTable}(${column}, term_hash) VALUES (?, ?)`);
		for (const row of snapshot.rows[table] ?? []) for (const term of row.cleartext?.indexedTerms as string[]) insert.run(String(row.values.id), hmac(key, domain, term));
	}
	const entityRows = db.prepare("SELECT id, kind, payload_ciphertext, payload_iv, payload_auth_tag FROM memory_entities").all() as Array<{ id: string; kind: string; payload_ciphertext: string; payload_iv: string; payload_auth_tag: string }>;
	const updateEntity = db.prepare("UPDATE memory_entities SET canonical_name_hash=? WHERE id=?");
	for (const row of entityRows) {
		const entity = objectJson(decryptText({ ciphertext: row.payload_ciphertext, iv: row.payload_iv, authTag: row.payload_auth_tag }, key), "memory entity");
		updateEntity.run(hmac(key, "memory-substrate", String(entity.canonicalName)), row.id);
	}
}

function insertSnapshotRows(db: Database.Database, key: Buffer, snapshot: HostProfileTransferSnapshot): void {
	for (const [table, spec] of Object.entries(TABLES)) {
		if (OMIT_TABLES.has(table) || DERIVED_TABLES.has(table)) continue;
		const records = snapshot.rows[table]!;
		const insertColumns = spec.columns;
		const insert = db.prepare(`INSERT INTO ${table} (${insertColumns.join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`);
		for (const record of records) {
			const values: Record<string, SqlValue> = { ...record.values };
			for (const group of spec.cipher ?? []) {
				const plaintext = record.cleartext?.[group.ciphertext];
				if (plaintext === null && group.nullable) {
					values[group.ciphertext] = null; values[group.iv] = null; values[group.tag] = null;
				} else {
					if (typeof plaintext !== "string") fail(`Profile transfer is missing ${table} protected content.`);
					const encrypted = encryptText(plaintext, key);
					values[group.ciphertext] = encrypted.ciphertext; values[group.iv] = encrypted.iv; values[group.tag] = encrypted.authTag;
				}
			}
			if (spec.special === "tool-executions") {
				const payload = record.cleartext?.payload as { value: Record<string, unknown> } | undefined;
				if (!payload || typeof payload.value !== "object") fail("Profile transfer is missing a tool execution payload.");
				const execution = RuntimeToolExecutionSchema.parse(payload.value);
				const serialized = JSON.stringify(payload.value);
				values.payload = PROTECTED_TOOL_NAMES.has(execution.toolName)
					? JSON.stringify({ kestrelEncryptedTool: 1, ...encryptText(serialized, key) }) : serialized;
			}
			if (spec.special === "idempotency-keys") {
				const result = record.cleartext?.idempotency_result as { value: unknown } | undefined;
				if (!result) fail("Profile transfer is missing an idempotency result.");
				const serialized = JSON.stringify(result.value);
				if (serialized === undefined) fail("Profile transfer has an unserializable idempotency result.");
				const execution = RuntimeToolExecutionSchema.safeParse(result.value);
				values.result = execution.success && PROTECTED_TOOL_NAMES.has(execution.data.toolName)
					? `${ENCRYPTED_IDEMPOTENCY_PREFIX}${JSON.stringify(encryptText(serialized, key))}`
					: serialized;
			}
			if (table === "memory_entities") {
				const payload = record.cleartext?.payload_ciphertext;
				const entity = objectJson(String(payload), "memory entity");
				values.canonical_name_hash = hmac(key, "memory-substrate", String(entity.canonicalName));
			}
			insert.run(...insertColumns.map(column => values[column] ?? null));
		}
	}
	rebuildDerivedIndexes(db, key, snapshot);
}

export function importHostProfileTransferSnapshot(db: Database.Database, key: Buffer, snapshot: HostProfileTransferSnapshot, maxBytes = HOST_PROFILE_TRANSFER_MAX_BYTES): { semanticSha256: string; importedRows: Record<string, number>; excluded: HostProfileTransferSnapshot["excluded"] } {
	verifyKey(key);
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HOST_PROFILE_TRANSFER_MAX_BYTES) fail("Profile transfer byte limit is invalid.");
	validateSchema(db);
	validateSnapshot(snapshot);
	if (jsonByteLength(snapshot) > maxBytes) fail("Profile transfer snapshot exceeds the requested byte limit.");
	const importedRows = Object.fromEntries(Object.entries(snapshot.rows).map(([table, rows]) => [table, rows.length]));
	const apply = db.transaction(() => {
		for (const table of Object.keys(TABLES)) {
			if (table === "schema_migrations") continue;
			const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
			if (count !== 0) fail("Profile transfer destination is not empty; no rows were written.");
		}
		db.pragma("defer_foreign_keys = ON");
		insertSnapshotRows(db, key, snapshot);
		const foreignKeys = db.pragma("foreign_key_check") as unknown[];
		if (foreignKeys.length) fail("Profile transfer failed destination foreign-key validation.");
		const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail("Profile transfer failed destination integrity validation.");
		const readback = createHostProfileTransferSnapshot(db, key, maxBytes);
		if (readback.semanticSha256 !== snapshot.semanticSha256) fail("Profile transfer destination semantic readback did not match.");
	});
	try { apply(); } catch (error) { throw new Error("Profile transfer failed atomically; destination remains empty.", { cause: error }); }
	return { semanticSha256: snapshot.semanticSha256, importedRows, excluded: { ...snapshot.excluded } };
}

