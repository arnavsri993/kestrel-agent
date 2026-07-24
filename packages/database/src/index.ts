import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { decryptText, encryptText } from "@kestrel/encryption";
import {
  ActivitySchema,
  AgentRunSchema,
  ApprovalSchema,
  MemoryRecordSchema,
  ModelCallAuditSchema,
  RuntimeSessionSchema,
  RuntimeMessageSchema,
  RuntimeToolExecutionSchema,
  WorkspaceMutationSchema,
  type ActivityItem,
  type AgentRun,
  type Approval,
  type MemoryRecord,
  type ModelCallAudit,
  type RuntimeSession,
  type RuntimeMessage,
  type RuntimeToolExecution,
  type WorkspaceMutation
} from "@kestrel/shared-types";

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

export class KestrelDatabase {
  readonly db: Database.Database;

  constructor(filename: string, private readonly encryptionKey: Buffer) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("secure_delete = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.transaction(() => {
      this.db.exec(migration001);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
      this.db.exec(migration002);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
      this.db.exec(migration003);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, new Date().toISOString());
      this.db.exec(migration004);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, new Date().toISOString());
      this.db.exec(migration005);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(5, new Date().toISOString());
      this.db.exec(migration006);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(6, new Date().toISOString());
    })();
  }

  upsertMemory(memory: MemoryRecord): void {
    const parsed = MemoryRecordSchema.parse(memory);
    const encrypted = encryptText(parsed.content, this.encryptionKey);
    this.db.prepare(`
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
    `).run({
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
      inferred: parsed.inferred ? 1 : 0
    });
  }


  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status != 'deleted'").get(id) as MemoryRow | undefined;
    if (!row) return undefined;
    return MemoryRecordSchema.parse({
      id: row.id,
      type: row.type,
      content: decryptText({ ciphertext: row.content_ciphertext, iv: row.content_iv, authTag: row.content_auth_tag }, this.encryptionKey),
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
      inferred: row.inferred === 1
    });
  }

  listMemories(): MemoryRecord[] {
    return (this.db.prepare("SELECT * FROM memories WHERE status != 'deleted' ORDER BY importance DESC, updated_at DESC").all() as MemoryRow[])
      .map((row) => MemoryRecordSchema.parse({
        id: row.id,
        type: row.type,
        content: decryptText({ ciphertext: row.content_ciphertext, iv: row.content_iv, authTag: row.content_auth_tag }, this.encryptionKey),
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
        inferred: row.inferred === 1
      }));
  }

  saveApproval(approval: Approval): void {
    const parsed = ApprovalSchema.parse(approval);
    this.db.prepare(`INSERT INTO approvals (id, payload, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status, updated_at=excluded.updated_at`)
      .run(parsed.id, JSON.stringify(parsed), parsed.status, new Date().toISOString());
  }

  listApprovals(): Approval[] {
    return (this.db.prepare("SELECT payload FROM approvals ORDER BY updated_at DESC").all() as Array<{ payload: string }>)
      .map((row) => ApprovalSchema.parse(JSON.parse(row.payload)));
  }

  addActivity(item: ActivityItem): void {
    const parsed = ActivitySchema.parse(item);
    this.db.prepare("INSERT OR REPLACE INTO audit_events (id, payload, created_at) VALUES (?, ?, ?)")
      .run(parsed.id, JSON.stringify(parsed), parsed.timestamp);
  }

  listActivity(): ActivityItem[] {
    return (this.db.prepare("SELECT payload FROM audit_events ORDER BY created_at ASC").all() as Array<{ payload: string }>)
      .map((row) => ActivitySchema.parse(JSON.parse(row.payload)));
  }

  saveRuntimeSession(session: RuntimeSession): void {
    const parsed = RuntimeSessionSchema.parse(session);
    this.db.prepare(`INSERT INTO runtime_sessions (id, payload, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status, updated_at=excluded.updated_at`)
      .run(parsed.id, JSON.stringify(parsed), parsed.status, parsed.updatedAt);
  }

  getRuntimeSession(id: string): RuntimeSession | undefined {
    const row = this.db.prepare("SELECT payload FROM runtime_sessions WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? RuntimeSessionSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  listRuntimeSessions(): RuntimeSession[] {
    return (this.db.prepare("SELECT payload FROM runtime_sessions ORDER BY updated_at DESC").all() as Array<{ payload: string }>)
      .map((row) => RuntimeSessionSchema.parse(JSON.parse(row.payload)));
  }

  saveRuntimeMessage(message: RuntimeMessage): void {
    const parsed = RuntimeMessageSchema.parse(message);
    const encrypted = encryptText(JSON.stringify({
      version: 2,
      content: parsed.content,
      ...(parsed.modelToolCalls ? { modelToolCalls: parsed.modelToolCalls } : {}),
      ...(parsed.providerToolCallId ? { providerToolCallId: parsed.providerToolCallId } : {}),
      ...(parsed.toolName ? { toolName: parsed.toolName } : {})
    }), this.encryptionKey);
    const terms = this.searchTerms(parsed.content);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO runtime_messages (
        id, session_id, role, content_ciphertext, content_iv, content_auth_tag,
        parent_message_id, tool_execution_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(parsed.id, parsed.sessionId, parsed.role, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
          parsed.parentMessageId ?? null, parsed.toolExecutionId ?? null, parsed.createdAt);
      const next = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM runtime_message_order WHERE session_id = ?")
        .get(parsed.sessionId) as { sequence: number };
      this.db.prepare("INSERT INTO runtime_message_order (session_id, message_id, sequence) VALUES (?, ?, ?)")
        .run(parsed.sessionId, parsed.id, next.sequence);
      const insertTerm = this.db.prepare("INSERT OR IGNORE INTO runtime_message_terms (message_id, term_hash) VALUES (?, ?)");
      for (const term of terms) insertTerm.run(parsed.id, this.hashSearchTerm(term));
    })();
  }

  listRuntimeMessages(sessionId: string): RuntimeMessage[] {
    return (this.db.prepare(`SELECT m.* FROM runtime_messages m
      LEFT JOIN runtime_message_order o ON o.message_id = m.id
      WHERE m.session_id = ? ORDER BY COALESCE(o.sequence, 0) ASC, m.created_at ASC, m.id ASC`).all(sessionId) as RuntimeMessageRow[])
      .map((row) => this.parseRuntimeMessage(row));
  }

  truncateRuntimeMessages(sessionId: string, keepCount: number): void {
    if (!Number.isInteger(keepCount) || keepCount < 0) throw new Error("Message truncation count is invalid.");
    this.db.transaction(() => {
      const ids = this.db.prepare("SELECT message_id FROM runtime_message_order WHERE session_id = ? AND sequence > ? ORDER BY sequence DESC").all(sessionId, keepCount) as Array<{ message_id: string }>;
      const remove = this.db.prepare("DELETE FROM runtime_messages WHERE id = ? AND session_id = ?");
      for (const { message_id } of ids) remove.run(message_id, sessionId);
    })();
  }

  searchRuntimeMessages(query: string, limit = 20): RuntimeMessage[] {
    const terms = this.searchTerms(query);
    if (terms.length === 0) return [];
    const hashes = terms.map((term) => this.hashSearchTerm(term));
    const placeholders = hashes.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT m.* FROM runtime_messages m
      JOIN runtime_message_terms t ON t.message_id = m.id
      WHERE t.term_hash IN (${placeholders})
      GROUP BY m.id HAVING COUNT(DISTINCT t.term_hash) = ?
      ORDER BY m.created_at DESC LIMIT ?`).all(...hashes, hashes.length, limit) as RuntimeMessageRow[])
      .map((row) => this.parseRuntimeMessage(row));
  }

  saveToolExecution(execution: RuntimeToolExecution): void {
    const parsed = RuntimeToolExecutionSchema.parse(execution);
    this.db.prepare(`INSERT INTO tool_executions (id, session_id, tool_name, payload, status, started_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status`)
      .run(parsed.id, parsed.sessionId, parsed.toolName, JSON.stringify(parsed), parsed.status, parsed.startedAt);
  }

  listToolExecutions(sessionId: string): RuntimeToolExecution[] {
    return (this.db.prepare("SELECT payload FROM tool_executions WHERE session_id = ? ORDER BY started_at ASC").all(sessionId) as Array<{ payload: string }>)
      .map((row) => RuntimeToolExecutionSchema.parse(JSON.parse(row.payload)));
  }

  listAllToolExecutions(): RuntimeToolExecution[] {
    return (this.db.prepare("SELECT payload FROM tool_executions ORDER BY started_at ASC").all() as Array<{ payload: string }>)
      .map((row) => RuntimeToolExecutionSchema.parse(JSON.parse(row.payload)));
  }

  getToolExecution(id: string): RuntimeToolExecution | undefined {
    const row = this.db.prepare("SELECT payload FROM tool_executions WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? RuntimeToolExecutionSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveWorkspaceMutation(mutation: WorkspaceMutation): void {
    const parsed = WorkspaceMutationSchema.parse(mutation);
    const encrypted = encryptText(JSON.stringify(parsed), this.encryptionKey);
    this.db.prepare(`INSERT INTO workspace_mutations (
      id, session_id, tool_execution_id, payload_ciphertext, payload_iv, payload_auth_tag, created_at, undone_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_ciphertext=excluded.payload_ciphertext,
      payload_iv=excluded.payload_iv, payload_auth_tag=excluded.payload_auth_tag, undone_at=excluded.undone_at`)
      .run(parsed.id, parsed.sessionId, parsed.toolExecutionId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, parsed.createdAt, parsed.undoneAt ?? null);
  }

  getWorkspaceMutation(id: string): WorkspaceMutation | undefined {
    const row = this.db.prepare("SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM workspace_mutations WHERE id = ?").get(id) as WorkspaceMutationRow | undefined;
    return row ? this.parseWorkspaceMutation(row) : undefined;
  }

  listWorkspaceMutations(sessionId: string): WorkspaceMutation[] {
    return (this.db.prepare("SELECT payload_ciphertext, payload_iv, payload_auth_tag FROM workspace_mutations WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as WorkspaceMutationRow[])
      .map((row) => this.parseWorkspaceMutation(row));
  }

  listWorkspaceMutationIds(sessionId: string): string[] {
    return (this.db.prepare("SELECT id FROM workspace_mutations WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as { id: string }[])
      .map((row) => row.id);
  }

  saveAgentRun(run: AgentRun): void {
    const parsed = AgentRunSchema.parse(run);
    this.db.prepare(`INSERT INTO agent_runs (id, session_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, status=excluded.status, updated_at=excluded.updated_at`)
      .run(parsed.id, parsed.sessionId, JSON.stringify(parsed), parsed.status, parsed.createdAt, parsed.updatedAt);
  }

  getAgentRun(id: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT payload FROM agent_runs WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? AgentRunSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  listAgentRuns(sessionId: string): AgentRun[] {
    return (this.db.prepare("SELECT payload FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as Array<{ payload: string }>)
      .map((row) => AgentRunSchema.parse(JSON.parse(row.payload)));
  }

  saveModelCallAudit(audit: ModelCallAudit): void {
    const parsed = ModelCallAuditSchema.parse(audit);
    this.db.prepare("INSERT OR REPLACE INTO model_call_audits (id, run_id, session_id, payload, status, started_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(parsed.id, parsed.runId, parsed.sessionId, JSON.stringify(parsed), parsed.status, parsed.startedAt);
  }

  listModelCallAudits(runId: string): ModelCallAudit[] {
    return (this.db.prepare("SELECT payload FROM model_call_audits WHERE run_id = ? ORDER BY started_at ASC").all(runId) as Array<{ payload: string }>)
      .map((row) => ModelCallAuditSchema.parse(JSON.parse(row.payload)));
  }

  calculateSpending(dayStartIso: string, monthStartIso: string): { dailyUsd: number, monthlyUsd: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN json_extract(payload, '$.completedAt') >= ? THEN json_extract(payload, '$.estimatedCostUsd') ELSE 0 END), 0) as dailyUsd,
        COALESCE(SUM(CASE WHEN json_extract(payload, '$.completedAt') >= ? THEN json_extract(payload, '$.estimatedCostUsd') ELSE 0 END), 0) as monthlyUsd
      FROM model_call_audits
    `).get(dayStartIso, monthStartIso) as { dailyUsd: number, monthlyUsd: number };
    return {
      dailyUsd: Math.round(row.dailyUsd * 100_000_000) / 100_000_000,
      monthlyUsd: Math.round(row.monthlyUsd * 100_000_000) / 100_000_000
    };
  }

  listAllModelCallAudits(): ModelCallAudit[] {
    return (this.db.prepare("SELECT payload FROM model_call_audits ORDER BY started_at ASC").all() as Array<{ payload: string }>)
      .map((row) => ModelCallAuditSchema.parse(JSON.parse(row.payload)));
  }

  organizationAnalytics(): { sessions: number; messages: number; runs: number; toolExecutions: number; modelCalls: number; failedModelCalls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number } {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    const calls = this.listAllModelCallAudits();
    return {
      sessions: count("runtime_sessions"), messages: count("runtime_messages"), runs: count("agent_runs"), toolExecutions: count("tool_executions"), modelCalls: calls.length,
      failedModelCalls: calls.filter((call) => call.status === "failed").length,
      inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0), outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
      estimatedCostUsd: Math.round(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0) * 100_000_000) / 100_000_000
    };
  }

  enforceRetention(cutoff: string): Record<"messages" | "memories" | "workspaceMutations" | "toolExecutions" | "modelCalls" | "runs" | "activity", number> {
    if (!Number.isFinite(Date.parse(cutoff))) throw new Error("Retention cutoff is invalid.");
    return this.db.transaction(() => {
      const remove = (sql: string) => this.db.prepare(sql).run(cutoff).changes;
      const messages = remove("DELETE FROM runtime_messages WHERE created_at < ?");
      const memories = remove("DELETE FROM memories WHERE updated_at < ?");
      const workspaceMutations = remove("DELETE FROM workspace_mutations WHERE created_at < ?");
      const toolExecutions = remove("DELETE FROM tool_executions WHERE started_at < ?");
      const modelCalls = remove("DELETE FROM model_call_audits WHERE started_at < ?");
      const runs = remove("DELETE FROM agent_runs WHERE updated_at < ?");
      const activity = remove("DELETE FROM audit_events WHERE created_at < ?");
      return { messages, memories, workspaceMutations, toolExecutions, modelCalls, runs, activity };
    })();
  }

  idempotent<T>(key: string, operation: () => T): { result: T; repeated: boolean } {
    const existing = this.getIdempotentResult<T>(key);
    if (existing !== undefined) return { result: existing, repeated: true };
    const result = operation();
    this.saveIdempotentResult(key, result);
    return { result, repeated: false };
  }

  getIdempotentResult<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT result FROM idempotency_keys WHERE key = ?").get(key) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as T : undefined;
  }

  saveIdempotentResult(key: string, result: unknown): void {
    this.db.prepare("INSERT OR IGNORE INTO idempotency_keys (key, result, created_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(result), new Date().toISOString());
  }

  updateIdempotentResult(key: string, result: unknown): void {
    const update = this.db.prepare("UPDATE idempotency_keys SET result = ? WHERE key = ?").run(JSON.stringify(result), key);
    if (update.changes !== 1) throw new Error("Idempotency journal entry does not exist.");
  }

  setState(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getState<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }

  setPrivateState(key: string, value: unknown): void {
    const encrypted = encryptText(JSON.stringify(value), this.encryptionKey);
    this.db.prepare(`INSERT INTO private_runtime_state (key, value_ciphertext, value_iv, value_auth_tag, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_ciphertext=excluded.value_ciphertext, value_iv=excluded.value_iv,
      value_auth_tag=excluded.value_auth_tag, updated_at=excluded.updated_at`)
      .run(key, encrypted.ciphertext, encrypted.iv, encrypted.authTag, new Date().toISOString());
  }

  getPrivateState<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_ciphertext, value_iv, value_auth_tag FROM private_runtime_state WHERE key = ?")
      .get(key) as { value_ciphertext: string; value_iv: string; value_auth_tag: string } | undefined;
    if (!row) return undefined;
    const value = decryptText({ ciphertext: row.value_ciphertext, iv: row.value_iv, authTag: row.value_auth_tag }, this.encryptionKey);
    return JSON.parse(value) as T;
  }

  private parseRuntimeMessage(row: RuntimeMessageRow): RuntimeMessage {
    const decrypted = decryptText({ ciphertext: row.content_ciphertext, iv: row.content_iv, authTag: row.content_auth_tag }, this.encryptionKey);
    let stored: { content: string; modelToolCalls?: unknown; providerToolCallId?: unknown; toolName?: unknown } = { content: decrypted };
    try {
      const candidate = JSON.parse(decrypted) as Record<string, unknown>;
      if (candidate.version === 2 && typeof candidate.content === "string") stored = candidate as typeof stored;
    } catch {
      // Version 1 rows stored the plaintext content directly inside the encrypted column.
    }
    return RuntimeMessageSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: stored.content,
      ...(stored.modelToolCalls ? { modelToolCalls: stored.modelToolCalls } : {}),
      ...(typeof stored.providerToolCallId === "string" ? { providerToolCallId: stored.providerToolCallId } : {}),
      ...(typeof stored.toolName === "string" ? { toolName: stored.toolName } : {}),
      ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
      ...(row.tool_execution_id ? { toolExecutionId: row.tool_execution_id } : {}),
      createdAt: row.created_at
    });
  }

  private parseWorkspaceMutation(row: WorkspaceMutationRow): WorkspaceMutation {
    const payload = decryptText({ ciphertext: row.payload_ciphertext, iv: row.payload_iv, authTag: row.payload_auth_tag }, this.encryptionKey);
    return WorkspaceMutationSchema.parse(JSON.parse(payload));
  }

  private searchTerms(value: string): string[] {
    return [...new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 512);
  }

  private hashSearchTerm(term: string): string {
    return createHmac("sha256", this.encryptionKey).update(`runtime-message:${term}`).digest("hex");
  }

  close(): void {
    this.db.close();
  }
}
