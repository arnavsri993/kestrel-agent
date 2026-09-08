import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decryptText, encryptText } from "@kestrel/encryption";
import {
	type ActionReceipt,
	ActionReceiptSchema,
	type ActivityBlock,
	ActivityBlockSchema,
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
	type CapturePolicy,
	CapturePolicySchema,
	type DailySummary,
	DailySummarySchema,
	type EmbeddingRecord,
	EmbeddingRecordSchema,
	type EntityEdge,
	EntityEdgeSchema,
	type EntityKind,
	type EntityRecord,
	EntityRecordSchema,
	type AgentIdentity,
	AgentIdentitySchema,
	type AgentMemoryRecord,
	AgentMemoryRecordSchema,
	type MemoryJob,
	MemoryJobSchema,
	type MemoryJobKind,
	type MemoryDiagnostics,
	MemoryDiagnosticsSchema,
	type MemoryDeleteResult,
	MemoryDeleteResultSchema,
	type ProvenanceRecord,
	ProvenanceRecordSchema,
	type TimelineEvent,
	TimelineEventSchema,
	type TimelineEventType,
	type TimelineSession,
	TimelineSessionSchema,
	type WorkingTask,
	WorkingTaskSchema,
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
export type { MemoryDeleteResult } from "@kestrel/shared-types";
import Database from "better-sqlite3";
import {
	backupDatabaseBeforeMigration,
	LATEST_SCHEMA_VERSION,
	listMigrationVersions,
	loadMigrationSql,
} from "./migrations.js";

const MAX_BROWSER_ACTIVITY_PER_OWNER = 500;
const MAX_ACTION_RECEIPTS_PER_SESSION = 500;

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

export const DATABASE_INTEGRITY_ERROR_CODE = "kestrel-database-integrity";

/**
 * Signals that SQLite reported corruption or another integrity failure during
 * startup verification. Callers must not continue writing to the profile.
 */
export class DatabaseIntegrityError extends Error {
	readonly code = DATABASE_INTEGRITY_ERROR_CODE;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "DatabaseIntegrityError";
		if (cause !== undefined) this.cause = cause;
	}
}

export const DATABASE_MIGRATION_ERROR_CODE = "kestrel-database-migration";

/**
 * Signals that a schema migration failed after a pre-migration backup was taken.
 * The original database file is preserved; callers should surface `backupPath`.
 */
export class DatabaseMigrationError extends Error {
	readonly code = DATABASE_MIGRATION_ERROR_CODE;
	readonly backupPath: string | undefined;

	constructor(message: string, backupPath?: string, cause?: unknown) {
		super(message);
		this.name = "DatabaseMigrationError";
		this.backupPath = backupPath;
		if (cause !== undefined) this.cause = cause;
	}
}

export function isDatabaseIntegrityError(
	error: unknown,
): error is DatabaseIntegrityError {
	return (
		error instanceof DatabaseIntegrityError ||
		(typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === DATABASE_INTEGRITY_ERROR_CODE)
	);
}

export function isDatabaseMigrationError(
	error: unknown,
): error is DatabaseMigrationError {
	return (
		error instanceof DatabaseMigrationError ||
		(typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === DATABASE_MIGRATION_ERROR_CODE)
	);
}

const DATABASE_INTEGRITY_RECOVERY_MESSAGE =
	"Do not continue using this profile. Restore from a verified backup in Settings or check the recovery folder under Application Support before opening Kestrel again.";

function sqliteErrorDetail(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	return "unknown database error";
}

function isSqliteDatabaseIntegrityFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
	return /malformed|corrupt|not a database|database disk image/i.test(
		error.message,
	);
}

export {
	backupDatabaseBeforeMigration,
	LATEST_SCHEMA_VERSION,
	loadMigrationSql,
	resolveMigrationBackupDirectory,
} from "./migrations.js";

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

interface ActionReceiptRow extends EncryptedPayloadRow {
	id: string;
	session_id: string;
	tool_execution_id: string;
	status: ActionReceipt["outcome"];
	started_at: string;
	updated_at: string;
}

interface MemoryMetadataRow extends EncryptedPayloadRow {
	memory_id: string;
}

export interface TimelineEventListOptions {
	startAt?: string;
	endAt?: string;
	sessionId?: string;
	sourceSessionId?: string;
	agentId?: string;
	eventTypes?: readonly TimelineEventType[];
	projectIds?: readonly string[];
	personIds?: readonly string[];
	entityIds?: readonly string[];
	includeSensitive?: boolean;
	includeRestricted?: boolean;
	status?: "active" | "deleted";
	limit?: number;
	offset?: number;
	ascending?: boolean;
}

export interface TimelineEventMatch {
	event: TimelineEvent;
	lexicalScore: number;
}

type MemoryPayloadTable =
	| "memory_timeline_events"
	| "memory_timeline_sessions"
	| "memory_activity_blocks"
	| "memory_daily_summaries"
	| "memory_entities"
	| "memory_entity_edges"
	| "memory_agent_identities"
	| "memory_agent_memories"
	| "memory_working_tasks"
	| "memory_provenance"
	| "memory_capture_policies"
	| "memory_jobs"
	| "memory_embeddings";

interface MemorySubstrateRow extends EncryptedPayloadRow {
	id: string;
	started_at?: string;
	ended_at?: string | null;
	source_id?: string | null;
	source_session_id?: string | null;
	status?: string;
	day?: string;
	kind?: string;
	owner_type?: string;
	owner_id?: string;
	agent_id?: string;
	session_id?: string | null;
	parent_agent_id?: string | null;
	parent_task_id?: string | null;
	from_entity_id?: string;
	to_entity_id?: string;
	relation?: string;
	created_at: string;
	updated_at: string;
	importance?: number;
	confidence?: number;
	content_hash?: string;
	provider?: string;
	model?: string;
	locked_at?: string | null;
	lease_until?: string | null;
	last_error?: string | null;
	dedupe_key?: string;
	attempts?: number;
	max_attempts?: number;
	run_after?: string;
}

function uniqueMemoryIds(values: readonly string[], maximum = 2_000): string[] {
	return [...new Set(values.filter(Boolean))].slice(0, maximum);
}

function timelineTitle(events: readonly TimelineEvent[]): string {
	const first = events[0];
	if (!first) return "Activity";
	const summary = first.textSummary.replace(/\s+/gu, " ").trim();
	return summary.length > 100 ? `${summary.slice(0, 99)}…` : summary;
}

function timelineSummary(events: readonly TimelineEvent[], maximum: number): string {
	const value = events
		.map((event) => event.textSummary.replace(/\s+/gu, " ").trim())
		.filter(Boolean)
		.join(" ");
	return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

export class KestrelDatabase {
	readonly db: Database.Database;
	readonly lastMigrationBackupPath: string | undefined;

	constructor(
		private readonly filename: string,
		private readonly encryptionKey: Buffer,
	) {
		if (filename !== ":memory:")
			mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
		let database: Database.Database | undefined;
		try {
			database = new Database(filename);
			this.db = database;
			this.db.pragma("journal_mode = WAL");
			this.db.pragma("foreign_keys = ON");
			this.db.pragma("secure_delete = ON");
			this.assertDatabaseIntegrity();
			this.lastMigrationBackupPath = this.migrate();
		} catch (error) {
			try {
				database?.close();
			} catch {
				// Preserve the original startup error if cleanup also fails.
			}
			if (error instanceof DatabaseIntegrityError) throw error;
			if (error instanceof DatabaseMigrationError) throw error;
			if (isSqliteDatabaseIntegrityFailure(error)) {
				throw new DatabaseIntegrityError(
					`Kestrel's local database could not be opened safely (${sqliteErrorDetail(error)}). ${DATABASE_INTEGRITY_RECOVERY_MESSAGE}`,
					error,
				);
			}
			throw error;
		}
	}

	private assertDatabaseIntegrity(): void {
		const rows = this.db.pragma("integrity_check") as Array<{
			integrity_check: string;
		}>;
		const result = rows[0]?.integrity_check ?? "unknown";
		if (result === "ok") return;
		throw new DatabaseIntegrityError(
			`Kestrel's local database failed integrity verification (${result}). ${DATABASE_INTEGRITY_RECOVERY_MESSAGE}`,
		);
	}

	private getAppliedSchemaVersion(): number {
		try {
			const row = this.db
				.prepare("SELECT MAX(version) AS version FROM schema_migrations")
				.get() as { version: number | null } | undefined;
			return row?.version ?? 0;
		} catch {
			return 0;
		}
	}

	private pendingMigrationVersions(): number[] {
		const appliedVersion = this.getAppliedSchemaVersion();
		return listMigrationVersions().filter((version) => version > appliedVersion);
	}

	private migrate(): string | undefined {
		const pendingVersions = this.pendingMigrationVersions();
		let backupPath: string | undefined;
		if (
			this.filename !== ":memory:" &&
			pendingVersions.length > 0 &&
			this.getAppliedSchemaVersion() > 0
		) {
			this.db.pragma("wal_checkpoint(FULL)");
			backupPath = backupDatabaseBeforeMigration(
				this.filename,
				pendingVersions[0] ?? LATEST_SCHEMA_VERSION,
			);
		}

		try {
			this.db.transaction(() => {
					for (const version of pendingVersions) {
						// v015 repairs profiles created by an earlier development
						// build. Some of those profiles already have the repaired
						// column but not the migration marker, so do not replay the
						// non-idempotent ALTER TABLE statement.
						if (
							version === 15 &&
							(this.db.pragma("table_info(memory_provenance)") as Array<{ name?: string }>).some(
								(column) => column.name === "updated_at",
							)
						) {
							this.db
								.prepare(
									"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
								)
								.run(version, new Date().toISOString());
							continue;
						}
						// v016 adds source metadata to timeline events. Older development
						// builds could already have applied the ALTER TABLE statements
						// without recording the migration marker. Treat the columns as
						// idempotent in that recovery case instead of failing startup.
						if (
							version === 16 &&
							(this.db.pragma("table_info(memory_timeline_events)") as Array<{ name?: string }>).some(
								(column) => column.name === "source_id",
							) &&
							(this.db.pragma("table_info(memory_timeline_events)") as Array<{ name?: string }>).some(
								(column) => column.name === "source_session_id",
							)
						) {
							this.db
								.prepare(
									"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
								)
								.run(version, new Date().toISOString());
							continue;
						}
						this.db.exec(loadMigrationSql(version));
					this.db
						.prepare(
							"INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
						)
						.run(version, new Date().toISOString());
				}
			})();
		} catch (error) {
			const detail =
				error instanceof Error && error.message.trim()
					? error.message.trim()
					: "unknown migration error";
			const recoveryHint = backupPath
				? `Your original database was preserved at ${backupPath}. Restore that copy before opening Kestrel again.`
				: "No pre-migration backup was created because this database had not completed an earlier migration.";
			throw new DatabaseMigrationError(
				`Kestrel could not apply schema migrations (${detail}). ${recoveryHint}`,
				backupPath,
				error,
			);
		}

		return backupPath;
	}

	upsertMemory(memory: MemoryRecord): void {
		const parsed = MemoryRecordSchema.parse(memory);
		const encrypted = encryptText(parsed.content, this.encryptionKey);
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
		this.db.transaction(() => {
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
			this.upsertEncryptedPayload(
				"memory_metadata",
				"memory_id",
				parsed.id,
				metadata,
				parsed.updatedAt,
			);
		})();
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
				...(parsed.memoryRecallReceipt
					? { memoryRecallReceipt: parsed.memoryRecallReceipt }
					: {}),
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

	searchRuntimeMessages(
		query: string,
		limit = 20,
		sessionIds?: readonly string[],
	): RuntimeMessage[] {
		if (sessionIds) {
			const normalizedQuery = this.normalizeSearchText(query);
			if (!normalizedQuery) return [];
			const terms = this.searchTerms(query);
			const allowedSessionIds = new Set(sessionIds);
			return sessionIds
				.flatMap((sessionId) => this.listRuntimeMessages(sessionId))
				.filter((message) => allowedSessionIds.has(message.sessionId))
				.filter((message) => {
					const normalizedContent = this.normalizeSearchText(message.content);
					if (normalizedContent.includes(normalizedQuery)) return true;
					if (terms.length === 0) return false;
					const messageTerms = new Set(this.searchTerms(message.content));
					return terms.every((term) => messageTerms.has(term));
				})
				.sort(
					(left, right) =>
						right.createdAt.localeCompare(left.createdAt) ||
							 right.id.localeCompare(left.id),
				)
				.slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
		}
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

	saveActionReceipt(receipt: ActionReceipt): void {
		const parsed = ActionReceiptSchema.parse(receipt);
		const encrypted = encryptText(JSON.stringify(parsed), this.encryptionKey);
		const updatedAt = parsed.completedAt ?? parsed.startedAt;
		this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO action_receipts (
          id, session_id, tool_execution_id, status, started_at, updated_at,
          payload_ciphertext, payload_iv, payload_auth_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id=excluded.session_id,
          tool_execution_id=excluded.tool_execution_id,
          status=excluded.status,
          started_at=excluded.started_at,
          updated_at=excluded.updated_at,
          payload_ciphertext=excluded.payload_ciphertext,
          payload_iv=excluded.payload_iv,
          payload_auth_tag=excluded.payload_auth_tag`,
				)
				.run(
					parsed.id,
					parsed.sessionId,
					parsed.toolExecutionId,
					parsed.outcome,
					parsed.startedAt,
					updatedAt,
					encrypted.ciphertext,
					encrypted.iv,
					encrypted.authTag,
				);
			this.db
				.prepare(
					`DELETE FROM action_receipts
         WHERE session_id = ?
           AND id NOT IN (
             SELECT id FROM action_receipts
             WHERE session_id = ?
             ORDER BY started_at DESC, rowid DESC
             LIMIT ?
           )`,
				)
				.run(
					parsed.sessionId,
					parsed.sessionId,
					MAX_ACTION_RECEIPTS_PER_SESSION,
				);
		})();
	}

	getActionReceiptForExecution(toolExecutionId: string): ActionReceipt | undefined {
		if (!toolExecutionId) throw new Error("Tool execution ID is required.");
		const row = this.db
			.prepare(
				`SELECT id, session_id, tool_execution_id, status, started_at, updated_at,
                payload_ciphertext, payload_iv, payload_auth_tag
           FROM action_receipts WHERE tool_execution_id = ?`,
			)
			.get(toolExecutionId) as ActionReceiptRow | undefined;
		return row ? this.parseActionReceipt(row) : undefined;
	}

	listActionReceipts(sessionId: string, limit = 500): ActionReceipt[] {
		if (!sessionId) throw new Error("Runtime session ID is required.");
		const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
		const rows = this.db
			.prepare(
				`SELECT * FROM (
           SELECT id, session_id, tool_execution_id, status, started_at, updated_at,
                  payload_ciphertext, payload_iv, payload_auth_tag
             FROM action_receipts
            WHERE session_id = ?
            ORDER BY started_at DESC, rowid DESC
            LIMIT ?
         ) ORDER BY started_at ASC`,
			)
			.all(sessionId, boundedLimit) as ActionReceiptRow[];
		return rows.map((row) => this.parseActionReceipt(row));
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
      WHERE id = ? AND session_id = ? AND status IN ('running', 'waiting_approval', 'waiting_input')`)
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

	listRunningAgentRuns(): AgentRun[] {
		return (
			this.db
				.prepare(
					"SELECT payload FROM agent_runs WHERE status = 'running' ORDER BY updated_at ASC, id ASC",
				)
				.all() as Array<{ payload: string }>
		).map((row) => AgentRunSchema.parse(JSON.parse(row.payload)));
	}

	interruptAgentRunAfterRestart(input: {
		runId: string;
		interruptedAt: string;
		reason: string;
		expectedSessionClaimOwnerToken?: string;
	}): RetiredAgentHistory {
		if (!input.runId) throw new Error("Interrupted agent run ID is required.");
		if (!Number.isFinite(Date.parse(input.interruptedAt)))
			throw new Error("Agent run interruption timestamp is invalid.");
		if (!input.reason.trim())
			throw new Error("Agent run interruption reason is required.");
		if (input.expectedSessionClaimOwnerToken === "")
			throw new Error("Agent run session claim owner is invalid.");

		return this.db.transaction(() => {
			const row = this.db
				.prepare("SELECT payload FROM agent_runs WHERE id = ? AND status = 'running'")
				.get(input.runId) as { payload: string } | undefined;
			if (!row) return { runs: [], toolExecutions: [] };
			const run = AgentRunSchema.parse(JSON.parse(row.payload));
			const sessionClaimKey = `agent-session-run:${run.sessionId}`;
			const currentSessionClaim = this.db
				.prepare(
					"SELECT owner_token FROM idempotency_claims WHERE key = ?",
				)
				.get(sessionClaimKey) as { owner_token: string } | undefined;
			if (
				currentSessionClaim &&
				currentSessionClaim.owner_token !== input.expectedSessionClaimOwnerToken
			)
				return { runs: [], toolExecutions: [] };

			const saveExecution = this.db.prepare(
				"UPDATE tool_executions SET payload = ?, status = ? WHERE id = ? AND session_id = ? AND status = 'running'",
			);
			const toolExecutions = (
				this.db
					.prepare(
						"SELECT payload FROM tool_executions WHERE session_id = ? AND status = 'running' ORDER BY started_at ASC",
					)
					.all(run.sessionId) as Array<{ payload: string }>
			)
				.map((executionRow) =>
					RuntimeToolExecutionSchema.parse(JSON.parse(executionRow.payload)),
				)
				.filter((execution) =>
					execution.idempotencyKey?.startsWith(`${run.id}:`),
				)
				.map((execution) => {
					const interrupted = RuntimeToolExecutionSchema.parse({
						...execution,
						status: "failed",
						outcomeUncertain: true,
						error: `${input.reason} This tool was already running, so its outcome is uncertain and it will not be retried automatically.`,
						completedAt: input.interruptedAt,
					});
					const saved = saveExecution.run(
						JSON.stringify(interrupted),
						interrupted.status,
						interrupted.id,
						interrupted.sessionId,
					);
					if (saved.changes !== 1)
						throw new Error("Interrupted tool execution could not be retired.");
					return interrupted;
				});

			const {
				pendingToolExecutionId: _execution,
				pendingProviderToolCallId: _call,
				pendingToolName: _tool,
				...base
			} = run;
			const interrupted = AgentRunSchema.parse({
				...base,
				status: "failed",
				recovery: {
					reason: "core_restarted",
					action: "retry_last_turn",
				},
				error: input.reason,
				updatedAt: input.interruptedAt,
			});
			const saved = this.db
				.prepare(
					"UPDATE agent_runs SET payload = ?, status = ?, updated_at = ? WHERE id = ? AND session_id = ? AND status = 'running'",
				)
				.run(
					JSON.stringify(interrupted),
					interrupted.status,
					interrupted.updatedAt,
					interrupted.id,
					interrupted.sessionId,
				);
			if (saved.changes !== 1)
				throw new Error("Interrupted agent run could not be retired.");
			if (currentSessionClaim)
				this.db
					.prepare(
						"DELETE FROM idempotency_claims WHERE key = ? AND owner_token = ?",
					)
					.run(sessionClaimKey, currentSessionClaim.owner_token);
			return { runs: [interrupted], toolExecutions };
		})();
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
		| "actionReceipts"
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
			// Memory metadata and version history have deliberately restrictive
			// foreign keys so a stray write cannot orphan encrypted context. Retention
			// is the authorized parent deletion path, so remove those dependents in the
			// same transaction before deleting the expired memories themselves.
			this.db
				.prepare(
					"DELETE FROM memory_versions WHERE memory_id IN (SELECT id FROM memories WHERE updated_at < ?)",
				)
				.run(cutoff);
			this.db
				.prepare(
					"DELETE FROM memory_metadata WHERE memory_id IN (SELECT id FROM memories WHERE updated_at < ?)",
				)
				.run(cutoff);
			const memories = remove("DELETE FROM memories WHERE updated_at < ?");
			// A mutation may finish just after its tool execution crosses the cutoff.
			// Delete that dependent row with the expired execution instead of either
			// violating the foreign key or retaining the parent past policy.
			const workspaceMutations = this.db
				.prepare(
					`DELETE FROM workspace_mutations
					 WHERE created_at < ?
					    OR tool_execution_id IN (
					      SELECT id FROM tool_executions WHERE started_at < ?
					    )`,
				)
				.run(cutoff, cutoff).changes;
			const actionReceipts = this.db
				.prepare(
					`DELETE FROM action_receipts
					 WHERE updated_at < ?
					    OR tool_execution_id IN (
					      SELECT id FROM tool_executions WHERE started_at < ?
					    )`,
				)
				.run(cutoff, cutoff).changes;
			const toolExecutions = remove(
				"DELETE FROM tool_executions WHERE started_at < ?",
			);
			const modelCalls = this.db
				.prepare(
					`DELETE FROM model_call_audits
					 WHERE started_at < ?
					    OR run_id IN (
					      SELECT id FROM agent_runs WHERE updated_at < ?
					    )`,
				)
				.run(cutoff, cutoff).changes;
			const runs = remove("DELETE FROM agent_runs WHERE updated_at < ?");
			const activity = remove("DELETE FROM audit_events WHERE created_at < ?");
			const browserActivity = remove(
				"DELETE FROM browser_activity_events WHERE created_at < ?",
			);
			return {
				messages,
				memories,
				workspaceMutations,
				actionReceipts,
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
		this.db.transaction(() => {
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
		})();
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

	/** Persist a normalized timeline event and its keyed lexical index atomically. */
	upsertTimelineEvent(event: TimelineEvent): void {
		const parsed = TimelineEventSchema.parse(event);
		this.db.transaction(() => {
			this.upsertMemoryPayload(
				"memory_timeline_events",
				parsed.id,
				parsed,
					{
						started_at: parsed.startedAt,
						ended_at: parsed.endedAt ?? null,
						event_type: parsed.eventType,
						source: parsed.source,
						source_id: parsed.sourceId ?? null,
						source_session_id: parsed.sourceSessionId ?? null,
						session_id: parsed.sessionId ?? null,
					actor: parsed.actor,
					agent_id: parsed.agentId ?? null,
					subagent_id: parsed.subagentId ?? null,
					task_id: parsed.taskId ?? null,
					importance: parsed.importance,
					sensitivity: parsed.sensitivity,
					retention_policy: parsed.retentionPolicy,
					status: parsed.status,
					created_at: parsed.createdAt,
				},
				parsed.updatedAt,
			);
			this.db
				.prepare("DELETE FROM memory_timeline_event_terms WHERE event_id = ?")
				.run(parsed.id);
			const insertTerm = this.db.prepare(
				"INSERT OR IGNORE INTO memory_timeline_event_terms (event_id, term_hash) VALUES (?, ?)",
			);
			for (const term of this.memorySearchTerms(parsed.textSummary))
				insertTerm.run(parsed.id, this.hashMemoryTerm(term));
			this.db
				.prepare("DELETE FROM memory_timeline_event_links WHERE event_id = ?")
				.run(parsed.id);
			const insertLink = this.db.prepare(
				"INSERT OR IGNORE INTO memory_timeline_event_links (event_id, link_type, link_id) VALUES (?, ?, ?)",
			);
			for (const [linkType, ids] of [
				["project", parsed.projectIds],
				["person", parsed.personIds],
				["entity", parsed.entityIds],
			] as const)
				for (const linkId of ids) insertLink.run(parsed.id, linkType, linkId);
		})();
	}

	getTimelineEvent(id: string): TimelineEvent | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_timeline_events WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as MemorySubstrateRow | undefined;
		return row ? TimelineEventSchema.parse(this.decryptPayload(row)) : undefined;
	}

	/**
	 * Permanently remove one timeline event and every derived aggregate that
	 * contains its plaintext summary. Privacy deletion must not leave a stale
	 * activity block, session summary, provenance row, or embedding behind.
	 */
	deleteTimelineEvent(id: string): TimelineEvent | undefined {
		const event = this.getTimelineEvent(id);
		if (!event) return undefined;
		this.db.transaction(() => {
			this.deleteTimelineEventInternal(id, new Date().toISOString());
		})();
		return event;
	}

	listTimelineEvents(options: TimelineEventListOptions = {}): TimelineEvent[] {
		const conditions = [
			`e.status = '${options.status === "deleted" ? "deleted" : "active"}'`,
		];
		const parameters: Array<string | number> = [];
		if (options.startAt && options.endAt) {
			conditions.push("e.started_at < ?", "(e.ended_at IS NULL OR e.ended_at >= ?)");
			parameters.push(options.endAt, options.startAt);
		} else if (options.startAt) {
			conditions.push("(e.ended_at IS NULL OR e.ended_at >= ?)");
			parameters.push(options.startAt);
		} else if (options.endAt) {
			conditions.push("e.started_at < ?");
			parameters.push(options.endAt);
		}
			if (options.sessionId) {
				conditions.push("e.session_id = ?");
				parameters.push(options.sessionId);
			}
			if (options.sourceSessionId) {
				conditions.push("e.source_session_id = ?");
				parameters.push(options.sourceSessionId);
			}
			if (options.agentId) {
			conditions.push("(e.agent_id = ? OR e.subagent_id = ?)");
			parameters.push(options.agentId, options.agentId);
		}
		if (options.eventTypes?.length) {
			conditions.push(
				`e.event_type IN (${options.eventTypes.map(() => "?").join(", ")})`,
			);
			parameters.push(...options.eventTypes);
		}
		this.appendTimelineRelationConditions(conditions, parameters, options);
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(2_000, Math.trunc(options.limit!)))
			: 500;
		const offset = Number.isFinite(options.offset)
			? Math.max(0, Math.min(10_000_000, Math.trunc(options.offset!)))
			: 0;
		const rows = this.db
			.prepare(
				`SELECT e.* FROM memory_timeline_events e
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY e.started_at ${options.ascending === false ? "DESC" : "ASC"}, e.id ${options.ascending === false ? "DESC" : "ASC"}
					 LIMIT ? OFFSET ?`,
			)
			.all(...parameters, limit, offset) as MemorySubstrateRow[];
		return rows
			.map((row) => TimelineEventSchema.parse(this.decryptPayload(row)))
			.filter((event) => this.substrateSensitivityAllowed(event.sensitivity, options))
			.filter((event) => this.matchesTimelineRelations(event, options));
	}

	searchTimelineEvents(
		query: string,
		options: TimelineEventListOptions = {},
	): TimelineEventMatch[] {
		const terms = this.memorySearchTerms(query);
		if (!terms.length)
			return this.listTimelineEvents(options).map((event) => ({
				event,
				lexicalScore: 0,
			}));
		const conditions = [
			`e.status = '${options.status === "deleted" ? "deleted" : "active"}'`,
			`t.term_hash IN (${terms.map(() => "?").join(", ")})`,
		];
		const parameters: Array<string | number> = terms.map((term) =>
			this.hashMemoryTerm(term),
		);
		if (options.startAt && options.endAt) {
			conditions.push("e.started_at < ?", "(e.ended_at IS NULL OR e.ended_at >= ?)");
			parameters.push(options.endAt, options.startAt);
		} else if (options.startAt) {
			conditions.push("(e.ended_at IS NULL OR e.ended_at >= ?)");
			parameters.push(options.startAt);
		} else if (options.endAt) {
			conditions.push("e.started_at < ?");
			parameters.push(options.endAt);
		}
			if (options.sessionId) {
				conditions.push("e.session_id = ?");
				parameters.push(options.sessionId);
			}
			if (options.sourceSessionId) {
				conditions.push("e.source_session_id = ?");
				parameters.push(options.sourceSessionId);
			}
			if (options.agentId) {
			conditions.push("(e.agent_id = ? OR e.subagent_id = ?)");
			parameters.push(options.agentId, options.agentId);
		}
		if (options.eventTypes?.length) {
			conditions.push(
				`e.event_type IN (${options.eventTypes.map(() => "?").join(", ")})`,
			);
			parameters.push(...options.eventTypes);
		}
		this.appendTimelineRelationConditions(conditions, parameters, options);
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(2_000, Math.trunc(options.limit!)))
			: 200;
		const offset = Number.isFinite(options.offset)
			? Math.max(0, Math.min(10_000_000, Math.trunc(options.offset!)))
			: 0;
		const rows = this.db
			.prepare(
				`SELECT e.*, COUNT(DISTINCT t.term_hash) AS matched_terms
				 FROM memory_timeline_events e
				 JOIN memory_timeline_event_terms t ON t.event_id = e.id
				 WHERE ${conditions.join(" AND ")}
				 GROUP BY e.id
				 HAVING matched_terms > 0
				 ORDER BY matched_terms DESC, e.started_at DESC, e.id DESC
					 LIMIT ? OFFSET ?`,
			)
			.all(...parameters, limit, offset) as Array<MemorySubstrateRow & { matched_terms: number }>;
		return rows
			.map((row) => ({
				event: TimelineEventSchema.parse(this.decryptPayload(row)),
				lexicalScore: Math.min(1, row.matched_terms / terms.length),
			}))
			.filter(({ event }) => this.substrateSensitivityAllowed(event.sensitivity, options))
			.filter(({ event }) => this.matchesTimelineRelations(event, options));
	}

	upsertTimelineSession(session: TimelineSession): void {
		const parsed = TimelineSessionSchema.parse(session);
		this.upsertMemoryPayload(
			"memory_timeline_sessions",
			parsed.id,
			parsed,
			{
				started_at: parsed.startedAt,
				ended_at: parsed.endedAt ?? null,
				status: parsed.status,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getTimelineSession(id: string): TimelineSession | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_timeline_sessions WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as MemorySubstrateRow | undefined;
		return row ? TimelineSessionSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listTimelineSessions(options: {
		startAt?: string;
		endAt?: string;
		status?: TimelineSession["status"];
		limit?: number;
	} = {}): TimelineSession[] {
		const conditions = [
			options.status
				? `status = '${options.status}'`
				: "status IN ('active', 'closed')",
		];
		const parameters: Array<string | number> = [];
		if (options.startAt) {
			conditions.push("(ended_at IS NULL OR ended_at >= ?)");
			parameters.push(options.startAt);
		}
		if (options.endAt) {
			conditions.push("started_at < ?");
			parameters.push(options.endAt);
		}
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(500, Math.trunc(options.limit!)))
			: 200;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_timeline_sessions WHERE ${conditions.join(" AND ")}
				 ORDER BY started_at ASC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows.map((row) => TimelineSessionSchema.parse(this.decryptPayload(row)));
	}

	upsertActivityBlock(block: ActivityBlock): void {
		const parsed = ActivityBlockSchema.parse(block);
		this.upsertMemoryPayload(
			"memory_activity_blocks",
			parsed.id,
			parsed,
			{
				session_id: parsed.sessionId,
				started_at: parsed.startedAt,
				ended_at: parsed.endedAt ?? null,
				importance: parsed.importance,
				confidence: parsed.confidence,
				status: parsed.status,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getActivityBlock(id: string): ActivityBlock | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_activity_blocks WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as MemorySubstrateRow | undefined;
		return row ? ActivityBlockSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listActivityBlocks(options: {
		sessionId?: string;
		startAt?: string;
		endAt?: string;
		limit?: number;
	} = {}): ActivityBlock[] {
		const conditions = ["status = 'active'"];
		const parameters: Array<string | number> = [];
		if (options.sessionId) {
			conditions.push("session_id = ?");
			parameters.push(options.sessionId);
		}
		if (options.startAt) {
			conditions.push("(ended_at IS NULL OR ended_at >= ?)");
			parameters.push(options.startAt);
		}
		if (options.endAt) {
			conditions.push("started_at < ?");
			parameters.push(options.endAt);
		}
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(1_000, Math.trunc(options.limit!)))
			: 500;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_activity_blocks WHERE ${conditions.join(" AND ")}
				 ORDER BY started_at ASC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows.map((row) => ActivityBlockSchema.parse(this.decryptPayload(row)));
	}

	upsertDailySummary(summary: DailySummary): void {
		const parsed = DailySummarySchema.parse(summary);
		const encrypted = encryptText(JSON.stringify(parsed), this.encryptionKey);
		this.db
			.prepare(
				`INSERT INTO memory_daily_summaries
				 (id, day, created_at, updated_at, payload_ciphertext, payload_iv, payload_auth_tag)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(day) DO UPDATE SET
				 id=excluded.id, created_at=excluded.created_at, updated_at=excluded.updated_at,
				 payload_ciphertext=excluded.payload_ciphertext, payload_iv=excluded.payload_iv,
				 payload_auth_tag=excluded.payload_auth_tag`,
			)
			.run(
				parsed.id,
				parsed.day,
				parsed.createdAt,
				parsed.updatedAt,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
			);
	}

	getDailySummary(dayOrId: string): DailySummary | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_daily_summaries WHERE day = ? OR id = ? LIMIT 1",
			)
			.get(dayOrId, dayOrId) as MemorySubstrateRow | undefined;
		return row ? DailySummarySchema.parse(this.decryptPayload(row)) : undefined;
	}

	listDailySummaries(limit = 100): DailySummary[] {
		const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
		const rows = this.db
			.prepare("SELECT * FROM memory_daily_summaries ORDER BY day DESC, id DESC LIMIT ?")
			.all(bounded) as MemorySubstrateRow[];
		return rows.map((row) => DailySummarySchema.parse(this.decryptPayload(row)));
	}

	upsertMemoryEntity(entity: EntityRecord): void {
		const parsed = EntityRecordSchema.parse(entity);
		this.upsertMemoryPayload(
			"memory_entities",
			parsed.id,
			parsed,
			{
				kind: parsed.kind,
				canonical_name_hash: this.hashMemoryTerm(parsed.canonicalName),
				sensitivity: parsed.sensitivity,
				status: parsed.status,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getMemoryEntity(id: string): EntityRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_entities WHERE id = ? AND status != 'deleted'")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? EntityRecordSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listMemoryEntities(options: {
		kind?: EntityKind;
		includeAmbiguous?: boolean;
		includeSensitive?: boolean;
		includeRestricted?: boolean;
		limit?: number;
	} = {}): EntityRecord[] {
		const conditions = ["status != 'deleted'"];
		const parameters: Array<string | number> = [];
		if (options.kind) {
			conditions.push("kind = ?");
			parameters.push(options.kind);
		}
		if (!options.includeAmbiguous) conditions.push("status = 'active'");
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(2_000, Math.trunc(options.limit!)))
			: 500;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_entities WHERE ${conditions.join(" AND ")}
				 ORDER BY updated_at DESC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows
			.map((row) => EntityRecordSchema.parse(this.decryptPayload(row)))
			.filter((entity) =>
				this.substrateSensitivityAllowed(entity.sensitivity, options),
			);
	}

	findMemoryEntities(
		query: string,
		options: {
			kind?: EntityKind;
			includeAmbiguous?: boolean;
			includeSensitive?: boolean;
			includeRestricted?: boolean;
			limit?: number;
		} = {},
	): EntityRecord[] {
		const normalized = this.normalizeMemoryText(query);
		if (!normalized) return [];
		return this.listMemoryEntities(options)
			.map((entity) => {
				const aliases = [entity.canonicalName, ...entity.aliases].map((value) =>
					this.normalizeMemoryText(value),
				);
				const exact = aliases.some((alias) => alias === normalized);
				const partial = aliases.some(
					(alias) => alias.includes(normalized) || normalized.includes(alias),
				);
				return { entity, score: exact ? 3 : partial ? 1 : 0 };
			})
			.filter(({ score }) => score > 0)
			.sort(
				(left, right) =>
					right.score - left.score ||
					right.entity.confidence - left.entity.confidence ||
					right.entity.updatedAt.localeCompare(left.entity.updatedAt),
			)
			.slice(0, Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20))))
			.map(({ entity }) => entity);
	}

	upsertMemoryEntityEdge(edge: EntityEdge): void {
		const parsed = EntityEdgeSchema.parse(edge);
		this.upsertMemoryPayload(
			"memory_entity_edges",
			parsed.id,
			parsed,
			{
				from_entity_id: parsed.fromEntityId,
				to_entity_id: parsed.toEntityId,
				relation: parsed.relation,
				weight: parsed.weight,
				status: parsed.status,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getMemoryEntityEdge(id: string): EntityEdge | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_entity_edges WHERE id = ? AND status != 'deleted'")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? EntityEdgeSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listMemoryEntityEdges(entityId?: string): EntityEdge[] {
		const rows = entityId
			? (this.db
					.prepare(
						"SELECT * FROM memory_entity_edges WHERE status = 'active' AND (from_entity_id = ? OR to_entity_id = ?) ORDER BY updated_at DESC, id ASC",
					)
					.all(entityId, entityId) as MemorySubstrateRow[])
			: (this.db
					.prepare(
						"SELECT * FROM memory_entity_edges WHERE status = 'active' ORDER BY updated_at DESC, id ASC",
					)
					.all() as MemorySubstrateRow[]);
		return rows.map((row) => EntityEdgeSchema.parse(this.decryptPayload(row)));
	}

	upsertAgentIdentity(identity: AgentIdentity): void {
		const parsed = AgentIdentitySchema.parse(identity);
		this.upsertMemoryPayload(
			"memory_agent_identities",
			parsed.id,
			parsed,
			{
				kind: parsed.kind,
				parent_agent_id: parsed.parentAgentId ?? null,
				session_id: parsed.sessionId ?? null,
				status: parsed.status,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getAgentIdentity(id: string): AgentIdentity | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_agent_identities WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as MemorySubstrateRow | undefined;
		return row ? AgentIdentitySchema.parse(this.decryptPayload(row)) : undefined;
	}

	getAgentIdentityBySession(sessionId: string): AgentIdentity | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_agent_identities WHERE session_id = ? AND status != 'deleted' ORDER BY updated_at DESC LIMIT 1",
			)
			.get(sessionId) as MemorySubstrateRow | undefined;
		return row ? AgentIdentitySchema.parse(this.decryptPayload(row)) : undefined;
	}

	listAgentIdentities(includeArchived = true): AgentIdentity[] {
		const rows = this.db
			.prepare(
			`SELECT * FROM memory_agent_identities
			 WHERE status != 'deleted'${includeArchived ? "" : " AND status = 'active'"}
			 ORDER BY updated_at DESC, id ASC`,
			)
			.all() as MemorySubstrateRow[];
		return rows.map((row) => AgentIdentitySchema.parse(this.decryptPayload(row)));
	}

	/**
	 * Move an agent's encrypted records to a stable identity without deleting
	 * their provenance or embeddings. This is used when older builds created a
	 * new main-agent id for every root runtime session.
	 */
	migrateAgentIdentity(oldId: string, identity: AgentIdentity): void {
		if (!oldId.trim()) throw new Error("The source agent identity is required.");
		const parsed = AgentIdentitySchema.parse(identity);
		if (oldId === parsed.id) {
			this.upsertAgentIdentity(parsed);
			return;
		}
		this.db.transaction(() => {
			const existing = this.getAgentIdentity(parsed.id);
			const target = existing
				? { ...parsed, createdAt: existing.createdAt }
				: parsed;
			this.upsertMemoryPayload(
				"memory_agent_identities",
				target.id,
				target,
				{
					kind: target.kind,
					parent_agent_id: target.parentAgentId ?? null,
					session_id: target.sessionId ?? null,
					status: target.status,
					created_at: target.createdAt,
				},
				target.updatedAt,
			);

			const memories = this.db
				.prepare("SELECT * FROM memory_agent_memories WHERE agent_id = ?")
				.all(oldId) as MemorySubstrateRow[];
			for (const row of memories) {
				const memory = AgentMemoryRecordSchema.parse(this.decryptPayload(row));
				const moved = { ...memory, agentId: target.id };
				this.upsertMemoryPayload(
					"memory_agent_memories",
					moved.id,
					moved,
					{
						agent_id: moved.agentId,
						horizon: moved.horizon,
						status: moved.status,
						importance: moved.importance,
						confidence: moved.confidence,
						created_at: moved.createdAt,
					},
					moved.updatedAt,
				);
			}

			const tasks = this.db
				.prepare("SELECT * FROM memory_working_tasks WHERE agent_id = ?")
				.all(oldId) as MemorySubstrateRow[];
			for (const row of tasks) {
				const task = WorkingTaskSchema.parse(this.decryptPayload(row));
				const moved = { ...task, agentId: target.id };
				this.upsertMemoryPayload(
					"memory_working_tasks",
					moved.id,
					moved,
					{
						session_id: moved.sessionId ?? null,
						parent_task_id: moved.parentTaskId ?? null,
						agent_id: moved.agentId,
						status: moved.status,
						started_at: moved.startedAt,
						completed_at: moved.completedAt ?? null,
						created_at: moved.createdAt,
					},
					moved.updatedAt,
				);
			}

			const children = this.db
				.prepare("SELECT * FROM memory_agent_identities WHERE parent_agent_id = ?")
				.all(oldId) as MemorySubstrateRow[];
			for (const row of children) {
				const child = AgentIdentitySchema.parse(this.decryptPayload(row));
				const moved = { ...child, parentAgentId: target.id };
				this.upsertMemoryPayload(
					"memory_agent_identities",
					moved.id,
					moved,
					{
						kind: moved.kind,
						parent_agent_id: moved.parentAgentId ?? null,
						session_id: moved.sessionId ?? null,
						status: moved.status,
						created_at: moved.createdAt,
					},
					moved.updatedAt,
				);
			}
			this.db.prepare("DELETE FROM memory_agent_identities WHERE id = ?").run(oldId);
		})();
	}

	upsertAgentMemory(memory: AgentMemoryRecord): void {
		const parsed = AgentMemoryRecordSchema.parse(memory);
		this.upsertMemoryPayload(
			"memory_agent_memories",
			parsed.id,
			parsed,
			{
				agent_id: parsed.agentId,
				horizon: parsed.horizon,
				status: parsed.status,
				importance: parsed.importance,
				confidence: parsed.confidence,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getAgentMemory(id: string): AgentMemoryRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM memory_agent_memories WHERE id = ? AND status != 'deleted'",
			)
			.get(id) as MemorySubstrateRow | undefined;
		return row ? AgentMemoryRecordSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listAgentMemories(
		agentId: string,
		options: { includeInactive?: boolean; limit?: number } = {},
	): AgentMemoryRecord[] {
		const status = options.includeInactive
			? "status != 'deleted'"
			: "status = 'active'";
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(1_000, Math.trunc(options.limit!)))
			: 200;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_agent_memories WHERE agent_id = ? AND ${status}
				 ORDER BY importance DESC, updated_at DESC, id ASC LIMIT ?`,
			)
			.all(agentId, limit) as MemorySubstrateRow[];
		return rows.map((row) => AgentMemoryRecordSchema.parse(this.decryptPayload(row)));
	}

	deleteAgentMemory(id: string): AgentMemoryRecord | undefined {
		const memory = this.getAgentMemory(id);
		if (!memory) return undefined;
		return this.db.transaction(() => {
			this.deleteAgentMemoryWithCounts(id);
			return AgentMemoryRecordSchema.parse({
				...memory,
				status: "deleted",
				updatedAt: new Date().toISOString(),
			});
		})();
	}

	private deleteAgentMemoryWithCounts(id: string): {
		memory?: AgentMemoryRecord;
		embeddings: number;
		provenance: number;
		jobs: number;
	} {
		const memory = this.getAgentMemory(id);
		if (!memory) return { embeddings: 0, provenance: 0, jobs: 0 };
		const embeddings = this.deleteMemoryEmbeddingsForOwner("agent_memory", id);
		const provenance = this.deleteMemoryProvenance("agent_memory", id);
		const jobs = this.deleteJobsForOwner(id);
		this.db.prepare("DELETE FROM memory_agent_memories WHERE id = ?").run(id);
		return { memory, embeddings, provenance, jobs };
	}

	upsertWorkingTask(task: WorkingTask): void {
		const parsed = WorkingTaskSchema.parse(task);
		this.upsertMemoryPayload(
			"memory_working_tasks",
			parsed.id,
			parsed,
			{
				session_id: parsed.sessionId ?? null,
				parent_task_id: parsed.parentTaskId ?? null,
				agent_id: parsed.agentId ?? null,
				status: parsed.status,
				started_at: parsed.startedAt,
				completed_at: parsed.completedAt ?? null,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getWorkingTask(id: string): WorkingTask | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_working_tasks WHERE id = ?")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? WorkingTaskSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listWorkingTasks(options: {
		sessionId?: string;
		agentId?: string;
		includeCompleted?: boolean;
		limit?: number;
	} = {}): WorkingTask[] {
		const conditions = ["1 = 1"];
		const parameters: Array<string | number> = [];
		if (options.sessionId) {
			conditions.push("session_id = ?");
			parameters.push(options.sessionId);
		}
		if (options.agentId) {
			conditions.push("agent_id = ?");
			parameters.push(options.agentId);
		}
		if (!options.includeCompleted)
			conditions.push("status IN ('planned', 'running', 'waiting')");
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(500, Math.trunc(options.limit!)))
			: 100;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_working_tasks WHERE ${conditions.join(" AND ")}
				 ORDER BY updated_at DESC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows.map((row) => WorkingTaskSchema.parse(this.decryptPayload(row)));
	}

	upsertMemoryProvenance(provenance: ProvenanceRecord): void {
		const parsed = ProvenanceRecordSchema.parse(provenance);
		this.upsertMemoryPayload(
			"memory_provenance",
			parsed.id,
			parsed,
			{
				owner_type: parsed.ownerType,
				owner_id: parsed.ownerId,
				source_type: parsed.sourceType,
				source_id: parsed.sourceId,
				timeline_event_id: parsed.timelineEventId ?? null,
				actor: parsed.actor,
					extraction_method: parsed.extractionMethod,
					confidence: parsed.confidence,
					created_at: parsed.createdAt,
				},
				parsed.updatedAt,
			);
	}

	getMemoryProvenance(id: string): ProvenanceRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_provenance WHERE id = ?")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? this.parseMemoryProvenanceRow(row) : undefined;
	}

	listMemoryProvenance(input: {
		ownerType?: ProvenanceRecord["ownerType"];
		ownerId?: string;
		sourceType?: string;
		sourceId?: string;
		timelineEventId?: string;
		limit?: number;
	} = {}): ProvenanceRecord[] {
		const conditions = ["1 = 1"];
		const parameters: Array<string | number> = [];
		for (const [column, value] of [
			["owner_type", input.ownerType],
			["owner_id", input.ownerId],
			["source_type", input.sourceType],
			["source_id", input.sourceId],
			["timeline_event_id", input.timelineEventId],
		] as const) {
			if (value) {
				conditions.push(`${column} = ?`);
				parameters.push(value);
			}
		}
		const limit = Number.isFinite(input.limit)
			? Math.max(1, Math.min(1_000, Math.trunc(input.limit!)))
			: 200;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_provenance WHERE ${conditions.join(" AND ")}
				 ORDER BY created_at DESC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows.map((row) => this.parseMemoryProvenanceRow(row));
	}

	private parseMemoryProvenanceRow(row: MemorySubstrateRow): ProvenanceRecord {
		const payload = this.decryptPayload(row);
		return ProvenanceRecordSchema.parse({
			...payload,
			// Older encrypted payloads predate the mutable provenance timestamp.
			// The normalized column is the source of truth for those rows.
			updatedAt:
				typeof payload.updatedAt === "string" && payload.updatedAt
					? payload.updatedAt
					: row.updated_at,
		});
	}

	upsertCapturePolicy(policy: CapturePolicy): void {
		const parsed = CapturePolicySchema.parse(policy);
		this.upsertMemoryPayload(
			"memory_capture_policies",
			parsed.id,
			parsed,
			{
				scope: parsed.scope,
				enabled: parsed.enabled ? 1 : 0,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
	}

	getCapturePolicy(id: string): CapturePolicy | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_capture_policies WHERE id = ?")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? CapturePolicySchema.parse(this.decryptPayload(row)) : undefined;
	}

	listCapturePolicies(): CapturePolicy[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_capture_policies ORDER BY updated_at DESC, id ASC")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => CapturePolicySchema.parse(this.decryptPayload(row)));
	}

	deleteCapturePolicy(id: string): boolean {
		return this.db.prepare("DELETE FROM memory_capture_policies WHERE id = ?").run(id)
			.changes === 1;
	}

	queueMemoryJob(job: MemoryJob): MemoryJob {
		const parsed = MemoryJobSchema.parse(job);
		this.upsertMemoryPayload(
			"memory_jobs",
			parsed.id,
			parsed,
			{
				kind: parsed.kind,
				dedupe_key: parsed.dedupeKey,
				status: parsed.status,
				attempts: parsed.attempts,
				max_attempts: parsed.maxAttempts,
				run_after: parsed.runAfter,
				locked_at: parsed.lockedAt ?? null,
				lease_until: parsed.leaseUntil ?? null,
				last_error: parsed.lastError ?? null,
				created_at: parsed.createdAt,
			},
			parsed.updatedAt,
		);
		return parsed;
	}

	getMemoryJob(id: string): MemoryJob | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_jobs WHERE id = ?")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? MemoryJobSchema.parse(this.decryptPayload(row)) : undefined;
	}

	getMemoryJobByDedupeKey(dedupeKey: string): MemoryJob | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_jobs WHERE dedupe_key = ?")
			.get(dedupeKey) as MemorySubstrateRow | undefined;
		return row ? MemoryJobSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listMemoryJobs(options: {
		status?: MemoryJob["status"];
		kind?: MemoryJobKind;
		limit?: number;
	} = {}): MemoryJob[] {
		const conditions = ["1 = 1"];
		const parameters: Array<string | number> = [];
		if (options.status) {
			conditions.push("status = ?");
			parameters.push(options.status);
		}
		if (options.kind) {
			conditions.push("kind = ?");
			parameters.push(options.kind);
		}
		const limit = Number.isFinite(options.limit)
			? Math.max(1, Math.min(2_000, Math.trunc(options.limit!)))
			: 500;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_jobs WHERE ${conditions.join(" AND ")}
				 ORDER BY run_after ASC, created_at ASC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows.map((row) => MemoryJobSchema.parse(this.decryptPayload(row)));
	}

	claimMemoryJob(now = new Date().toISOString(), leaseMs = 60_000): MemoryJob | undefined {
		if (!Number.isFinite(Date.parse(now))) throw new Error("Memory job timestamp is invalid.");
		const boundedLease = Math.max(5_000, Math.min(15 * 60_000, Math.trunc(leaseMs)));
		return this.db.transaction(() => {
			this.db
				.prepare(
					`UPDATE memory_jobs SET status='pending', locked_at=NULL, lease_until=NULL, updated_at=?
					 WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?`,
				)
				.run(now, now);
			this.db
				.prepare(
					`UPDATE memory_jobs SET status='failed', last_error='Maximum retry attempts exceeded', updated_at=?
					 WHERE status='pending' AND attempts >= max_attempts`,
				)
				.run(now);
			const row = this.db
				.prepare(
					`SELECT * FROM memory_jobs WHERE status='pending' AND run_after <= ?
					 ORDER BY run_after ASC, created_at ASC, id ASC LIMIT 1`,
				)
				.get(now) as MemorySubstrateRow | undefined;
			if (!row) return undefined;
			const leaseUntil = new Date(Date.parse(now) + boundedLease).toISOString();
			const updated = this.db
				.prepare(
					`UPDATE memory_jobs SET status='running', attempts=attempts+1, locked_at=?, lease_until=?, updated_at=?
					 WHERE id=? AND status='pending'`,
				)
				.run(now, leaseUntil, now, row.id);
			if (updated.changes !== 1) return undefined;
			const claimed = this.db
				.prepare("SELECT * FROM memory_jobs WHERE id = ?")
				.get(row.id) as MemorySubstrateRow;
			return MemoryJobSchema.parse(this.decryptPayload(claimed));
		})();
	}

	completeMemoryJob(id: string, now = new Date().toISOString()): boolean {
		return this.db
			.prepare(
				`UPDATE memory_jobs SET status='completed', locked_at=NULL, lease_until=NULL, last_error=NULL, updated_at=?
				 WHERE id=? AND status='running'`,
			)
			.run(now, id).changes === 1;
	}

	failMemoryJob(
		id: string,
		error: string,
		now = new Date().toISOString(),
		retryAfterMs = 30_000,
	): MemoryJob | undefined {
		const current = this.getMemoryJob(id);
		if (!current || current.status !== "running") return undefined;
		const retry = current.attempts < current.maxAttempts;
		const next = MemoryJobSchema.parse({
			...current,
			status: retry ? "pending" : "failed",
			...(retry
				? { runAfter: new Date(Date.parse(now) + Math.max(1_000, retryAfterMs)).toISOString() }
				: {}),
			lockedAt: undefined,
			leaseUntil: undefined,
			lastError: error.slice(0, 10_000),
			updatedAt: now,
		});
		this.queueMemoryJob(next);
		return next;
	}

	upsertMemoryEmbedding(embedding: EmbeddingRecord): void {
		const parsed = EmbeddingRecordSchema.parse(embedding);
		if (parsed.vector.length !== parsed.dimension)
			throw new Error("Embedding vector dimension does not match its metadata.");
		const existing = this.db
			.prepare(
				`SELECT id FROM memory_embeddings
				 WHERE owner_type=? AND owner_id=? AND provider=? AND model=? AND content_hash=?
				 LIMIT 1`,
			)
			.get(
				parsed.ownerType,
				parsed.ownerId,
				parsed.provider,
				parsed.model,
				parsed.contentHash,
			) as { id: string } | undefined;
		const id = existing?.id ?? parsed.id;
		const stored = id === parsed.id ? parsed : { ...parsed, id };
		this.upsertMemoryPayload(
			"memory_embeddings",
			stored.id,
			stored,
			{
				owner_type: stored.ownerType,
				owner_id: stored.ownerId,
				provider: stored.provider,
				model: stored.model,
				dimension: stored.dimension,
				content_hash: stored.contentHash,
				status: stored.status,
				created_at: stored.createdAt,
			},
			stored.updatedAt,
		);
	}

	getMemoryEmbedding(id: string): EmbeddingRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_embeddings WHERE id = ?")
			.get(id) as MemorySubstrateRow | undefined;
		return row ? EmbeddingRecordSchema.parse(this.decryptPayload(row)) : undefined;
	}

	listMemoryEmbeddings(input: {
		ownerType?: EmbeddingRecord["ownerType"];
		ownerId?: string;
		status?: EmbeddingRecord["status"];
		limit?: number;
	} = {}): EmbeddingRecord[] {
		const conditions = ["1 = 1"];
		const parameters: Array<string | number> = [];
		for (const [column, value] of [
			["owner_type", input.ownerType],
			["owner_id", input.ownerId],
			["status", input.status],
		] as const) {
			if (value) {
				conditions.push(`${column} = ?`);
				parameters.push(value);
			}
		}
		const limit = Number.isFinite(input.limit)
			? Math.max(1, Math.min(2_000, Math.trunc(input.limit!)))
			: 500;
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_embeddings WHERE ${conditions.join(" AND ")}
				 ORDER BY updated_at DESC, id ASC LIMIT ?`,
			)
			.all(...parameters, limit) as MemorySubstrateRow[];
		return rows.map((row) => EmbeddingRecordSchema.parse(this.decryptPayload(row)));
	}

	deleteMemoryEmbedding(id: string): EmbeddingRecord | undefined {
		const embedding = this.getMemoryEmbedding(id);
		if (!embedding) return undefined;
		this.db.prepare("DELETE FROM memory_embeddings WHERE id = ?").run(id);
		return embedding;
	}

	deleteMemoryEmbeddingsForOwner(
		ownerType: EmbeddingRecord["ownerType"],
		ownerId: string,
	): number {
		return this.db
			.prepare("DELETE FROM memory_embeddings WHERE owner_type = ? AND owner_id = ?")
			.run(ownerType, ownerId).changes;
	}

	deleteMemoryProvenance(ownerType: ProvenanceRecord["ownerType"], ownerId: string): number {
		return this.db
			.prepare("DELETE FROM memory_provenance WHERE owner_type = ? AND owner_id = ?")
			.run(ownerType, ownerId).changes;
	}

	deleteMemoryVersions(memoryId: string): number {
		return this.db
			.prepare("DELETE FROM memory_versions WHERE memory_id = ?")
			.run(memoryId).changes;
	}

	/** Remove the encrypted compatibility metadata for one legacy memory. */
	deleteMemoryMetadata(memoryId: string): number {
		return this.db
			.prepare("DELETE FROM memory_metadata WHERE memory_id = ?")
			.run(memoryId).changes;
	}

	deleteMemoryJobsForOwner(ownerId: string): number {
		return this.deleteJobsForOwner(ownerId);
	}

	/**
	 * Permanently remove a legacy memory and all of its derived encrypted or
	 * indexed records.  Callers use this only after the user has explicitly
	 * requested deletion; unlike a soft status update, this leaves no readable
	 * ciphertext or historical version behind.
	 */
	purgeMemory(memoryId: string): boolean {
		if (!memoryId.trim()) throw new Error("Memory ID is required.");
		return this.db.transaction(() => this.purgeMemoryInternal(memoryId))();
	}

	private purgeMemoryInternal(memoryId: string): boolean {
		return this.purgeMemoryWithCounts(memoryId).deleted;
	}

	private purgeMemoryWithCounts(memoryId: string): {
		deleted: boolean;
		embeddings: number;
		provenance: number;
		jobs: number;
	} {
		const embeddings = this.deleteMemoryEmbeddingsForOwner("memory", memoryId);
		const provenance = this.deleteMemoryProvenance("memory", memoryId);
		this.deleteMemoryVersions(memoryId);
		this.deleteMemoryMetadata(memoryId);
		const jobs = this.deleteJobsForOwner(memoryId);
		const deleted =
			this.db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId).changes === 1;
		return { deleted, embeddings, provenance, jobs };
	}

	memoryDiagnostics(updatedAt = new Date().toISOString()): MemoryDiagnostics {
		const count = (table: string, where = "1 = 1"): number => {
			if (!/^memory_[a-z_]+$/.test(table))
				throw new Error("Invalid memory diagnostics query.");
			const row = this.db
				.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
				.get() as { count: number };
			return Number(row.count) || 0;
		};
		const lastJob = this.db
			.prepare(
				"SELECT last_error FROM memory_jobs WHERE status='failed' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
			)
			.get() as { last_error: string } | undefined;
		return MemoryDiagnosticsSchema.parse({
			events: count("memory_timeline_events", "status != 'deleted'"),
			sessions: count("memory_timeline_sessions", "status != 'deleted'"),
			activityBlocks: count("memory_activity_blocks", "status != 'deleted'"),
			dailySummaries: count("memory_daily_summaries"),
			entities: count("memory_entities", "status != 'deleted'"),
			edges: count("memory_entity_edges", "status != 'deleted'"),
			agentIdentities: count("memory_agent_identities", "status != 'deleted'"),
			agentMemories: count("memory_agent_memories", "status != 'deleted'"),
			tasks: count("memory_working_tasks"),
			provenance: count("memory_provenance"),
			pendingJobs: count("memory_jobs", "status IN ('pending', 'running')"),
			failedJobs: count("memory_jobs", "status = 'failed'"),
			embeddings: {
				ready: count("memory_embeddings", "status = 'ready'"),
				queued: count("memory_embeddings", "status = 'queued'"),
				failed: count("memory_embeddings", "status = 'failed'"),
				unavailable: count("memory_embeddings", "status = 'unavailable'"),
			},
			...(lastJob?.last_error ? { lastJobError: lastJob.last_error } : {}),
			localOnly: true,
			updatedAt,
		});
	}

	/**
	 * Remove all substrate records derived from one source. This is deliberately
	 * transactional: a privacy deletion either removes the source graph and
	 * indexes together or leaves it untouched.
	 */
	deleteMemoryArtifactsForSource(sourceId: string): MemoryDeleteResult {
		if (!sourceId.trim()) throw new Error("Memory source ID is required.");
		return this.db.transaction(() => {
			const timestamp = new Date().toISOString();
			const eventIds = new Set(
				(
					this.db
						.prepare(
							"SELECT id FROM memory_timeline_events WHERE status = 'active' AND (source_id = ? OR source = ? OR source_session_id = ?)",
						)
						.all(sourceId, sourceId, sourceId) as Array<{ id: string }>
				).map((row) => row.id),
			);
			const events = [...eventIds].flatMap((id) => {
				const event = this.getTimelineEvent(id);
				return event ? [event] : [];
			});
			// A conversation deletion is keyed by its stable source session, while
			// extracted memories are normally keyed by individual message IDs. Treat
			// both identifiers as one deletion set.
			const deletedSourceIds = new Set([
				sourceId,
				...events.flatMap((event) => (event.sourceId ? [event.sourceId] : [])),
			]);
			const memories = this.listMemories().filter((memory) =>
				memory.sourceIds.some((id) => deletedSourceIds.has(id)) ||
				memory.relatedEventIds?.some((id) => eventIds.has(id)),
			);
			const memoryIds = new Set(memories.map((memory) => memory.id));
			let sessions = 0;
			let activityBlocks = 0;
			let dailySummaries = 0;
			let embeddings = 0;
			let jobs = 0;
			let provenance = 0;
			let deletedMemoryCount = 0;
			let deletedAgentMemoryCount = 0;
			const deletedMemoryIds = new Set<string>();
			for (const event of events) {
				const removed = this.deleteTimelineEventInternal(
					event.id,
					timestamp,
				);
				sessions += removed.sessions;
				activityBlocks += removed.activityBlocks;
				dailySummaries += removed.dailySummaries;
				embeddings += removed.embeddings;
				jobs += removed.jobs;
				provenance += removed.provenance;
			}

			for (const memory of memories) {
				const remainingSourceIds = memory.sourceIds.filter(
					(id) => !deletedSourceIds.has(id),
				);
				const remainingEventIds = (memory.relatedEventIds ?? []).filter(
					(id) => !eventIds.has(id),
				);
				if (remainingSourceIds.length === 0) {
					const purged = this.purgeMemoryWithCounts(memory.id);
					if (purged.deleted) {
						deletedMemoryCount += 1;
						deletedMemoryIds.add(memory.id);
					}
					embeddings += purged.embeddings;
					provenance += purged.provenance;
					jobs += purged.jobs;
					continue;
				}
				this.upsertMemory({
					...memory,
					sourceIds: remainingSourceIds,
					relatedEventIds: remainingEventIds,
					updatedAt: timestamp,
				});
			}

			let entities = 0;
			let edges = 0;
			const deletedEntityIds = new Set<string>();
			const sourceReferencesToRemove = new Set([
				...deletedSourceIds,
				...eventIds,
				...deletedMemoryIds,
				...[...deletedMemoryIds].map((id) => `memory:${id}`),
			]);
			for (const entity of this.listAllMemoryEntitiesForDeletion()) {
				const remainingSourceIds = entity.sourceIds.filter(
					(id) => !sourceReferencesToRemove.has(id),
				);
				if (remainingSourceIds.length === entity.sourceIds.length) continue;
				if (remainingSourceIds.length === 0) {
					const deleted = this.db
						.prepare("DELETE FROM memory_entities WHERE id = ?")
						.run(entity.id).changes;
					if (deleted) {
						entities += deleted;
						deletedEntityIds.add(entity.id);
						provenance += this.deleteMemoryProvenance("entity", entity.id);
					}
				} else {
					this.upsertMemoryEntity({
						...entity,
						sourceIds: remainingSourceIds,
						updatedAt: timestamp,
					});
				}
			}
			for (const edge of this.listAllMemoryEntityEdgesForDeletion()) {
				const remainingSourceIds = edge.sourceIds.filter(
					(id) => !sourceReferencesToRemove.has(id),
				);
				if (
					remainingSourceIds.length === 0 ||
					deletedEntityIds.has(edge.fromEntityId) ||
					deletedEntityIds.has(edge.toEntityId) ||
					!this.getMemoryEntity(edge.fromEntityId) ||
					!this.getMemoryEntity(edge.toEntityId)
				) {
					const deleted = this.db
						.prepare("DELETE FROM memory_entity_edges WHERE id = ?")
						.run(edge.id).changes;
					if (deleted) {
						edges += deleted;
						provenance += this.deleteMemoryProvenance("entity_edge", edge.id);
					}
				} else {
					this.upsertMemoryEntityEdge({
						...edge,
						sourceIds: remainingSourceIds,
						updatedAt: timestamp,
					});
				}
			}

			let tasks = 0;
			const deletedTaskIds = new Set<string>();
			for (const task of this.listAllWorkingTasksForDeletion()) {
				const remainingSourceIds = task.sourceIds.filter(
					(id) => !sourceReferencesToRemove.has(id),
				);
				const remainingEvidence = task.evidence.filter(
					(item) =>
						!sourceReferencesToRemove.has(item.id) &&
						!eventIds.has(item.id),
				);
				const ownedByDeletedSource = task.sessionId === sourceId;
				if (
					!ownedByDeletedSource &&
					remainingSourceIds.length === task.sourceIds.length &&
					remainingEvidence.length === task.evidence.length
				)
					continue;
				if (
					ownedByDeletedSource ||
					(remainingSourceIds.length === 0 && remainingEvidence.length === 0)
				) {
					const deleted = this.deleteWorkingTaskWithCounts(task.id);
					if (deleted.deleted) {
						tasks += 1;
						deletedTaskIds.add(task.id);
					}
					embeddings += deleted.embeddings;
					provenance += deleted.provenance;
					jobs += deleted.jobs;
					continue;
				}
				this.upsertWorkingTask({
					...task,
					sourceIds: remainingSourceIds,
					evidence: remainingEvidence,
					updatedAt: timestamp,
				});
			}
			// Foreign keys clear the normalized parent column, but the encrypted task
			// payload is the source of truth for reads. Rewrite child references too.
			if (deletedTaskIds.size) {
				for (const task of this.listAllWorkingTasksForDeletion()) {
					const parentTaskId =
						task.parentTaskId && deletedTaskIds.has(task.parentTaskId)
							? undefined
							: task.parentTaskId;
					const subtaskIds = task.subtaskIds.filter(
						(id) => !deletedTaskIds.has(id),
					);
					if (
						parentTaskId === task.parentTaskId &&
						subtaskIds.length === task.subtaskIds.length
					)
						continue;
					this.upsertWorkingTask({
						...task,
						...(parentTaskId ? { parentTaskId } : { parentTaskId: undefined }),
						subtaskIds,
						updatedAt: timestamp,
					});
				}
			}

			const agentSourceIds = new Set([
				...deletedSourceIds,
				...eventIds,
				...deletedMemoryIds,
				...[...deletedMemoryIds].map((id) => `memory:${id}`),
				...deletedTaskIds,
				...[...deletedTaskIds].map((id) => `task:${id}`),
			]);
			const agentMemories = this.listAllAgentMemories().filter((memory) =>
				memory.sourceIds.some((id) => agentSourceIds.has(id)),
			);
			for (const memory of agentMemories) {
				// Legacy projections include the legacy memory id in sourceIds. That
				// id is a derivation boundary: if the parent was purged, retaining the
				// projection would retain the deleted content even when other sources
				// remain. Do not compare a candidate id with an arbitrary source id or
				// query the parent after it has already been deleted.
				const bridgesDeletedMemory = memory.sourceIds.some((id) =>
					deletedMemoryIds.has(id) ||
					[...deletedMemoryIds].some((memoryId) => id === `memory:${memoryId}`),
				);
				const remainingSourceIds = memory.sourceIds.filter(
					(id) => !agentSourceIds.has(id),
				);
				if (bridgesDeletedMemory || remainingSourceIds.length === 0) {
					const deleted = this.deleteAgentMemoryWithCounts(memory.id);
					if (deleted.memory) deletedAgentMemoryCount += 1;
					embeddings += deleted.embeddings;
					provenance += deleted.provenance;
					jobs += deleted.jobs;
					continue;
				}
				const entityIds = memory.entityIds.filter(
					(id) => !deletedEntityIds.has(id),
				);
				this.upsertAgentMemory({
					...memory,
					sourceIds: remainingSourceIds,
					entityIds,
					updatedAt: timestamp,
				});
			}

			// Remove entity references from surviving legacy memories as well. The
			// encrypted payloads, rather than the normalized relation indexes, are
			// what retrieval returns to callers.
			if (deletedEntityIds.size) {
				for (const memory of this.listMemories()) {
					const entityIds = memory.entityIds.filter(
						(id) => !deletedEntityIds.has(id),
					);
					if (entityIds.length === memory.entityIds.length) continue;
					this.upsertMemory({ ...memory, entityIds, updatedAt: timestamp });
				}
			}

			const provenanceSourceIds = new Set([
				...sourceReferencesToRemove,
				...deletedTaskIds,
				...[...deletedTaskIds].map((id) => `task:${id}`),
			]);
			const sourcePlaceholders = [...provenanceSourceIds]
				.map(() => "?")
				.join(", ");
			const eventPlaceholders = [...eventIds].map(() => "?").join(", ");
			const sourceProvenanceDeleted = this.db
				.prepare(
					`DELETE FROM memory_provenance
					 WHERE source_id IN (${sourcePlaceholders || "NULL"})
					 OR timeline_event_id IN (${eventPlaceholders || "NULL"})`,
				)
				.run(...provenanceSourceIds, ...eventIds).changes;
			provenance += sourceProvenanceDeleted;
			const jobSourceIds = new Set([
				...provenanceSourceIds,
				...eventIds,
			]);
			const jobCandidates = this.listAllMemoryJobsForDeletion().filter((job) =>
				[...jobSourceIds].some((id) =>
					this.memoryJobReferencesSource(job, id, eventIds),
				),
			);
			for (const job of jobCandidates) {
				jobs += this.db.prepare("DELETE FROM memory_jobs WHERE id = ?").run(job.id).changes;
			}
			return MemoryDeleteResultSchema.parse({
				timelineEvents: events.length,
				sessions,
				activityBlocks,
				dailySummaries,
				entities,
				edges,
				tasks,
				jobs,
				memories: deletedMemoryCount,
				agentMemories: deletedAgentMemoryCount,
				provenance,
				embeddings,
			});
		})();
	}

	private deleteTimelineEventInternal(
		id: string,
		timestamp: string,
	): {
		event?: TimelineEvent;
		sessions: number;
		activityBlocks: number;
		dailySummaries: number;
		embeddings: number;
		jobs: number;
		provenance: number;
	} {
		const event = this.getTimelineEvent(id);
		if (!event)
			return {
				sessions: 0,
				activityBlocks: 0,
				dailySummaries: 0,
				embeddings: 0,
				jobs: 0,
				provenance: 0,
			};
		const blocks = this.listAllActivityBlocksForDeletion().filter((block) =>
			block.eventIds.includes(id),
		);
		const sessions = this.listAllTimelineSessionsForDeletion().filter((session) =>
			session.eventIds.includes(id),
		);
		const blockIds = new Set(blocks.map((block) => block.id));
		const sessionIds = new Set(sessions.map((session) => session.id));
		const summaries = this.listAllDailySummariesForDeletion().filter(
			(summary) =>
				summary.eventIds.includes(id) ||
				summary.activityBlockIds.some((blockId) => blockIds.has(blockId)) ||
				sessions.some((session) => session.eventIds.includes(id)),
		);
		const summaryIds = new Set(summaries.map((summary) => summary.id));
		const remainingEvents = (eventIds: readonly string[]): TimelineEvent[] =>
			eventIds
				.filter((eventId) => eventId !== id)
				.flatMap((eventId) => {
					const remaining = this.getTimelineEvent(eventId);
					return remaining ? [remaining] : [];
				});
		const blockPlans = blocks.map((block) => ({
			block,
			remainingEvents: remainingEvents(block.eventIds),
		}));
		const deletedBlockIds = new Set(
			blockPlans
				.filter((plan) => plan.remainingEvents.length === 0)
				.map((plan) => plan.block.id),
		);
		const sessionPlans = sessions.map((session) => ({
			session,
			remainingEvents: remainingEvents(session.eventIds),
			remainingBlocks: session.activityBlockIds.filter(
				(blockId) => !deletedBlockIds.has(blockId) && Boolean(this.getActivityBlock(blockId)),
			),
		}));
		const summaryPlans = summaries.map((summary) => ({
			summary,
			remainingEvents: remainingEvents(summary.eventIds),
			remainingBlocks: summary.activityBlockIds.filter(
				(blockId) => !deletedBlockIds.has(blockId) && Boolean(this.getActivityBlock(blockId)),
			),
		}));
		let embeddings = 0;
		let jobs = 0;
		let provenance = this.db
			.prepare(
				`DELETE FROM memory_provenance
				 WHERE (owner_type = 'timeline_event' AND owner_id = ?)
				 OR timeline_event_id = ?`,
			)
			.run(id, id).changes;
		const embeddingOwners: Array<{
			ownerType: EmbeddingRecord["ownerType"];
			ownerId: string;
		}> = [
			{ ownerType: "timeline_event", ownerId: id },
			...[...blockIds].map((ownerId) => ({ ownerType: "activity_block" as const, ownerId })),
			...[...sessionIds].map((ownerId) => ({ ownerType: "timeline_session" as const, ownerId })),
			...[...summaryIds].map((ownerId) => ({ ownerType: "daily_summary" as const, ownerId })),
		];
		for (const owner of embeddingOwners) {
			embeddings += this.deleteMemoryEmbeddingsForOwner(owner.ownerType, owner.ownerId);
			jobs += this.deleteJobsForOwner(owner.ownerId, owner.ownerType);
		}

		let deletedBlocks = 0;
		for (const plan of blockPlans) {
			const { block, remainingEvents } = plan;
			if (remainingEvents.length === 0) {
				const deleted = this.db.prepare("DELETE FROM memory_activity_blocks WHERE id = ?").run(block.id).changes;
				deletedBlocks += deleted;
				provenance += this.deleteMemoryProvenance("activity_block", block.id);
				continue;
			}
			const last = remainingEvents.at(-1)!;
			this.upsertActivityBlock({
				...block,
				startedAt: remainingEvents[0]!.startedAt,
				endedAt: last.endedAt ?? last.startedAt,
				title: timelineTitle(remainingEvents),
				summary: timelineSummary(remainingEvents, 20_000),
				eventIds: remainingEvents.map((item) => item.id),
				projectIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.projectIds), 100),
				personIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.personIds), 100),
				entityIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.entityIds), 100),
				updatedAt: timestamp,
			});
		}

		let deletedSessions = 0;
		for (const plan of sessionPlans) {
			const { session, remainingEvents, remainingBlocks } = plan;
			if (remainingEvents.length === 0) {
				const deleted = this.db.prepare("DELETE FROM memory_timeline_sessions WHERE id = ?").run(session.id).changes;
				deletedSessions += deleted;
				provenance += this.deleteMemoryProvenance("timeline_session", session.id);
				continue;
			}
			const last = remainingEvents.at(-1)!;
			this.upsertTimelineSession({
				...session,
				startedAt: remainingEvents[0]!.startedAt,
				endedAt: last.endedAt ?? last.startedAt,
				title: timelineTitle(remainingEvents),
				summary: timelineSummary(remainingEvents, 20_000),
				eventIds: remainingEvents.map((item) => item.id),
				activityBlockIds: remainingBlocks,
				projectIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.projectIds), 100),
				personIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.personIds), 100),
				entityIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.entityIds), 100),
				updatedAt: timestamp,
			});
		}

		let deletedSummaries = 0;
		for (const plan of summaryPlans) {
			const { summary, remainingEvents, remainingBlocks } = plan;
			if (remainingEvents.length === 0) {
				const deleted = this.db.prepare("DELETE FROM memory_daily_summaries WHERE id = ?").run(summary.id).changes;
				deletedSummaries += deleted;
				provenance += this.deleteMemoryProvenance("daily_summary", summary.id);
				continue;
			}
			this.upsertDailySummary({
				...summary,
				title: `Work on ${summary.day}`,
				summary: timelineSummary(remainingEvents, 30_000),
				activityBlockIds: remainingBlocks,
				eventIds: uniqueMemoryIds(remainingEvents.map((item) => item.id)),
				projectIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.projectIds), 100),
				personIds: uniqueMemoryIds(remainingEvents.flatMap((item) => item.personIds), 100),
				importance: Math.max(...remainingEvents.map((item) => item.importance)),
				confidence: 0.78,
				updatedAt: timestamp,
			});
		}

		for (const plan of blockPlans) {
			if (plan.remainingEvents.length)
				this.queueMemoryEmbeddingRefresh("activity_block", plan.block.id, timestamp);
		}
		for (const plan of sessionPlans) {
			if (plan.remainingEvents.length)
				this.queueMemoryEmbeddingRefresh("timeline_session", plan.session.id, timestamp);
		}
		for (const plan of summaryPlans) {
			if (plan.remainingEvents.length)
				this.queueMemoryEmbeddingRefresh("daily_summary", plan.summary.id, timestamp);
		}
		this.db.prepare("DELETE FROM memory_timeline_events WHERE id = ?").run(id);
		return {
			event,
			sessions: deletedSessions,
			activityBlocks: deletedBlocks,
			dailySummaries: deletedSummaries,
			embeddings,
			jobs,
			provenance,
		};
	}

	private deleteWorkingTaskWithCounts(id: string): {
		deleted: boolean;
		embeddings: number;
		provenance: number;
		jobs: number;
	} {
		const task = this.getWorkingTask(id);
		if (!task) return { deleted: false, embeddings: 0, provenance: 0, jobs: 0 };
		const embeddings = this.deleteMemoryEmbeddingsForOwner("task", id);
		const provenance = this.deleteMemoryProvenance("task", id);
		const jobs = this.deleteJobsForOwner(id, "task");
		const deleted =
			this.db.prepare("DELETE FROM memory_working_tasks WHERE id = ?").run(id).changes === 1;
		return { deleted, embeddings, provenance, jobs };
	}

	private queueMemoryEmbeddingRefresh(
		ownerType: EmbeddingRecord["ownerType"],
		ownerId: string,
		updatedAt: string,
	): void {
		const dedupeKey = `embed-refresh:${ownerType}:${ownerId}:${updatedAt}`;
		const existing = this.getMemoryJobByDedupeKey(dedupeKey);
		if (existing && ["pending", "running", "completed"].includes(existing.status)) return;
		this.queueMemoryJob(
			MemoryJobSchema.parse({
				id: `memory-job-${createHmac("sha256", this.encryptionKey)
					.update(dedupeKey)
					.digest("hex")
					.slice(0, 40)}`,
				kind: "embed",
				dedupeKey,
				status: "pending",
				payload: { ownerType, ownerId },
				attempts: 0,
				maxAttempts: 4,
				runAfter: updatedAt,
				createdAt: updatedAt,
				updatedAt,
			}),
		);
	}

	private deleteJobsForOwner(
		ownerId: string,
		ownerType?: EmbeddingRecord["ownerType"],
	): number {
		let deleted = 0;
		for (const job of this.listAllMemoryJobsForDeletion()) {
			if (!this.memoryJobReferencesOwner(job, new Set([ownerId]), ownerType)) continue;
			deleted += this.db.prepare("DELETE FROM memory_jobs WHERE id = ?").run(job.id).changes;
		}
		return deleted;
	}

	private memoryJobReferencesOwner(
		job: MemoryJob,
		ownerIds: Set<string>,
		ownerType?: EmbeddingRecord["ownerType"],
	): boolean {
		const payload = job.payload;
		const payloadOwnerType =
			typeof payload.ownerType === "string" ? payload.ownerType : undefined;
		if (ownerType && payloadOwnerType && payloadOwnerType !== ownerType) return false;
		return [payload.ownerId, payload.eventId, payload.memoryId, payload.taskId].some(
			(value) => typeof value === "string" && ownerIds.has(value),
		);
	}

	private memoryJobReferencesSource(
		job: MemoryJob,
		sourceId: string,
		eventIds: Set<string>,
	): boolean {
		const payload = job.payload;
		if (
			Object.values(payload).some(
				(value) =>
					(typeof value === "string" && (value === sourceId || eventIds.has(value))) ||
					(Array.isArray(value) && value.some((item) => item === sourceId)),
			)
		)
			return true;
		return job.dedupeKey === sourceId || job.dedupeKey.includes(`:${sourceId}`);
	}

	private listAllTimelineSessionsForDeletion(): TimelineSession[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_timeline_sessions WHERE status != 'deleted'")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => TimelineSessionSchema.parse(this.decryptPayload(row)));
	}

	private listAllActivityBlocksForDeletion(): ActivityBlock[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_activity_blocks WHERE status != 'deleted'")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => ActivityBlockSchema.parse(this.decryptPayload(row)));
	}

	private listAllDailySummariesForDeletion(): DailySummary[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_daily_summaries")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => DailySummarySchema.parse(this.decryptPayload(row)));
	}

	private listAllMemoryEntitiesForDeletion(): EntityRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_entities WHERE status != 'deleted'")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => EntityRecordSchema.parse(this.decryptPayload(row)));
	}

	private listAllMemoryEntityEdgesForDeletion(): EntityEdge[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_entity_edges WHERE status != 'deleted'")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => EntityEdgeSchema.parse(this.decryptPayload(row)));
	}

	private listAllWorkingTasksForDeletion(): WorkingTask[] {
		const rows = this.db
			.prepare("SELECT * FROM memory_working_tasks")
			.all() as MemorySubstrateRow[];
		return rows.map((row) => WorkingTaskSchema.parse(this.decryptPayload(row)));
	}

	private listAllMemoryJobsForDeletion(): MemoryJob[] {
		const rows = this.db.prepare("SELECT * FROM memory_jobs").all() as MemorySubstrateRow[];
		return rows.map((row) => MemoryJobSchema.parse(this.decryptPayload(row)));
	}

	listAllAgentMemories(): AgentMemoryRecord[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM memory_agent_memories WHERE status != 'deleted' ORDER BY updated_at DESC, id ASC",
			)
			.all() as MemorySubstrateRow[];
		return rows.map((row) => AgentMemoryRecordSchema.parse(this.decryptPayload(row)));
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

	deleteState(key: string): void {
		this.db.prepare("DELETE FROM runtime_state WHERE key = ?").run(key);
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

	deletePrivateState(key: string): void {
		this.db.prepare("DELETE FROM private_runtime_state WHERE key = ?").run(key);
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

	private decryptPayload(row: EncryptedPayloadRow): Record<string, unknown> {
		const parsed: unknown = JSON.parse(
			decryptText(
				{
					ciphertext: row.payload_ciphertext,
					iv: row.payload_iv,
					authTag: row.payload_auth_tag,
				},
				this.encryptionKey,
			),
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("Encrypted database payload must be a JSON object.");
		return parsed as Record<string, unknown>;
	}

	private parseActionReceipt(row: ActionReceiptRow): ActionReceipt {
		return ActionReceiptSchema.parse(this.decryptPayload(row));
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
			memoryRecallReceipt?: unknown;
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
			...(stored.memoryRecallReceipt
				? { memoryRecallReceipt: stored.memoryRecallReceipt }
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

	private normalizeSearchText(value: string): string {
		return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
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
					"SELECT payload FROM agent_runs WHERE session_id = ? AND status IN ('running', 'waiting_approval', 'waiting_input') ORDER BY created_at ASC",
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
				...(uncertain ? { outcomeUncertain: true } : {}),
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
			"UPDATE agent_runs SET payload = ?, status = ?, updated_at = ? WHERE id = ? AND session_id = ? AND status IN ('running', 'waiting_approval', 'waiting_input')",
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

	private upsertMemoryPayload(
		table: MemoryPayloadTable,
		id: string,
		value: unknown,
		indexed: Record<string, string | number | null>,
		updatedAt: string,
	): void {
		const allowed = new Set([
			"started_at",
			"ended_at",
			"event_type",
			"source",
			"source_id",
			"source_session_id",
			"session_id",
			"parent_task_id",
			"actor",
			"agent_id",
			"subagent_id",
			"task_id",
			"importance",
			"sensitivity",
			"retention_policy",
			"status",
			"created_at",
			"kind",
			"canonical_name_hash",
			"from_entity_id",
			"to_entity_id",
			"relation",
			"weight",
			"parent_agent_id",
			"horizon",
			"completed_at",
			"owner_type",
			"owner_id",
			"source_type",
			"source_id",
			"timeline_event_id",
			"extraction_method",
			"confidence",
			"scope",
			"enabled",
			"dedupe_key",
			"attempts",
			"max_attempts",
			"run_after",
			"locked_at",
			"lease_until",
			"last_error",
			"provider",
			"model",
			"dimension",
			"content_hash",
		]);
		for (const column of Object.keys(indexed)) {
			if (!allowed.has(column) || column === "updated_at")
				throw new Error("Unsupported memory substrate index column.");
		}
		const encrypted = encryptText(JSON.stringify(value), this.encryptionKey);
		const columns = [
			"id",
			...Object.keys(indexed),
			"payload_ciphertext",
			"payload_iv",
			"payload_auth_tag",
			"updated_at",
		];
		const parameters: Array<string | number | null> = [
			id,
			...Object.values(indexed),
			encrypted.ciphertext,
			encrypted.iv,
			encrypted.authTag,
			updatedAt,
		];
		const updates = columns
			.filter((column) => column !== "id")
			.map((column) => `${column}=excluded.${column}`)
			.join(", ");
		this.db
			.prepare(
				`INSERT INTO ${table} (${columns.join(", ")})
				 VALUES (${columns.map(() => "?").join(", ")})
				 ON CONFLICT(id) DO UPDATE SET ${updates}`,
			)
			.run(...parameters);
	}

	private memorySearchTerms(value: string): string[] {
		return [
			...new Set(
				value
					.normalize("NFKC")
					.toLocaleLowerCase()
					.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [],
			),
		].slice(0, 512);
	}

	private hashMemoryTerm(term: string): string {
		return createHmac("sha256", this.encryptionKey)
			.update(`memory-substrate:${term}`)
			.digest("hex");
	}

	private normalizeMemoryText(value: string): string {
		return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
	}

	private substrateSensitivityAllowed(
		sensitivity: string,
		options: { includeSensitive?: boolean; includeRestricted?: boolean },
	): boolean {
		if (sensitivity === "restricted") return options.includeRestricted === true;
		if (sensitivity === "sensitive") return options.includeSensitive === true;
		return true;
	}

	private matchesTimelineRelations(
		event: TimelineEvent,
		options: TimelineEventListOptions,
	): boolean {
		const includesAny = (values: readonly string[], expected?: readonly string[]) =>
			!expected?.length || expected.some((item) => values.includes(item));
		return (
			includesAny(event.projectIds, options.projectIds) &&
			includesAny(event.personIds, options.personIds) &&
			includesAny(event.entityIds, options.entityIds)
		);
	}

	private appendTimelineRelationConditions(
		conditions: string[],
		parameters: Array<string | number>,
		options: TimelineEventListOptions,
	): void {
		for (const [linkType, ids] of [
			["project", options.projectIds],
			["person", options.personIds],
			["entity", options.entityIds],
		] as const) {
			if (!ids?.length) continue;
			conditions.push(
				`EXISTS (SELECT 1 FROM memory_timeline_event_links l
				 WHERE l.event_id = e.id AND l.link_type = ?
				 AND l.link_id IN (${ids.map(() => "?").join(", ")}))`,
			);
			parameters.push(linkType, ...ids);
		}
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
