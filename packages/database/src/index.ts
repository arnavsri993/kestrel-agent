import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decryptText, encryptText } from "@kestrel/encryption";
import {
	type ActivityItem,
	ActivitySchema,
	type AgentConfigurationAuditEvent,
	AgentConfigurationAuditEventSchema,
	type AgentConfigurationProposal,
	AgentConfigurationProposalSchema,
	type AgentConfigurationVersion,
	AgentConfigurationVersionSchema,
	type AgentContextBundle,
	AgentContextBundleSchema,
	type AgentImprovementProposal,
	AgentImprovementProposalSchema,
	type AgentRun,
	AgentRunSchema,
	type Approval,
	ApprovalSchema,
	type BrowserActivityEvent,
	BrowserActivityEventSchema,
	type MemoryRecord,
	MemoryRecordSchema,
	type MemoryVersion,
	MemoryVersionSchema,
	type ModelCallAudit,
	ModelCallAuditSchema,
	type PersonRecord,
	PersonRecordSchema,
	type RuntimeMessage,
	RuntimeMessageSchema,
	type RuntimeSession,
	RuntimeSessionSchema,
	type RuntimeToolExecution,
	RuntimeToolExecutionSchema,
	type UnifiedCalendarEvent,
	UnifiedCalendarEventSchema,
	type WorkspaceMutation,
	WorkspaceMutationSchema,
} from "@kestrel/shared-types";
import Database from "better-sqlite3";

const migration001 = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, content_ciphertext TEXT NOT NULL,
  content_iv TEXT NOT NULL, content_auth_tag TEXT NOT NULL, structured_data TEXT NOT NULL,
  source_ids TEXT NOT NULL, source_type TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, valid_from TEXT, valid_until TEXT, confidence REAL NOT NULL,
  importance REAL NOT NULL, sensitivity TEXT NOT NULL, status TEXT NOT NULL,
  entity_ids TEXT NOT NULL, user_confirmed INTEGER NOT NULL, inferred INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

const migration002 = `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
`;

const migration003 = `
CREATE TABLE IF NOT EXISTS runtime_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content_ciphertext TEXT NOT NULL, content_iv TEXT NOT NULL, content_auth_tag TEXT NOT NULL,
  parent_message_id TEXT, tool_execution_id TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
CREATE TABLE IF NOT EXISTS runtime_message_terms (
  message_id TEXT NOT NULL, term_hash TEXT NOT NULL,
  PRIMARY KEY(message_id, term_hash),
  FOREIGN KEY(message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runtime_message_terms_hash ON runtime_message_terms(term_hash);
CREATE INDEX IF NOT EXISTS idx_runtime_messages_session_created ON runtime_messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS workspace_mutations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_execution_id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL, payload_auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL, undone_at TEXT,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id),
  FOREIGN KEY(tool_execution_id) REFERENCES tool_executions(id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_mutations_session_created ON workspace_mutations(session_id, created_at);
`;

const migration004 = `
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created ON agent_runs(session_id, created_at);
CREATE TABLE IF NOT EXISTS model_call_audits (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES agent_runs(id),
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_model_call_audits_run_started ON model_call_audits(run_id, started_at);
`;

const migration005 = `
CREATE TABLE IF NOT EXISTS runtime_message_order (
  session_id TEXT NOT NULL, message_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
  UNIQUE(session_id, sequence),
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id),
  FOREIGN KEY(message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runtime_message_order_session ON runtime_message_order(session_id, sequence);
`;

const migration006 = `
CREATE TABLE IF NOT EXISTS private_runtime_state (
  key TEXT PRIMARY KEY, value_ciphertext TEXT NOT NULL, value_iv TEXT NOT NULL,
  value_auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const migration007 = `
CREATE TABLE IF NOT EXISTS idempotency_claims (
  key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
  pending_result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const migration008 = `
CREATE TABLE IF NOT EXISTS memory_metadata (
  memory_id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id)
);
CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_changed
  ON memory_versions(memory_id, changed_at);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_status_updated ON people(status, updated_at);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, provider_id TEXT NOT NULL,
  status TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_provider_status
  ON calendar_events(provider_id, status, updated_at);
CREATE TABLE IF NOT EXISTS context_usage (
  id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_usage_created ON context_usage(created_at);
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  provider_id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const migration009 = `
CREATE TABLE IF NOT EXISTS agent_configuration_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('version', 'proposal', 'audit', 'improvement')),
  status TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_configuration_records_kind_created
  ON agent_configuration_records(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_configuration_records_kind_status
  ON agent_configuration_records(kind, status);
`;

const migration010 = `
CREATE TABLE IF NOT EXISTS browser_activity_events (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('autonomous', 'visible')),
  outcome TEXT NOT NULL CHECK(outcome IN ('performed', 'blocked', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_activity_owner_created
  ON browser_activity_events(owner_session_id, created_at);
`;

const MAX_BROWSER_ACTIVITY_PER_OWNER = 500;

export const PROTECTED_DATABASE_ERROR_CODE = "kestrel-protected-database";

/**
 * Signals that Kestrel found an existing encrypted profile but cannot safely
 * decrypt it with the currently available database key.
 *
 * This is intentionally distinct from a first-run database. Callers may offer
 * a non-destructive recovery choice, but must never silently replace the
 * protected profile.
 */
export class ProtectedDatabaseError extends Error {
	readonly code = PROTECTED_DATABASE_ERROR_CODE;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "ProtectedDatabaseError";
		if (cause !== undefined) this.cause = cause;
	}
}

export function isProtectedDatabaseError(
	error: unknown,
): error is ProtectedDatabaseError {
	return (
		error instanceof ProtectedDatabaseError ||
		(typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === PROTECTED_DATABASE_ERROR_CODE)
	);
}

export interface IdempotencyClaim<T = unknown> {
	key: string;
	ownerToken: string;
	ownerPid: number;
	pendingResult: T;
	createdAt: string;
}

export type IdempotencyClaimResult<T> =
	| { state: "claimed"; claim: IdempotencyClaim<T> }
	| { state: "active"; claim: IdempotencyClaim<T> }
	| { state: "completed"; result: T };

export interface IdempotencyCompletion<T> {
	result: T;
	completed: boolean;
}

export interface RetiredAgentHistory {
	runs: AgentRun[];
	toolExecutions: RuntimeToolExecution[];
}

export interface RuntimeHistoryRollbackResult extends RetiredAgentHistory {
	session: RuntimeSession;
}

export interface RuntimeMessagePage {
	messages: RuntimeMessage[];
	hasMore: boolean;
}

export interface RuntimeMessagePageOptions {
	beforeMessageId?: string;
	limit?: number;
}

interface RuntimeMessageRow {
	id: string;
	session_id: string;
	role: string;
	content_ciphertext: string;
	content_iv: string;
	content_auth_tag: string;
	parent_message_id: string | null;
	tool_execution_id: string | null;
	created_at: string;
}

interface WorkspaceMutationRow {
	payload_ciphertext: string;
	payload_iv: string;
	payload_auth_tag: string;
}

interface IdempotencyClaimRow {
	key: string;
	owner_token: string;
	owner_pid: number;
	pending_result: string;
	created_at: string;
}

interface MemoryRow {
	id: string;
	type: string;
	content_ciphertext: string;
	content_iv: string;
	content_auth_tag: string;
	structured_data: string;
	source_ids: string;
	source_type: string;
	created_at: string;
	updated_at: string;
	valid_from: string | null;
	valid_until: string | null;
	confidence: number;
	importance: number;
	sensitivity: string;
	status: string;
	entity_ids: string;
	user_confirmed: number;
	inferred: number;
}

interface AgentConfigurationRecordRow {
	id: string;
	kind: "version" | "proposal" | "audit" | "improvement";
	status: string;
	payload_ciphertext: string;
	payload_iv: string;
	payload_auth_tag: string;
	created_at: string;
	updated_at: string;
}

interface EncryptedPayloadRow {
	payload_ciphertext: string;
	payload_iv: string;
	payload_auth_tag: string;
}

interface BrowserActivityRow extends EncryptedPayloadRow {
	id: string;
	owner_session_id: string;
	surface: "autonomous" | "visible";
	outcome: "performed" | "blocked" | "failed" | "cancelled";
	created_at: string;
}

interface MemoryMetadataRow extends EncryptedPayloadRow {
	memory_id: string;
}

export class KestrelDatabase {
	readonly db: Database.Database;

	constructor(
		filename: string,
		private readonly encryptionKey: Buffer,
	) {
		if (filename !== ":memory:")
			mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
		this.db = new Database(filename);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("secure_delete = ON");
		this.migrate();
	}

	private migrate(): void {
		this.db.transaction(() => {
			this.db.exec(migration001);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(1, new Date().toISOString());
			this.db.exec(migration002);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(2, new Date().toISOString());
			this.db.exec(migration003);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(3, new Date().toISOString());
			this.db.exec(migration004);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(4, new Date().toISOString());
			this.db.exec(migration005);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(5, new Date().toISOString());
			this.db.exec(migration006);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(6, new Date().toISOString());
			this.db.exec(migration007);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(7, new Date().toISOString());
			this.db.exec(migration008);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(8, new Date().toISOString());
			this.db.exec(migration009);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(9, new Date().toISOString());
			this.db.exec(migration010);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(10, new Date().toISOString());
		})();
	}

	upsertMemory(memory: MemoryRecord): void {
		const parsed = MemoryRecordSchema.parse(memory);
		const encrypted = encryptText(parsed.content, this.encryptionKey);
		this.db
			.prepare(`
      INSERT INTO memories (
        id, type, content_ciphertext, content_iv, content_auth_tag, structured_data,
        source_ids, source_type, created_at, updated_at, valid_from, valid_until,
        confidence, importance, sensitivity, status, entity_ids, user_confirmed, inferred
      ) VALUES (
        @id, @type, @ciphertext, @iv, @authTag, @structuredData,
        @sourceIds, @sourceType, @createdAt, @updatedAt, @validFrom, @validUntil,
        @confidence, @importance, @sensitivity, @status, @entityIds, @userConfirmed, @inferred
      )
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,
        content_ciphertext=excluded.content_ciphertext, content_iv=excluded.content_iv,
        content_auth_tag=excluded.content_auth_tag, structured_data=excluded.structured_data,
        source_ids=excluded.source_ids, source_type=excluded.source_type,
        updated_at=excluded.updated_at, valid_from=excluded.valid_from, valid_until=excluded.valid_until,
        confidence=excluded.confidence, importance=excluded.importance, sensitivity=excluded.sensitivity,
        status=excluded.status, entity_ids=excluded.entity_ids,
        user_confirmed=excluded.user_confirmed, inferred=excluded.inferred
    `)
			.run({
				id: parsed.id,
				type: parsed.type,
				ciphertext: encrypted.ciphertext,
				iv: encrypted.iv,
				authTag: encrypted.authTag,
				structuredData: JSON.stringify(parsed.structuredData),
				sourceIds: JSON.stringify(parsed.sourceIds),
				sourceType: parsed.sourceType,
				createdAt: parsed.createdAt,
				updatedAt: parsed.updatedAt,
				validFrom: parsed.validFrom ?? null,
				validUntil: parsed.validUntil ?? null,
				confidence: parsed.confidence,
				importance: parsed.importance,
				sensitivity: parsed.sensitivity,
				status: parsed.status,
				entityIds: JSON.stringify(parsed.entityIds),
				userConfirmed: parsed.userConfirmed ? 1 : 0,
				inferred: parsed.inferred ? 1 : 0,
			});
		const metadata = {
			...(parsed.subject ? { subject: parsed.subject } : {}),
			...(parsed.layer ? { layer: parsed.layer } : {}),
			...(parsed.confirmationStatus
				? { confirmationStatus: parsed.confirmationStatus }
				: {}),
			...(parsed.lastAccessedAt
				? { lastAccessedAt: parsed.lastAccessedAt }
				: {}),
			...(parsed.relevanceScore !== undefined
				? { relevanceScore: parsed.relevanceScore }
				: {}),
			...(parsed.reviewAt ? { reviewAt: parsed.reviewAt } : {}),
			...(parsed.archivedAt ? { archivedAt: parsed.archivedAt } : {}),
			relatedPersonIds: parsed.relatedPersonIds ?? [],
			relatedProjectIds: parsed.relatedProjectIds ?? [],
			relatedEventIds: parsed.relatedEventIds ?? [],
			relatedLocationIds: parsed.relatedLocationIds ?? [],
			conflictingMemoryIds: parsed.conflictingMemoryIds ?? [],
			version: parsed.version ?? 1,
		};
		this.upsertEncryptedPayload(
			"memory_metadata",
			"memory_id",
			parsed.id,
			metadata,
			parsed.updatedAt,
		);
	}

	getMemory(id: string): MemoryRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM memories WHERE id = ? AND status != 'deleted'")
			.get(id) as MemoryRow | undefined;
		if (!row) return undefined;
		return this.withMemoryMetadata(
			MemoryRecordSchema.parse({
				id: row.id,
				type: row.type,
				content: decryptText(
					{
						ciphertext: row.content_ciphertext,
						iv: row.content_iv,
						authTag: row.content_auth_tag,
					},
					this.encryptionKey,
				),
				structuredData: JSON.parse(row.structured_data),
				sourceIds: JSON.parse(row.source_ids),
				sourceType: row.source_type,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				...(row.valid_from ? { validFrom: row.valid_from } : {}),
				...(row.valid_until ? { validUntil: row.valid_until } : {}),
				confidence: row.confidence,
				importance: row.importance,
				sensitivity: row.sensitivity,
				status: row.status,
				entityIds: JSON.parse(row.entity_ids),
				userConfirmed: row.user_confirmed === 1,
				inferred: row.inferred === 1,
			}),
		);
	}

	listMemories(): MemoryRecord[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM memories WHERE status != 'deleted' ORDER BY importance DESC, updated_at DESC",
				)
				.all() as MemoryRow[]
		).map((row) =>
			this.withMemoryMetadata(
				MemoryRecordSchema.parse({
					id: row.id,
					type: row.type,
					content: decryptText(
						{
							ciphertext: row.content_ciphertext,
							iv: row.content_iv,
							authTag: row.content_auth_tag,
						},
						this.encryptionKey,
					),
					structuredData: JSON.parse(row.structured_data),
					sourceIds: JSON.parse(row.source_ids),
					sourceType: row.source_type,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					...(row.valid_from ? { validFrom: row.valid_from } : {}),
					...(row.valid_until ? { validUntil: row.valid_until } : {}),
					confidence: row.confidence,
					importance: row.importance,
					sensitivity: row.sensitivity,
					status: row.status,
					entityIds: JSON.parse(row.entity_ids),
					userConfirmed: row.user_confirmed === 1,
					inferred: row.inferred === 1,
				}),
			),
		);
	}

	saveApproval(approval: Approval): void {
		const parsed = ApprovalSchema.parse(approval);
		this.db
			.prepare(`INSERT INTO approvals (id, payload, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status, updated_at=excluded.updated_at`)
			.run(
				parsed.id,
				JSON.stringify(parsed),
				parsed.status,
				new Date().toISOString(),
			);
	}

	listApprovals(): Approval[] {
		return (
			this.db
				.prepare("SELECT payload FROM approvals ORDER BY updated_at DESC")
				.all() as Array<{ payload: string }>
		).map((row) => ApprovalSchema.parse(JSON.parse(row.payload)));
	}

	addActivity(item: ActivityItem): void {
		const parsed = ActivitySchema.parse(item);
		this.db
			.prepare(
				"INSERT OR REPLACE INTO audit_events (id, payload, created_at) VALUES (?, ?, ?)",
			)
			.run(parsed.id, JSON.stringify(parsed), parsed.timestamp);
	}

	listActivity(): ActivityItem[] {
		return (
			this.db
				.prepare("SELECT payload FROM audit_events ORDER BY created_at ASC")
				.all() as Array<{ payload: string }>
		).map((row) => ActivitySchema.parse(JSON.parse(row.payload)));
	}

	saveRuntimeSession(session: RuntimeSession): void {
		const parsed = RuntimeSessionSchema.parse(session);
		this.db
			.prepare(`INSERT INTO runtime_sessions (id, payload, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status, updated_at=excluded.updated_at`)
			.run(parsed.id, JSON.stringify(parsed), parsed.status, parsed.updatedAt);
	}

	getRuntimeSession(id: string): RuntimeSession | undefined {
		const row = this.db
			.prepare("SELECT payload FROM runtime_sessions WHERE id = ?")
			.get(id) as { payload: string } | undefined;
		return row
			? RuntimeSessionSchema.parse(JSON.parse(row.payload))
			: undefined;
	}

	listRuntimeSessions(): RuntimeSession[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM runtime_sessions ORDER BY updated_at DESC",
				)
				.all() as Array<{ payload: string }>
		).map((row) => RuntimeSessionSchema.parse(JSON.parse(row.payload)));
	}

	saveRuntimeMessage(message: RuntimeMessage): RuntimeSession {
		const parsed = RuntimeMessageSchema.parse(message);
		const encrypted = encryptText(
			JSON.stringify({
				version: 2,
				content: parsed.content,
				...(parsed.modelToolCalls
					? { modelToolCalls: parsed.modelToolCalls }
					: {}),
				...(parsed.providerToolCallId
					? { providerToolCallId: parsed.providerToolCallId }
					: {}),
				...(parsed.toolName ? { toolName: parsed.toolName } : {}),
			}),
			this.encryptionKey,
		);
		const terms = this.searchTerms(parsed.content);
		return this.db.transaction(() => {
			this.db
				.prepare(`INSERT INTO runtime_messages (
        id, session_id, role, content_ciphertext, content_iv, content_auth_tag,
        parent_message_id, tool_execution_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					parsed.id,
					parsed.sessionId,
					parsed.role,
					encrypted.ciphertext,
					encrypted.iv,
					encrypted.authTag,
					parsed.parentMessageId ?? null,
					parsed.toolExecutionId ?? null,
					parsed.createdAt,
				);
			const next = this.db
				.prepare(
					"SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM runtime_message_order WHERE session_id = ?",
				)
				.get(parsed.sessionId) as { sequence: number };
			this.db
				.prepare(
					"INSERT INTO runtime_message_order (session_id, message_id, sequence) VALUES (?, ?, ?)",
				)
				.run(parsed.sessionId, parsed.id, next.sequence);
			const insertTerm = this.db.prepare(
				"INSERT OR IGNORE INTO runtime_message_terms (message_id, term_hash) VALUES (?, ?)",
			);
			for (const term of terms)
				insertTerm.run(parsed.id, this.hashSearchTerm(term));
			const ownerRow = this.db
				.prepare("SELECT payload FROM runtime_sessions WHERE id = ?")
				.get(parsed.sessionId) as { payload: string } | undefined;
			if (!ownerRow) throw new Error("Runtime message session was not found.");
			const owner = RuntimeSessionSchema.parse(JSON.parse(ownerRow.payload));
			const updatedAt =
				Date.parse(parsed.createdAt) > Date.parse(owner.updatedAt)
					? parsed.createdAt
					: owner.updatedAt;
			const updatedOwner = RuntimeSessionSchema.parse({ ...owner, updatedAt });
			const touched = this.db
				.prepare(
					"UPDATE runtime_sessions SET payload = ?, updated_at = ? WHERE id = ?",
				)
				.run(
					JSON.stringify(updatedOwner),
					updatedOwner.updatedAt,
					updatedOwner.id,
				);
			if (touched.changes !== 1)
				throw new Error("Runtime message session could not be updated.");
			return updatedOwner;
		})();
	}

	listRuntimeMessages(sessionId: string): RuntimeMessage[] {
		return (
			this.db
				.prepare(`SELECT m.* FROM runtime_messages m
      LEFT JOIN runtime_message_order o ON o.message_id = m.id
      WHERE m.session_id = ? ORDER BY COALESCE(o.sequence, 0) ASC, m.created_at ASC, m.id ASC`)
				.all(sessionId) as RuntimeMessageRow[]
		).map((row) => this.parseRuntimeMessage(row));
	}

	listRuntimeMessagesPage(
		sessionId: string,
		options: RuntimeMessagePageOptions = {},
	): RuntimeMessagePage {
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(200, Math.trunc(options.limit!)))
			: 100;
		let beforeSequence: number | undefined;
		if (options.beforeMessageId) {
			const boundary = this.db
				.prepare(
					"SELECT sequence FROM runtime_message_order WHERE session_id = ? AND message_id = ?",
				)
				.get(sessionId, options.beforeMessageId) as
				| { sequence: number }
				| undefined;
			if (!boundary)
				throw new Error("Runtime message cursor was not found in this session.");
			beforeSequence = boundary.sequence;
		}

		const rows = (
			beforeSequence === undefined
				? this.db
						.prepare(`SELECT m.* FROM runtime_messages m
        JOIN runtime_message_order o ON o.message_id = m.id AND o.session_id = m.session_id
        WHERE m.session_id = ?
        ORDER BY o.sequence DESC LIMIT ?`)
						.all(sessionId, limit + 1)
				: this.db
						.prepare(`SELECT m.* FROM runtime_messages m
        JOIN runtime_message_order o ON o.message_id = m.id AND o.session_id = m.session_id
        WHERE m.session_id = ? AND o.sequence < ?
        ORDER BY o.sequence DESC LIMIT ?`)
						.all(sessionId, beforeSequence, limit + 1)
		) as RuntimeMessageRow[];
		const hasMore = rows.length > limit;
		return {
			messages: rows
				.slice(0, limit)
				.reverse()
				.map((row) => this.parseRuntimeMessage(row)),
			hasMore,
		};
	}

	truncateRuntimeMessages(sessionId: string, keepCount: number): void {
		if (!Number.isInteger(keepCount) || keepCount < 0)
			throw new Error("Message truncation count is invalid.");
		this.db.transaction(() => {
			const ids = this.db
				.prepare(
					"SELECT message_id FROM runtime_message_order WHERE session_id = ? AND sequence > ? ORDER BY sequence DESC",
				)
				.all(sessionId, keepCount) as Array<{ message_id: string }>;
			const remove = this.db.prepare(
				"DELETE FROM runtime_messages WHERE id = ? AND session_id = ?",
			);
			for (const { message_id } of ids) remove.run(message_id, sessionId);
		})();
	}

	searchRuntimeMessages(query: string, limit = 20): RuntimeMessage[] {
		const terms = this.searchTerms(query);
		if (terms.length === 0) return [];
		const hashes = terms.map((term) => this.hashSearchTerm(term));
		const placeholders = hashes.map(() => "?").join(", ");
		return (
			this.db
				.prepare(`SELECT m.* FROM runtime_messages m
      JOIN runtime_message_terms t ON t.message_id = m.id
      WHERE t.term_hash IN (${placeholders})
      GROUP BY m.id HAVING COUNT(DISTINCT t.term_hash) = ?
      ORDER BY m.created_at DESC LIMIT ?`)
				.all(...hashes, hashes.length, limit) as RuntimeMessageRow[]
		).map((row) => this.parseRuntimeMessage(row));
	}

	saveToolExecution(execution: RuntimeToolExecution): void {
		const parsed = RuntimeToolExecutionSchema.parse(execution);
		this.db
			.prepare(`INSERT INTO tool_executions (id, session_id, tool_name, payload, status, started_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status`)
			.run(
				parsed.id,
				parsed.sessionId,
				parsed.toolName,
				JSON.stringify(parsed),
				parsed.status,
				parsed.startedAt,
			);
	}

	listToolExecutions(sessionId: string): RuntimeToolExecution[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM tool_executions WHERE session_id = ? ORDER BY started_at ASC",
				)
				.all(sessionId) as Array<{ payload: string }>
		).map((row) => RuntimeToolExecutionSchema.parse(JSON.parse(row.payload)));
	}

	listAllToolExecutions(startedAt?: string): RuntimeToolExecution[] {
		const rows = (
			startedAt === undefined
				? this.db
						.prepare(
							"SELECT payload FROM tool_executions ORDER BY started_at ASC",
						)
						.all()
				: this.db
						.prepare(
							"SELECT payload FROM tool_executions WHERE started_at >= ? ORDER BY started_at ASC",
						)
						.all(startedAt)
		) as Array<{ payload: string }>;
		return rows.map((row) =>
			RuntimeToolExecutionSchema.parse(JSON.parse(row.payload)),
		);
	}

	aggregateToolExecutionStats(): Array<{
		tool: string;
		outcome: string;
		count: number;
	}> {
		const rows = this.db
			.prepare(`
      SELECT
        json_extract(payload, '$.toolName') as tool,
        CASE json_extract(payload, '$.status')
          WHEN 'verified' THEN 'success'
          WHEN 'blocked' THEN 'blocked'
          WHEN 'failed' THEN 'error'
          ELSE 'pending'
        END as outcome,
        COUNT(*) as count
      FROM tool_executions
      GROUP BY json_extract(payload, '$.toolName'), CASE json_extract(payload, '$.status') WHEN 'verified' THEN 'success' WHEN 'blocked' THEN 'blocked' WHEN 'failed' THEN 'error' ELSE 'pending' END
    `)
			.all() as Array<{ tool: string | null; outcome: string; count: number }>;
		return rows.map((row) => ({
			tool: row.tool ?? "unknown",
			outcome: row.outcome,
			count: row.count,
		}));
	}

	getToolExecution(id: string): RuntimeToolExecution | undefined {
		const row = this.db
			.prepare("SELECT payload FROM tool_executions WHERE id = ?")
			.get(id) as { payload: string } | undefined;
		return row
			? RuntimeToolExecutionSchema.parse(JSON.parse(row.payload))
			: undefined;
	}

	saveWorkspaceMutation(mutation: WorkspaceMutation): void {
		const parsed = WorkspaceMutationSchema.parse(mutation);
		const encrypted = encryptText(JSON.stringify(parsed), this.encryptionKey);
		this.db
			.prepare(`INSERT INTO workspace_mutations (
      id, session_id, tool_execution_id, payload_ciphertext, payload_iv, payload_auth_tag, created_at, undone_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_ciphertext=excluded.payload_ciphertext,
      payload_iv=excluded.payload_iv, payload_auth_tag=excluded.payload_auth_tag, undone_at=excluded.undone_at`)
			.run(
				parsed.id,
				parsed.sessionId,
				parsed.toolExecutionId,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
				parsed.createdAt,
				parsed.undoneAt ?? null,
			);
	}

	getWorkspaceMutation(id: string): WorkspaceMutation | undefined {
		const row = this.db
			.prepare(
				"SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM workspace_mutations WHERE id = ?",
			)
			.get(id) as WorkspaceMutationRow | undefined;
		return row ? this.parseWorkspaceMutation(row) : undefined;
	}

	listWorkspaceMutations(sessionId: string): WorkspaceMutation[] {
		return (
			this.db
				.prepare(
					"SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM workspace_mutations WHERE session_id = ? ORDER BY created_at DESC",
				)
				.all(sessionId) as WorkspaceMutationRow[]
		).map((row) => this.parseWorkspaceMutation(row));
	}

	listWorkspaceMutationIds(sessionId: string): string[] {
		return (
			this.db
				.prepare(
					"SELECT id FROM workspace_mutations WHERE session_id = ? ORDER BY created_at DESC",
				)
				.all(sessionId) as { id: string }[]
		).map((row) => row.id);
	}

	saveAgentRun(run: AgentRun): void {
		const parsed = AgentRunSchema.parse(run);
		this.db
			.prepare(`INSERT INTO agent_runs (id, session_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status, updated_at=excluded.updated_at`)
			.run(
				parsed.id,
				parsed.sessionId,
				JSON.stringify(parsed),
				parsed.status,
				parsed.createdAt,
				parsed.updatedAt,
			);
	}

	saveAgentRunIfActive(run: AgentRun): boolean {
		const parsed = AgentRunSchema.parse(run);
		return (
			this.db
				.prepare(`UPDATE agent_runs
      SET payload = ?, status = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND status IN ('running', 'waiting_approval')`)
				.run(
					JSON.stringify(parsed),
					parsed.status,
					parsed.updatedAt,
					parsed.id,
					parsed.sessionId,
				).changes === 1
		);
	}

	retireActiveAgentHistory(
		sessionId: string,
		completedAt: string,
		reason: string,
	): RetiredAgentHistory {
		return this.db.transaction(() =>
			this.retireActiveAgentHistoryInTransaction(
				sessionId,
				completedAt,
				reason,
			),
		)();
	}

	rollbackRuntimeHistory(input: {
		session: RuntimeSession;
		keepMessageCount: number;
		prunedCheckpointIds: string[];
		completedAt: string;
		reason: string;
	}): RuntimeHistoryRollbackResult {
		const session = RuntimeSessionSchema.parse(input.session);
		if (!Number.isInteger(input.keepMessageCount) || input.keepMessageCount < 0)
			throw new Error("Message truncation count is invalid.");
		if (!Number.isFinite(Date.parse(input.completedAt)))
			throw new Error("History rollback timestamp is invalid.");
		if (!input.reason.trim())
			throw new Error("History rollback reason is required.");
		return this.db.transaction(() => {
			const stored = this.db
				.prepare("SELECT id FROM runtime_sessions WHERE id = ?")
				.get(session.id) as { id: string } | undefined;
			if (!stored) throw new Error("Runtime session was not found.");
			const messageCount = (
				this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM runtime_message_order WHERE session_id = ?",
					)
					.get(session.id) as { count: number }
			).count;
			if (input.keepMessageCount > messageCount)
				throw new Error("History rollback exceeds the stored transcript.");

			const retired = this.retireActiveAgentHistoryInTransaction(
				session.id,
				input.completedAt,
				input.reason,
			);
			const ids = this.db
				.prepare(
					"SELECT message_id FROM runtime_message_order WHERE session_id = ? AND sequence > ? ORDER BY sequence DESC",
				)
				.all(session.id, input.keepMessageCount) as Array<{
				message_id: string;
			}>;
			const removeMessage = this.db.prepare(
				"DELETE FROM runtime_messages WHERE id = ? AND session_id = ?",
			);
			for (const { message_id } of ids)
				removeMessage.run(message_id, session.id);

			const updated = this.db
				.prepare(
					"UPDATE runtime_sessions SET payload = ?, status = ?, updated_at = ? WHERE id = ?",
				)
				.run(
					JSON.stringify(session),
					session.status,
					session.updatedAt,
					session.id,
				);
			if (updated.changes !== 1)
				throw new Error("Runtime session could not be rolled back.");
			const removeCheckpointState = this.db.prepare(
				"DELETE FROM private_runtime_state WHERE key = ?",
			);
			for (const checkpointId of [...new Set(input.prunedCheckpointIds)]) {
				if (!checkpointId) throw new Error("Pruned checkpoint ID is invalid.");
				removeCheckpointState.run(`session.checkpoint.${checkpointId}`);
			}
			return { session, ...retired };
		})();
	}

	getAgentRun(id: string): AgentRun | undefined {
		const row = this.db
			.prepare("SELECT payload FROM agent_runs WHERE id = ?")
			.get(id) as { payload: string } | undefined;
		return row ? AgentRunSchema.parse(JSON.parse(row.payload)) : undefined;
	}

	listAgentRuns(sessionId: string): AgentRun[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC",
				)
				.all(sessionId) as Array<{ payload: string }>
		).map((row) => AgentRunSchema.parse(JSON.parse(row.payload)));
	}

	listWaitingAgentRuns(): AgentRun[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM agent_runs WHERE status = 'waiting_approval' ORDER BY updated_at DESC, id DESC",
				)
				.all() as Array<{ payload: string }>
		).map((row) => AgentRunSchema.parse(JSON.parse(row.payload)));
	}

	saveModelCallAudit(audit: ModelCallAudit): void {
		const parsed = ModelCallAuditSchema.parse(audit);
		this.db
			.prepare(
				"INSERT OR REPLACE INTO model_call_audits (id, run_id, session_id, payload, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				parsed.id,
				parsed.runId,
				parsed.sessionId,
				JSON.stringify(parsed),
				parsed.status,
				parsed.startedAt,
			);
	}

	listModelCallAudits(runId: string): ModelCallAudit[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM model_call_audits WHERE run_id = ? ORDER BY started_at ASC",
				)
				.all(runId) as Array<{ payload: string }>
		).map((row) => ModelCallAuditSchema.parse(JSON.parse(row.payload)));
	}

	calculateSpending(
		dayStartIso: string,
		monthStartIso: string,
	): { dailyUsd: number; monthlyUsd: number } {
		const row = this.db
			.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN json_extract(payload, '$.completedAt') >= ? THEN json_extract(payload, '$.estimatedCostUsd') ELSE 0 END), 0) as dailyUsd,
        COALESCE(SUM(CASE WHEN json_extract(payload, '$.completedAt') >= ? THEN json_extract(payload, '$.estimatedCostUsd') ELSE 0 END), 0) as monthlyUsd
      FROM model_call_audits
    `)
			.get(dayStartIso, monthStartIso) as {
			dailyUsd: number;
			monthlyUsd: number;
		};
		return {
			dailyUsd: Math.round(row.dailyUsd * 100_000_000) / 100_000_000,
			monthlyUsd: Math.round(row.monthlyUsd * 100_000_000) / 100_000_000,
		};
	}

	listAllModelCallAudits(): ModelCallAudit[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM model_call_audits ORDER BY started_at ASC",
				)
				.all() as Array<{ payload: string }>
		).map((row) => ModelCallAuditSchema.parse(JSON.parse(row.payload)));
	}

	aggregateModelCallStats(): Array<{
		provider: string | null;
		model: string | null;
		outcome: string;
		calls: number;
		inputTokens: number;
		outputTokens: number;
		costUsd: number;
		durations: number[];
	}> {
		const rows = this.db
			.prepare(`
      SELECT
        json_extract(payload, '$.providerId') as providerId,
        json_extract(payload, '$.model') as model,
        CASE json_extract(payload, '$.status') WHEN 'completed' THEN 'success' ELSE 'error' END as outcome,
        COUNT(*) as calls,
        SUM(CAST(json_extract(payload, '$.inputTokens') as INTEGER)) as inputTokens,
        SUM(CAST(json_extract(payload, '$.outputTokens') as INTEGER)) as outputTokens,
        SUM(CAST(json_extract(payload, '$.estimatedCostUsd') as REAL)) as costUsd,
        json_group_array(CAST(json_extract(payload, '$.durationMs') as REAL) / 1000) as durationsStr
      FROM model_call_audits
      GROUP BY json_extract(payload, '$.providerId'), json_extract(payload, '$.model'), CASE json_extract(payload, '$.status') WHEN 'completed' THEN 'success' ELSE 'error' END
    `)
			.all() as Array<{
			providerId: string | null;
			model: string | null;
			outcome: string;
			calls: number;
			inputTokens: number | null;
			outputTokens: number | null;
			costUsd: number | null;
			durationsStr: string;
		}>;
		return rows.map((row) => ({
			provider: row.providerId,
			model: row.model,
			outcome: row.outcome,
			calls: row.calls,
			inputTokens: row.inputTokens ?? 0,
			outputTokens: row.outputTokens ?? 0,
			costUsd: row.costUsd ?? 0,
			durations: JSON.parse(row.durationsStr),
		}));
	}

	organizationAnalytics(): {
		sessions: number;
		messages: number;
		runs: number;
		toolExecutions: number;
		modelCalls: number;
		failedModelCalls: number;
		inputTokens: number;
		outputTokens: number;
		estimatedCostUsd: number;
	} {
		const count = (table: string) =>
			(
				this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
					count: number;
				}
			).count;

		const orgRaw = this.db
			.prepare(`
      SELECT
        COUNT(*) as modelCalls,
        SUM(CASE WHEN json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END) as failedModelCalls,
        SUM(CAST(json_extract(payload, '$.inputTokens') as INTEGER)) as inputTokens,
        SUM(CAST(json_extract(payload, '$.outputTokens') as INTEGER)) as outputTokens,
        SUM(CAST(json_extract(payload, '$.estimatedCostUsd') as REAL)) as estimatedCostUsd
      FROM model_call_audits
    `)
			.get() as {
			modelCalls: number;
			failedModelCalls: number | null;
			inputTokens: number | null;
			outputTokens: number | null;
			estimatedCostUsd: number | null;
		};

		return {
			sessions: count("runtime_sessions"),
			messages: count("runtime_messages"),
			runs: count("agent_runs"),
			toolExecutions: count("tool_executions"),
			modelCalls: orgRaw.modelCalls,
			failedModelCalls: orgRaw.failedModelCalls ?? 0,
			inputTokens: orgRaw.inputTokens ?? 0,
			outputTokens: orgRaw.outputTokens ?? 0,
			estimatedCostUsd:
				Math.round((orgRaw.estimatedCostUsd ?? 0) * 100_000_000) / 100_000_000,
		};
	}

	enforceRetention(
		cutoff: string,
	): Record<
		| "messages"
		| "memories"
		| "workspaceMutations"
		| "toolExecutions"
		| "modelCalls"
		| "runs"
		| "activity"
		| "browserActivity",
		number
	> {
		if (!Number.isFinite(Date.parse(cutoff)))
			throw new Error("Retention cutoff is invalid.");
		return this.db.transaction(() => {
			const remove = (sql: string) => this.db.prepare(sql).run(cutoff).changes;
			const messages = remove(
				"DELETE FROM runtime_messages WHERE created_at < ?",
			);
			const memories = remove("DELETE FROM memories WHERE updated_at < ?");
			const workspaceMutations = remove(
				"DELETE FROM workspace_mutations WHERE created_at < ?",
			);
			const toolExecutions = remove(
				"DELETE FROM tool_executions WHERE started_at < ?",
			);
			const modelCalls = remove(
				"DELETE FROM model_call_audits WHERE started_at < ?",
			);
			const runs = remove("DELETE FROM agent_runs WHERE updated_at < ?");
			const activity = remove("DELETE FROM audit_events WHERE created_at < ?");
			const browserActivity = remove(
				"DELETE FROM browser_activity_events WHERE created_at < ?",
			);
			return {
				messages,
				memories,
				workspaceMutations,
				toolExecutions,
				modelCalls,
				runs,
				activity,
				browserActivity,
			};
		})();
	}

	idempotent<T>(
		key: string,
		operation: () => T,
	): { result: T; repeated: boolean } {
		const existing = this.getIdempotentResult<T>(key);
		if (existing !== undefined) return { result: existing, repeated: true };
		const result = operation();
		this.saveIdempotentResult(key, result);
		return { result, repeated: false };
	}

	getIdempotentResult<T>(key: string): T | undefined {
		const row = this.db
			.prepare("SELECT result FROM idempotency_keys WHERE key = ?")
			.get(key) as { result: string } | undefined;
		return row ? (JSON.parse(row.result) as T) : undefined;
	}

	saveIdempotentResult(key: string, result: unknown): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO idempotency_keys (key, result, created_at) VALUES (?, ?, ?)",
			)
			.run(key, JSON.stringify(result), new Date().toISOString());
	}

	updateIdempotentResult(key: string, result: unknown): void {
		const update = this.db
			.prepare("UPDATE idempotency_keys SET result = ? WHERE key = ?")
			.run(JSON.stringify(result), key);
		if (update.changes !== 1)
			throw new Error("Idempotency journal entry does not exist.");
	}

	claimIdempotentResult<T>(
		key: string,
		ownerToken: string,
		ownerPid: number,
		pendingResult: T,
	): IdempotencyClaimResult<T> {
		this.validateIdempotencyOwner(key, ownerToken, ownerPid);
		const serializedPendingResult =
			this.serializeIdempotencyValue(pendingResult);
		const createdAt = new Date().toISOString();
		return this.db.transaction(() => {
			const insertion = this.db
				.prepare(`
        INSERT OR IGNORE INTO idempotency_claims (
          key, owner_token, owner_pid, pending_result, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
				.run(key, ownerToken, ownerPid, serializedPendingResult, createdAt);
			const completed = this.db
				.prepare("SELECT result FROM idempotency_keys WHERE key = ?")
				.get(key) as { result: string } | undefined;
			if (completed) {
				this.db
					.prepare("DELETE FROM idempotency_claims WHERE key = ?")
					.run(key);
				return {
					state: "completed" as const,
					result: JSON.parse(completed.result) as T,
				};
			}
			const row = this.db
				.prepare(`
        SELECT key, owner_token, owner_pid, pending_result, created_at
        FROM idempotency_claims WHERE key = ?
      `)
				.get(key) as IdempotencyClaimRow | undefined;
			if (!row)
				throw new Error("Idempotency claim could not be acquired or observed.");
			const claim = this.parseIdempotencyClaim<T>(row);
			return insertion.changes === 1
				? { state: "claimed" as const, claim }
				: { state: "active" as const, claim };
		})();
	}

	getIdempotentClaim<T>(key: string): IdempotencyClaim<T> | undefined {
		const row = this.db
			.prepare(`
      SELECT key, owner_token, owner_pid, pending_result, created_at
      FROM idempotency_claims WHERE key = ?
    `)
			.get(key) as IdempotencyClaimRow | undefined;
		return row ? this.parseIdempotencyClaim<T>(row) : undefined;
	}

	listIdempotentClaims<T>(prefix?: string): IdempotencyClaim<T>[] {
		const rows = this.db
			.prepare(`
      SELECT key, owner_token, owner_pid, pending_result, created_at
      FROM idempotency_claims ORDER BY created_at ASC, key ASC
    `)
			.all() as IdempotencyClaimRow[];
		return rows
			.filter((row) => prefix === undefined || row.key.startsWith(prefix))
			.map((row) => this.parseIdempotencyClaim<T>(row));
	}

	completeIdempotentResult<T>(
		key: string,
		ownerToken: string,
		result: T,
	): IdempotencyCompletion<T> {
		return this.finishIdempotentClaim(key, ownerToken, result);
	}

	abandonIdempotentClaim<T>(
		key: string,
		ownerToken: string,
		terminalResult: T,
	): IdempotencyCompletion<T> {
		return this.finishIdempotentClaim(key, ownerToken, terminalResult);
	}

	releaseIdempotentClaim(key: string, ownerToken: string): boolean {
		if (!key || !ownerToken)
			throw new Error("Idempotency claim key and owner token are required.");
		return (
			this.db
				.prepare(
					"DELETE FROM idempotency_claims WHERE key = ? AND owner_token = ?",
				)
				.run(key, ownerToken).changes === 1
		);
	}

	/**
	 * Reports whether the protected configuration table has ever been
	 * populated. Callers use this alongside decryptable records so a missing
	 * or unreadable head pointer cannot make an existing profile look like a
	 * first-run database.
	 */
	hasAgentConfigurationRecords(): boolean {
		return (
			this.db
				.prepare("SELECT 1 FROM agent_configuration_records LIMIT 1")
				.get() !== undefined
		);
	}

	saveAgentConfigurationVersion(version: AgentConfigurationVersion): void {
		const parsed = AgentConfigurationVersionSchema.parse(version);
		this.writeAgentConfigurationRecord(
			"version",
			parsed.id,
			parsed.knownGood ? "known_good" : "verified",
			parsed.createdAt,
			parsed.createdAt,
			parsed,
			true,
		);
	}

	getAgentConfigurationVersion(
		id: string,
	): AgentConfigurationVersion | undefined {
		const row = this.readAgentConfigurationRecord("version", id);
		return row
			? AgentConfigurationVersionSchema.parse(
					this.decryptAgentConfigurationRecord(row),
				)
			: undefined;
	}

	listAgentConfigurationVersions(): AgentConfigurationVersion[] {
		return this.listAgentConfigurationRecordRows("version")
			.map((row) =>
				AgentConfigurationVersionSchema.parse(
					this.decryptAgentConfigurationRecord(row),
				),
			)
			.sort((left, right) => left.sequence - right.sequence);
	}

	listValidAgentConfigurationVersions(): AgentConfigurationVersion[] {
		return this.listAgentConfigurationRecordRows("version")
			.flatMap((row) => {
				try {
					return [
						AgentConfigurationVersionSchema.parse(
							this.decryptAgentConfigurationRecord(row),
						),
					];
				} catch {
					return [];
				}
			})
			.sort((left, right) => left.sequence - right.sequence);
	}

	saveAgentConfigurationProposal(proposal: AgentConfigurationProposal): void {
		const parsed = AgentConfigurationProposalSchema.parse(proposal);
		this.writeAgentConfigurationRecord(
			"proposal",
			parsed.id,
			parsed.status,
			parsed.createdAt,
			parsed.updatedAt,
			parsed,
			false,
		);
	}

	getAgentConfigurationProposal(
		id: string,
	): AgentConfigurationProposal | undefined {
		const row = this.readAgentConfigurationRecord("proposal", id);
		return row
			? AgentConfigurationProposalSchema.parse(
					this.decryptAgentConfigurationRecord(row),
				)
			: undefined;
	}

	listAgentConfigurationProposals(): AgentConfigurationProposal[] {
		return this.listAgentConfigurationRecordRows("proposal").map((row) =>
			AgentConfigurationProposalSchema.parse(
				this.decryptAgentConfigurationRecord(row),
			),
		);
	}

	saveAgentConfigurationAuditEvent(event: AgentConfigurationAuditEvent): void {
		const parsed = AgentConfigurationAuditEventSchema.parse(event);
		this.writeAgentConfigurationRecord(
			"audit",
			parsed.id,
			parsed.action,
			parsed.createdAt,
			parsed.createdAt,
			parsed,
			true,
		);
	}

	listAgentConfigurationAuditEvents(): AgentConfigurationAuditEvent[] {
		return this.listAgentConfigurationRecordRows("audit").map((row) =>
			AgentConfigurationAuditEventSchema.parse(
				this.decryptAgentConfigurationRecord(row),
			),
		);
	}

	appendBrowserActivity(event: BrowserActivityEvent): void {
		const parsed = BrowserActivityEventSchema.parse(event);
		const encrypted = encryptText(JSON.stringify(parsed), this.encryptionKey);
		this.db
			.prepare(
				`INSERT INTO browser_activity_events (
          id, owner_session_id, surface, outcome, created_at,
          payload_ciphertext, payload_iv, payload_auth_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				parsed.id,
				parsed.ownerSessionId,
				parsed.surface,
				parsed.outcome,
				parsed.createdAt,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
			);
		this.db
			.prepare(
				`DELETE FROM browser_activity_events
         WHERE owner_session_id = ?
           AND id NOT IN (
             SELECT id FROM browser_activity_events
             WHERE owner_session_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`,
			)
			.run(
				parsed.ownerSessionId,
				parsed.ownerSessionId,
				MAX_BROWSER_ACTIVITY_PER_OWNER,
			);
	}

	listBrowserActivity(input: {
		ownerSessionId: string;
		limit?: number;
	}): BrowserActivityEvent[] {
		const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
		const rows = this.db
			.prepare(
				`SELECT id, owner_session_id, surface, outcome, created_at,
            payload_ciphertext, payload_iv, payload_auth_tag
         FROM browser_activity_events
         WHERE owner_session_id = ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT ?`,
			)
			.all(input.ownerSessionId, limit) as BrowserActivityRow[];
		return rows.map((row) =>
			BrowserActivityEventSchema.parse(
				JSON.parse(
					decryptText(
						{
							ciphertext: row.payload_ciphertext,
							iv: row.payload_iv,
							authTag: row.payload_auth_tag,
						},
						this.encryptionKey,
					),
				),
			),
		);
	}

	saveAgentImprovementProposal(proposal: AgentImprovementProposal): void {
		const parsed = AgentImprovementProposalSchema.parse(proposal);
		this.writeAgentConfigurationRecord(
			"improvement",
			parsed.id,
			parsed.status,
			parsed.createdAt,
			parsed.updatedAt,
			parsed,
			false,
		);
	}

	getAgentImprovementProposal(
		id: string,
	): AgentImprovementProposal | undefined {
		const row = this.readAgentConfigurationRecord("improvement", id);
		return row
			? AgentImprovementProposalSchema.parse(
					this.decryptAgentConfigurationRecord(row),
				)
			: undefined;
	}

	listAgentImprovementProposals(): AgentImprovementProposal[] {
		return this.listAgentConfigurationRecordRows("improvement").map((row) =>
			AgentImprovementProposalSchema.parse(
				this.decryptAgentConfigurationRecord(row),
			),
		);
	}

	commitAgentConfigurationVersion(input: {
		expectedHeadVersionId?: string;
		version: AgentConfigurationVersion;
		auditEvent: AgentConfigurationAuditEvent;
		proposal?: AgentConfigurationProposal;
	}): void {
		const version = AgentConfigurationVersionSchema.parse(input.version);
		const auditEvent = AgentConfigurationAuditEventSchema.parse(
			input.auditEvent,
		);
		const proposal = input.proposal
			? AgentConfigurationProposalSchema.parse(input.proposal)
			: undefined;
		this.db.transaction(() => {
			const currentHead = this.getState<string>("agent.configuration.head");
			if (currentHead !== input.expectedHeadVersionId)
				throw new Error(
					"Agent configuration changed after this plan was staged. Review a fresh diff before applying.",
				);
			this.saveAgentConfigurationVersion(version);
			if (proposal) this.saveAgentConfigurationProposal(proposal);
			this.saveAgentConfigurationAuditEvent(auditEvent);
			this.setState("agent.configuration.head", version.id);
		})();
	}

	saveMemoryVersion(version: MemoryVersion): void {
		const parsed = MemoryVersionSchema.parse(version);
		this.upsertEncryptedPayload(
			"memory_versions",
			"id",
			parsed.id,
			parsed,
			parsed.changedAt,
			{ memory_id: parsed.memoryId, changed_at: parsed.changedAt },
		);
	}

	listMemoryVersions(memoryId: string): MemoryVersion[] {
		return (
			this.db
				.prepare(
					"SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM memory_versions WHERE memory_id = ? ORDER BY changed_at DESC",
				)
				.all(memoryId) as EncryptedPayloadRow[]
		).map((row) => MemoryVersionSchema.parse(this.decryptPayload(row)));
	}

	upsertPerson(person: PersonRecord): void {
		const parsed = PersonRecordSchema.parse(person);
		this.upsertEncryptedPayload(
			"people",
			"id",
			parsed.id,
			parsed,
			parsed.updatedAt,
			{ status: parsed.status },
		);
	}

	getPerson(id: string): PersonRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM people WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as EncryptedPayloadRow | undefined;
		return row ? PersonRecordSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listPeople(includeArchived = true): PersonRecord[] {
		const rows = this.db
			.prepare(
				`SELECT payload_ciphertext, payload_iv, payload_auth_tag
         FROM people WHERE status != 'deleted'
         ORDER BY updated_at DESC`,
			)
			.all() as EncryptedPayloadRow[];
		return rows
			.map((row) => PersonRecordSchema.parse(this.decryptPayload(row)))
			.filter((person) => includeArchived || person.status === "active")
			.sort(
				(left, right) =>
					right.relevanceScore - left.relevanceScore ||
					right.updatedAt.localeCompare(left.updatedAt),
			);
	}

	upsertCalendarEvent(event: UnifiedCalendarEvent): void {
		const parsed = UnifiedCalendarEventSchema.parse(event);
		this.upsertEncryptedPayload(
			"calendar_events",
			"id",
			parsed.id,
			parsed,
			parsed.updatedAt,
			{ provider_id: parsed.providerId, status: parsed.status },
		);
	}

	getCalendarEvent(id: string): UnifiedCalendarEvent | undefined {
		const row = this.db
			.prepare(
				"SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM calendar_events WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as EncryptedPayloadRow | undefined;
		return row
			? UnifiedCalendarEventSchema.parse(this.decryptPayload(row))
			: undefined;
	}

	listCalendarEvents(): UnifiedCalendarEvent[] {
		return (
			this.db
				.prepare(
					`SELECT payload_ciphertext, payload_iv, payload_auth_tag
           FROM calendar_events WHERE status NOT IN ('deleted', 'superseded', 'cancelled')
           ORDER BY updated_at DESC`,
				)
				.all() as EncryptedPayloadRow[]
		)
			.map((row) => UnifiedCalendarEventSchema.parse(this.decryptPayload(row)))
			.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
	}

	saveContextUsage(bundle: AgentContextBundle): void {
		const parsed = AgentContextBundleSchema.parse(bundle);
		this.upsertEncryptedPayload(
			"context_usage",
			"id",
			parsed.id,
			parsed,
			parsed.createdAt,
			{ created_at: parsed.createdAt },
		);
	}

	listContextUsage(limit = 100): AgentContextBundle[] {
		const normalizedLimit = Number.isFinite(limit)
			? Math.max(1, Math.min(1_000, Math.floor(limit)))
			: 100;
		return (
			this.db
				.prepare(
					`SELECT payload_ciphertext, payload_iv, payload_auth_tag
           FROM context_usage ORDER BY created_at DESC LIMIT ?`,
				)
				.all(normalizedLimit) as EncryptedPayloadRow[]
		).map((row) => AgentContextBundleSchema.parse(this.decryptPayload(row)));
	}

	setCalendarSyncState(
		providerId: string,
		value: Record<string, unknown>,
	): void {
		this.upsertEncryptedPayload(
			"calendar_sync_state",
			"provider_id",
			providerId,
			value,
			new Date().toISOString(),
		);
	}

	getCalendarSyncState<T extends Record<string, unknown>>(
		providerId: string,
	): T | undefined {
		const row = this.db
			.prepare(
				"SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM calendar_sync_state WHERE provider_id = ?",
			)
			.get(providerId) as EncryptedPayloadRow | undefined;
		return row ? (this.decryptPayload(row) as T) : undefined;
	}

	setState(key: string, value: unknown): void {
		this.db
			.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
			.run(key, JSON.stringify(value), new Date().toISOString());
	}

	getState<T>(key: string): T | undefined {
		const row = this.db
			.prepare("SELECT value FROM runtime_state WHERE key = ?")
			.get(key) as { value: string } | undefined;
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	setPrivateState(key: string, value: unknown): void {
		const encrypted = encryptText(JSON.stringify(value), this.encryptionKey);
		this.db
			.prepare(`INSERT INTO private_runtime_state (key, value_ciphertext, value_iv, value_auth_tag, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_ciphertext=excluded.value_ciphertext, value_iv=excluded.value_iv,
      value_auth_tag=excluded.value_auth_tag, updated_at=excluded.updated_at`)
			.run(
				key,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
				new Date().toISOString(),
			);
	}

	getPrivateState<T>(key: string): T | undefined {
		const row = this.db
			.prepare(
				"SELECT value_ciphertext, value_iv, value_auth_tag FROM private_runtime_state WHERE key = ?",
			)
			.get(key) as
			| { value_ciphertext: string; value_iv: string; value_auth_tag: string }
			| undefined;
		if (!row) return undefined;
		const value = decryptText(
			{
				ciphertext: row.value_ciphertext,
				iv: row.value_iv,
				authTag: row.value_auth_tag,
			},
			this.encryptionKey,
		);
		return JSON.parse(value) as T;
	}

	private writeAgentConfigurationRecord(
		kind: AgentConfigurationRecordRow["kind"],
		id: string,
		status: string,
		createdAt: string,
		updatedAt: string,
		value: unknown,
		immutable: boolean,
	): void {
		const encrypted = encryptText(JSON.stringify(value), this.encryptionKey);
		if (immutable) {
			this.db
				.prepare(
					`INSERT INTO agent_configuration_records (
            id, kind, status, payload_ciphertext, payload_iv,
            payload_auth_tag, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					kind,
					status,
					encrypted.ciphertext,
					encrypted.iv,
					encrypted.authTag,
					createdAt,
					updatedAt,
				);
			return;
		}
		const result = this.db
			.prepare(
				`INSERT INTO agent_configuration_records (
          id, kind, status, payload_ciphertext, payload_iv,
          payload_auth_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          payload_ciphertext=excluded.payload_ciphertext,
          payload_iv=excluded.payload_iv,
          payload_auth_tag=excluded.payload_auth_tag,
          updated_at=excluded.updated_at
        WHERE agent_configuration_records.kind=excluded.kind`,
			)
			.run(
				id,
				kind,
				status,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
				createdAt,
				updatedAt,
			);
		if (result.changes !== 1)
			throw new Error("Agent configuration record kind cannot be changed.");
	}

	private readAgentConfigurationRecord(
		kind: AgentConfigurationRecordRow["kind"],
		id: string,
	): AgentConfigurationRecordRow | undefined {
		return this.db
			.prepare(
				`SELECT id, kind, status, payload_ciphertext, payload_iv,
          payload_auth_tag, created_at, updated_at
        FROM agent_configuration_records WHERE id = ? AND kind = ?`,
			)
			.get(id, kind) as AgentConfigurationRecordRow | undefined;
	}

	private listAgentConfigurationRecordRows(
		kind: AgentConfigurationRecordRow["kind"],
	): AgentConfigurationRecordRow[] {
		return this.db
			.prepare(
				`SELECT id, kind, status, payload_ciphertext, payload_iv,
          payload_auth_tag, created_at, updated_at
        FROM agent_configuration_records
        WHERE kind = ? ORDER BY created_at ASC, rowid ASC`,
			)
			.all(kind) as AgentConfigurationRecordRow[];
	}

	private decryptAgentConfigurationRecord(
		row: AgentConfigurationRecordRow,
	): unknown {
		return JSON.parse(
			decryptText(
				{
					ciphertext: row.payload_ciphertext,
					iv: row.payload_iv,
					authTag: row.payload_auth_tag,
				},
				this.encryptionKey,
			),
		) as unknown;
	}

	private withMemoryMetadata(memory: MemoryRecord): MemoryRecord {
		const row = this.db
			.prepare(
				"SELECT memory_id, payload_ciphertext, payload_iv, payload_auth_tag FROM memory_metadata WHERE memory_id = ?",
			)
			.get(memory.id) as MemoryMetadataRow | undefined;
		if (!row) return memory;
		return MemoryRecordSchema.parse({
			...memory,
			...(this.decryptPayload(row) as Record<string, unknown>),
		});
	}

	private upsertEncryptedPayload(
		table:
			| "memory_metadata"
			| "memory_versions"
			| "people"
			| "calendar_events"
			| "context_usage"
			| "calendar_sync_state",
		idColumn: "memory_id" | "id" | "provider_id",
		id: string,
		value: unknown,
		updatedAt: string,
		extra: Record<string, string> = {},
	): void {
		const allowedExtraColumns = {
			memory_id: "memory_id",
			changed_at: "changed_at",
			status: "status",
			provider_id: "provider_id",
			created_at: "created_at",
		} as const;
		const entries = Object.entries(extra).map(([key, columnValue]) => {
			const column =
				allowedExtraColumns[key as keyof typeof allowedExtraColumns];
			if (!column) throw new Error("Unsupported encrypted payload index.");
			return [column, columnValue] as const;
		});
		const encrypted = encryptText(JSON.stringify(value), this.encryptionKey);
		const columns = [
			idColumn,
			"payload_ciphertext",
			"payload_iv",
			"payload_auth_tag",
			...entries.map(([column]) => column),
			"updated_at",
		];
		const parameters = [
			id,
			encrypted.ciphertext,
			encrypted.iv,
			encrypted.authTag,
			...entries.map(([, columnValue]) => columnValue),
			updatedAt,
		];
		const updates = columns
			.filter((column) => column !== idColumn)
			.map((column) => `${column}=excluded.${column}`)
			.join(", ");
		this.db
			.prepare(
				`INSERT INTO ${table} (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(${idColumn}) DO UPDATE SET ${updates}`,
			)
			.run(...parameters);
	}

	private decryptPayload(row: EncryptedPayloadRow): unknown {
		return JSON.parse(
			decryptText(
				{
					ciphertext: row.payload_ciphertext,
					iv: row.payload_iv,
					authTag: row.payload_auth_tag,
				},
				this.encryptionKey,
			),
		);
	}

	private parseRuntimeMessage(row: RuntimeMessageRow): RuntimeMessage {
		const decrypted = decryptText(
			{
				ciphertext: row.content_ciphertext,
				iv: row.content_iv,
				authTag: row.content_auth_tag,
			},
			this.encryptionKey,
		);
		let stored: {
			content: string;
			modelToolCalls?: unknown;
			providerToolCallId?: unknown;
			toolName?: unknown;
		} = { content: decrypted };
		try {
			const candidate = JSON.parse(decrypted) as Record<string, unknown>;
			if (candidate.version === 2 && typeof candidate.content === "string")
				stored = candidate as typeof stored;
		} catch {
			// Version 1 rows stored the plaintext content directly inside the encrypted column.
		}
		return RuntimeMessageSchema.parse({
			id: row.id,
			sessionId: row.session_id,
			role: row.role,
			content: stored.content,
			...(stored.modelToolCalls
				? { modelToolCalls: stored.modelToolCalls }
				: {}),
			...(typeof stored.providerToolCallId === "string"
				? { providerToolCallId: stored.providerToolCallId }
				: {}),
			...(typeof stored.toolName === "string"
				? { toolName: stored.toolName }
				: {}),
			...(row.parent_message_id
				? { parentMessageId: row.parent_message_id }
				: {}),
			...(row.tool_execution_id
				? { toolExecutionId: row.tool_execution_id }
				: {}),
			createdAt: row.created_at,
		});
	}

	private parseWorkspaceMutation(row: WorkspaceMutationRow): WorkspaceMutation {
		const payload = decryptText(
			{
				ciphertext: row.payload_ciphertext,
				iv: row.payload_iv,
				authTag: row.payload_auth_tag,
			},
			this.encryptionKey,
		);
		return WorkspaceMutationSchema.parse(JSON.parse(payload));
	}

	private searchTerms(value: string): string[] {
		return [
			...new Set(
				value
					.normalize("NFKC")
					.toLowerCase()
					.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [],
			),
		].slice(0, 512);
	}

	private hashSearchTerm(term: string): string {
		return createHmac("sha256", this.encryptionKey)
			.update(`runtime-message:${term}`)
			.digest("hex");
	}

	private finishIdempotentClaim<T>(
		key: string,
		ownerToken: string,
		result: T,
	): IdempotencyCompletion<T> {
		if (!key || !ownerToken)
			throw new Error("Idempotency claim key and owner token are required.");
		const serializedResult = this.serializeIdempotencyValue(result);
		const createdAt = new Date().toISOString();
		return this.db.transaction(() => {
			const insertion = this.db
				.prepare(`
        INSERT OR IGNORE INTO idempotency_keys (key, result, created_at)
        SELECT key, ?, ? FROM idempotency_claims
        WHERE key = ? AND owner_token = ?
      `)
				.run(serializedResult, createdAt, key, ownerToken);
			const completed = this.db
				.prepare("SELECT result FROM idempotency_keys WHERE key = ?")
				.get(key) as { result: string } | undefined;
			if (!completed)
				throw new Error("Idempotency claim is not owned by this runtime.");
			this.db
				.prepare(
					"DELETE FROM idempotency_claims WHERE key = ? AND owner_token = ?",
				)
				.run(key, ownerToken);
			return {
				result: JSON.parse(completed.result) as T,
				completed: insertion.changes === 1,
			};
		})();
	}

	private parseIdempotencyClaim<T>(
		row: IdempotencyClaimRow,
	): IdempotencyClaim<T> {
		return {
			key: row.key,
			ownerToken: row.owner_token,
			ownerPid: row.owner_pid,
			pendingResult: JSON.parse(row.pending_result) as T,
			createdAt: row.created_at,
		};
	}

	private serializeIdempotencyValue(value: unknown): string {
		const serialized = JSON.stringify(value);
		if (serialized === undefined)
			throw new Error("Idempotency journal values must be JSON-serializable.");
		return serialized;
	}

	private retireActiveAgentHistoryInTransaction(
		sessionId: string,
		completedAt: string,
		reason: string,
	): RetiredAgentHistory {
		if (!Number.isFinite(Date.parse(completedAt)))
			throw new Error("History rollback timestamp is invalid.");
		if (!reason.trim()) throw new Error("History rollback reason is required.");
		const activeRuns = (
			this.db
				.prepare(
					"SELECT payload FROM agent_runs WHERE session_id = ? AND status IN ('running', 'waiting_approval') ORDER BY created_at ASC",
				)
				.all(sessionId) as Array<{ payload: string }>
		).map((row) => AgentRunSchema.parse(JSON.parse(row.payload)));
		if (activeRuns.length === 0) return { runs: [], toolExecutions: [] };

		const runIds = new Set(activeRuns.map((run) => run.id));
		const pendingExecutionIds = new Set(
			activeRuns.flatMap((run) =>
				run.pendingToolExecutionId ? [run.pendingToolExecutionId] : [],
			),
		);
		const candidates = (
			this.db
				.prepare(
					"SELECT payload FROM tool_executions WHERE session_id = ? AND status IN ('running', 'blocked') ORDER BY started_at ASC",
				)
				.all(sessionId) as Array<{ payload: string }>
		)
			.map((row) => RuntimeToolExecutionSchema.parse(JSON.parse(row.payload)))
			.filter(
				(execution) =>
					pendingExecutionIds.has(execution.id) ||
					(execution.idempotencyKey !== undefined &&
						[...runIds].some((runId) =>
							execution.idempotencyKey!.startsWith(`${runId}:`),
						)),
			);

		const saveExecution = this.db.prepare(
			"UPDATE tool_executions SET payload = ?, status = ? WHERE id = ? AND session_id = ?",
		);
		const toolExecutions = candidates.map((execution) => {
			const uncertain = execution.status === "running";
			const output = execution.output
				? { ...execution.output, approvalRequired: false }
				: undefined;
			const retired = RuntimeToolExecutionSchema.parse({
				...execution,
				status: uncertain ? "failed" : "cancelled",
				...(output ? { output } : {}),
				error: uncertain
					? `${reason} This action was already running, so its outcome is uncertain and it will not be retried automatically.`
					: reason,
				completedAt,
			});
			const saved = saveExecution.run(
				JSON.stringify(retired),
				retired.status,
				retired.id,
				retired.sessionId,
			);
			if (saved.changes !== 1)
				throw new Error("Pending tool execution could not be retired.");
			return retired;
		});

		const saveRun = this.db.prepare(
			"UPDATE agent_runs SET payload = ?, status = ?, updated_at = ? WHERE id = ? AND session_id = ? AND status IN ('running', 'waiting_approval')",
		);
		const runs = activeRuns.map((run) => {
			const {
				pendingToolExecutionId: _execution,
				pendingProviderToolCallId: _call,
				pendingToolName: _tool,
				...base
			} = run;
			const retired = AgentRunSchema.parse({
				...base,
				status: "cancelled",
				error: reason,
				updatedAt: completedAt,
			});
			const saved = saveRun.run(
				JSON.stringify(retired),
				retired.status,
				retired.updatedAt,
				retired.id,
				retired.sessionId,
			);
			if (saved.changes !== 1)
				throw new Error("Agent run could not be retired.");
			return retired;
		});
		return { runs, toolExecutions };
	}

	private validateIdempotencyOwner(
		key: string,
		ownerToken: string,
		ownerPid: number,
	): void {
		if (!key || !ownerToken)
			throw new Error("Idempotency claim key and owner token are required.");
		if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)
			throw new Error("Idempotency claim owner PID is invalid.");
	}

	close(): void {
		this.db.close();
	}
}
