import { createEncryptionKey, decryptText, encryptText } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index";
import * as Contracts from "@kestrel/shared-types";
import { computeHostProfileTransferSemanticHash, createHostProfileTransferSnapshot } from "./profile-transfer";

const databases: KestrelDatabase[] = [];
const timestamp = "2026-10-01T12:00:00.000Z";
const encryptedIdempotencyPrefix = "kestrel-encrypted-idempotency-v1:";
function database(key = createEncryptionKey()): KestrelDatabase {
	const value = new KestrelDatabase(":memory:", key);
	databases.push(value);
	return value;
}
afterEach(() => { for (const value of databases.splice(0)) value.close(); });

function seed(source: KestrelDatabase, sourceKey: Buffer): void {
	source.saveRuntimeSession({ id: "session-transfer", title: "Transfer fixture", allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
	source.saveRuntimeMessage({ id: "message-transfer", sessionId: "session-transfer", role: "user", content: "Zebra quasar transfer proof", createdAt: timestamp });
	source.saveRuntimeMessage({ id: "message-redacted", sessionId: "session-transfer", role: "assistant", content: "redacted index marker", createdAt: timestamp });
	source.db.prepare("DELETE FROM runtime_message_terms WHERE message_id = ?").run("message-redacted");
	source.setPrivateState("transfer-private-state", { text: "private payload proof" });
	source.setPrivateState("transfer-private-array", ["private array", 7, false, null]);
	source.setPrivateState("transfer-private-scalar", "private scalar");
	source.upsertMemoryEntity({ id: "entity-transfer", kind: "project", canonicalName: "Transfer Canary Project", aliases: ["Canary"], structuredData: {}, sourceIds: ["fixture"], confidence: 1, sensitivity: "personal", status: "active", firstSeenAt: timestamp, lastSeenAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
	source.upsertMemoryEntity({ id: "entity-transfer-related", kind: "topic", canonicalName: "Generated Related Topic", aliases: [], structuredData: {}, sourceIds: ["fixture"], confidence: 0.8, sensitivity: "personal", status: "active", firstSeenAt: timestamp, lastSeenAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
	source.upsertMemoryEntityEdge(Contracts.EntityEdgeSchema.parse({ id: "edge-transfer", fromEntityId: "entity-transfer", toEntityId: "entity-transfer-related", relation: "related_to", weight: 0.7, sourceIds: ["fixture"], status: "active", createdAt: timestamp, updatedAt: timestamp }));
	source.upsertTimelineEvent({ id: "event-transfer", startedAt: timestamp, eventType: "note", source: "fixture", actor: "user", projectIds: [], personIds: [], entityIds: [], textSummary: "Timeline quasar transfer proof", structuredData: {}, importance: 0.5, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "not_requested", status: "active", createdAt: timestamp, updatedAt: timestamp });
	source.upsertTimelineEvent({ id: "event-tombstone", startedAt: timestamp, eventType: "note", source: "fixture", actor: "user", projectIds: [], personIds: [], entityIds: [], textSummary: "Timeline deleted tombstone", structuredData: {}, importance: 0.2, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "not_requested", status: "deleted", createdAt: timestamp, updatedAt: timestamp });
	const encryptedResult = { id: "tool-idempotent-encrypted", sessionId: "session-transfer", toolName: "computer.screenshot", status: "verified", riskLevel: "low", input: {}, output: { text: "synthetic protected idempotency payload" }, startedAt: timestamp, unknownMetadata: { preserved: true } };
	const legacyResult = { id: "tool-idempotent-legacy", sessionId: "session-transfer", toolName: "browser.screenshot", status: "verified", riskLevel: "low", input: {}, output: { text: "synthetic legacy tool result" }, startedAt: timestamp, unknownMetadata: { preserved: true } };
	const encrypted = encryptText(JSON.stringify(encryptedResult), sourceKey);
	// Direct SQL fixtures exercise both supported durable idempotency encodings.
	source.db.prepare("INSERT INTO idempotency_keys (key, result, created_at) VALUES (?, ?, ?)").run("transfer-encrypted-result", `${encryptedIdempotencyPrefix}${JSON.stringify(encrypted)}`, timestamp);
	source.db.prepare("INSERT INTO idempotency_keys (key, result, created_at) VALUES (?, ?, ?)").run("transfer-legacy-result", JSON.stringify(legacyResult), timestamp);
	source.saveToolExecution({ id: "tool-execution-fixture", sessionId: "session-transfer", toolName: "computer.screenshot", status: "verified", riskLevel: "low", input: {}, output: { text: "synthetic tool execution fixture" }, startedAt: timestamp, completedAt: timestamp });
	source.db.prepare("INSERT INTO idempotency_claims (key, owner_token, owner_pid, pending_result, created_at) VALUES (?, ?, ?, ?, ?)").run("in-flight-claim", "fixture-owner", 123, JSON.stringify({ doNotReplay: true }), timestamp);
	seedProtectedFamilies(source, sourceKey);
}

function insertEncrypted(source: KestrelDatabase, table: string, values: Record<string, string | number | null>, payloadColumn: string, payload: unknown, key: Buffer): void {
	const encrypted = encryptText(JSON.stringify(payload), key);
	const row = { ...values, [payloadColumn]: encrypted.ciphertext, [`${payloadColumn.replace("_ciphertext", "")}_iv`]: encrypted.iv, [`${payloadColumn.replace("_ciphertext", "")}_auth_tag`]: encrypted.authTag };
	const columns = Object.keys(row);
	source.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((column) => row[column as keyof typeof row]));
}

function seedProtectedFamilies(source: KestrelDatabase, key: Buffer): void {
	source.upsertMemory({ id: "memory-transfer", type: "semantic", content: "Generated memory family payload", structuredData: { synthetic: true }, sourceIds: ["generated-fixture"], sourceType: "fixture", createdAt: timestamp, updatedAt: timestamp, confidence: 0.9, importance: 0.8, sensitivity: "personal", status: "active", entityIds: [], userConfirmed: true, inferred: false });
	source.saveMemoryVersion({ id: "memory-version-transfer", memoryId: "memory-transfer", version: 1, content: "Generated version payload", structuredData: { synthetic: true }, sourceIds: ["generated-fixture"], sourceType: "fixture", changedAt: timestamp, changedBy: "user" });

	const agentIdentity = { id: "agent-transfer", kind: "main", sessionId: "session-transfer", name: "Generated agent", purpose: "fixture", specialization: "fixture", memoryScope: "private", status: "active", createdAt: timestamp, updatedAt: timestamp };
	source.upsertAgentIdentity(Contracts.AgentIdentitySchema.parse(agentIdentity));
	const agentMemory = { id: "agent-memory-transfer", agentId: "agent-transfer", kind: "fact", horizon: "short_term", content: "Generated agent memory", sourceIds: ["generated-fixture"], taskIds: [], projectIds: [], personIds: [], entityIds: [], confidence: 0.9, importance: 0.5, sensitivity: "personal", status: "active", createdAt: timestamp, updatedAt: timestamp };
	source.upsertAgentMemory(Contracts.AgentMemoryRecordSchema.parse(agentMemory));
	const task = { id: "task-transfer", agentId: "agent-transfer", sourceIds: ["generated-fixture"], projectIds: [], personIds: [], entityIds: [], goal: "Generated task", plan: [], status: "planned", evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
	source.upsertWorkingTask(Contracts.WorkingTaskSchema.parse(task));

	const timelineSession = { id: "timeline-session-transfer", startedAt: timestamp, title: "Generated timeline", summary: "Generated timeline summary", eventIds: ["event-transfer"], activityBlockIds: [], projectIds: [], personIds: [], entityIds: [], sourceSessionIds: [], importance: 0.5, confidence: 0.8, status: "active", createdAt: timestamp, updatedAt: timestamp };
	source.upsertTimelineSession(Contracts.TimelineSessionSchema.parse(timelineSession));
	const activityBlock = { id: "activity-transfer", sessionId: timelineSession.id, startedAt: timestamp, title: "Generated activity", summary: "Generated activity summary", eventIds: ["event-transfer"], projectIds: [], personIds: [], entityIds: [], importance: 0.5, confidence: 0.8, status: "active", createdAt: timestamp, updatedAt: timestamp };
	source.upsertActivityBlock(Contracts.ActivityBlockSchema.parse(activityBlock));
	const dailySummary = { id: "daily-transfer", day: "2026-10-01", title: "Generated daily summary", summary: "Generated summary payload", activityBlockIds: [activityBlock.id], eventIds: ["event-transfer"], projectIds: [], personIds: [], importance: 0.5, confidence: 0.8, createdAt: timestamp, updatedAt: timestamp };
	source.upsertDailySummary(dailySummary);

	source.upsertPerson(Contracts.PersonRecordSchema.parse({ id: "person-transfer", displayName: "Generated Person", nicknames: [], facts: [], sourceIds: ["generated-fixture"], confidence: 1, sensitivity: "personal", status: "active", relevanceScore: 0.8, createdAt: timestamp, updatedAt: timestamp }));
	source.upsertCalendarEvent(Contracts.UnifiedCalendarEventSchema.parse({ id: "calendar-transfer", providerId: "local", origin: "explicit", status: "confirmed", title: "Generated calendar fixture", startsAt: timestamp, endsAt: "2026-10-01T13:00:00.000Z", confidence: 1, sourceIds: ["generated-fixture"], userConfirmed: true, createdAt: timestamp, updatedAt: timestamp }));
	source.saveContextUsage(Contracts.AgentContextBundleSchema.parse({ id: "context-transfer", query: "generated query", memories: [], people: [], events: [], influences: [], prompt: "Generated context", createdAt: timestamp }));
	source.setCalendarSyncState("local", { generated: "arbitrary sync state", cursor: 7 });
	source.saveAgentConfigurationAuditEvent(Contracts.AgentConfigurationAuditEventSchema.parse({ id: "config-audit-00000000-0000-4000-8000-000000000001", action: "recovery_fallback", actor: "system", detail: "Generated transfer audit fixture", evidence: [], createdAt: timestamp }));
	source.appendBrowserActivity(Contracts.BrowserActivityEventSchema.parse({ id: "browser-activity-00000000-0000-4000-8000-000000000001", ownerSessionId: "session-transfer", surface: "autonomous", toolName: "browser.act", target: { kind: "session", browserSessionId: "fixture-browser" }, intent: { type: "click", target: "Generated button" }, approval: { required: false, result: "not_required" }, outcome: "performed", createdAt: timestamp, completedAt: timestamp, trust: "untrusted_browser" }));
	source.upsertMemoryProvenance(Contracts.ProvenanceRecordSchema.parse({ id: "provenance-transfer", ownerType: "memory", ownerId: "memory-transfer", sourceType: "fixture", sourceId: "generated-fixture", timelineEventId: "event-transfer", actor: "user", extractionMethod: "user", confidence: 0.9, transformationHistory: [], createdAt: timestamp, updatedAt: timestamp }));
	source.upsertCapturePolicy(Contracts.CapturePolicySchema.parse({ id: "capture-transfer", scope: "session", pattern: "session-transfer", enabled: true, createdAt: timestamp, updatedAt: timestamp }));
	const memoryJob = { id: "job-transfer", kind: "extract", dedupeKey: "job-transfer", status: "pending", payload: { synthetic: true }, attempts: 0, maxAttempts: 3, runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp };
	source.queueMemoryJob(Contracts.MemoryJobSchema.parse(memoryJob));
	const embedding = { id: "embedding-transfer", ownerType: "memory", ownerId: "memory-transfer", provider: "fixture", model: "fixture-model", dimension: 2, contentHash: "a".repeat(64), vector: [0.1, 0.2], status: "ready", createdAt: timestamp, updatedAt: timestamp };
	source.upsertMemoryEmbedding(Contracts.EmbeddingRecordSchema.parse(embedding));
	source.db.prepare("INSERT INTO memory_workspace_documents (id,version,status,created_at,updated_at,payload_ciphertext,payload_iv,payload_auth_tag) VALUES (?,?,?,?,?,?,?,?)").run("document-tombstone", 1, "deleted", timestamp, timestamp, null, null, null);
	const document = Contracts.MemoryDocumentSchema.parse({ id: "document-transfer", kind: "memory", title: "Generated document", text: "Generated protected workspace content", domainIds: [], sourceIds: ["generated-fixture"], createdAt: timestamp, updatedAt: timestamp });
	source.upsertMemoryWorkspaceDocument(document);
	source.upsertMemoryWorkspaceDocument({ ...document, id: "document-forgotten" });
	source.forgetMemoryWorkspaceDocument("document-forgotten", 1);
	const daySummary = { id: "workspace-day-transfer", viewerId: "user", day: "2026-10-01", summary: "Generated workspace day summary", summaryMethod: "deterministic", sourceIds: ["generated-fixture"], eventIds: [], createdAt: timestamp, updatedAt: timestamp, version: 1 };
	source.upsertMemoryWorkspaceDaySummary(Contracts.MemoryWorkspaceDaySummarySchema.parse(daySummary));
	const mutation = { id: "mutation-transfer", sessionId: "session-transfer", toolExecutionId: "tool-execution-fixture", operation: "create", entryKind: "file", path: "/generated/fixture.txt", afterContent: "generated workspace mutation", createdAt: timestamp };
	source.saveWorkspaceMutation(Contracts.WorkspaceMutationSchema.parse(mutation));
	const receipt = { id: "receipt-transfer", sessionId: "session-transfer", toolExecutionId: "tool-execution-fixture", toolName: "computer.screenshot", action: { title: "Generated fixture action", category: "ui", riskLevel: "low", summary: "Generated bounded action" }, destination: { kind: "ui", label: "Generated fixture" }, approval: { required: false, result: "not_required" }, precondition: { status: "satisfied", summary: "Generated precondition" }, expectedState: "Generated expected state", observedState: "Generated observed state", outcome: "verified", rollback: { status: "not_applicable", reason: "Generated fixture has no side effects" }, startedAt: timestamp, completedAt: timestamp, trust: "local_encrypted_bounded" };
	source.saveActionReceipt(Contracts.ActionReceiptSchema.parse(receipt));
}

describe("host profile transfer", () => {
	it("preserves logical protected data under an independent key and rebuilds keyed indexes", () => {
		const sourceKey = createEncryptionKey();
		const targetKey = createEncryptionKey();
		const source = database(sourceKey);
		const target = database(targetKey);
		seed(source, sourceKey);
		const before = source.exportHostProfileTransferSnapshot();
		expect(Object.keys(before.rows).sort()).toEqual(Object.keys(before.counts).filter((table) => !["schema_migrations", "idempotency_claims", "runtime_message_terms", "memory_timeline_event_terms"].includes(table)).sort());
		const imported = target.importHostProfileTransferSnapshot(before);
		const after = target.exportHostProfileTransferSnapshot();

		expect(imported.semanticSha256).toBe(before.semanticSha256);
		expect(after.semanticSha256).toBe(before.semanticSha256);
		for (const [table, count] of Object.entries(before.counts)) {
			if (table !== "idempotency_claims") expect(after.counts[table]).toBe(count);
		}
		expect(imported.excluded.idempotencyClaims).toBe(1);
		expect(target.listRuntimeMessages("session-transfer")[0]?.content).toBe("Zebra quasar transfer proof");
		expect(target.searchRuntimeMessages("quasar").map(({ id }) => id)).toEqual(["message-transfer"]);
		expect(target.searchRuntimeMessages("redacted index marker")).toEqual([]);
		expect(target.findMemoryEntities("Transfer Canary Project").map(({ id }) => id)).toEqual(["entity-transfer"]);
		expect(target.searchTimelineEvents("quasar").map(({ event }) => event.id)).toEqual(["event-transfer"]);
		expect(target.searchTimelineEvents("tombstone", { status: "deleted" }).map(({ event }) => event.id)).toEqual(["event-tombstone"]);
		expect(target.getPrivateState("transfer-private-state")).toEqual({ text: "private payload proof" });
		const sourceMessage = source.db.prepare("SELECT content_ciphertext, content_iv, content_auth_tag FROM runtime_messages WHERE id = ?").get("message-transfer") as { content_ciphertext: string; content_iv: string; content_auth_tag: string };
		const targetMessage = target.db.prepare("SELECT content_ciphertext, content_iv, content_auth_tag FROM runtime_messages WHERE id = ?").get("message-transfer") as { content_ciphertext: string; content_iv: string; content_auth_tag: string };
		expect(targetMessage.content_ciphertext).not.toBe(sourceMessage.content_ciphertext);
		expect(decryptText({ ciphertext: targetMessage.content_ciphertext, iv: targetMessage.content_iv, authTag: targetMessage.content_auth_tag }, targetKey)).toBe(decryptText({ ciphertext: sourceMessage.content_ciphertext, iv: sourceMessage.content_iv, authTag: sourceMessage.content_auth_tag }, sourceKey));
		const sourceResult = source.db.prepare("SELECT result FROM idempotency_keys WHERE key = ?").get("transfer-encrypted-result") as { result: string };
		const targetResult = target.db.prepare("SELECT result FROM idempotency_keys WHERE key = ?").get("transfer-encrypted-result") as { result: string };
		const sourceEnvelope = JSON.parse(sourceResult.result.slice(encryptedIdempotencyPrefix.length));
		const targetEnvelope = JSON.parse(targetResult.result.slice(encryptedIdempotencyPrefix.length));
		expect(sourceResult.result).not.toBe(targetResult.result);
		expect(JSON.parse(decryptText(sourceEnvelope, sourceKey))).toEqual(JSON.parse(decryptText(targetEnvelope, targetKey)));
		const targetLegacyResult = target.db.prepare("SELECT result FROM idempotency_keys WHERE key = ?").get("transfer-legacy-result") as { result: string };
		expect(targetLegacyResult.result.startsWith(encryptedIdempotencyPrefix)).toBe(true);
		expect(JSON.parse(decryptText(JSON.parse(targetLegacyResult.result.slice(encryptedIdempotencyPrefix.length)), targetKey))).toMatchObject({ unknownMetadata: { preserved: true } });
		const sourceToolPayload = source.db.prepare("SELECT payload FROM tool_executions WHERE id = ?").get("tool-execution-fixture") as { payload: string };
		const targetToolPayload = target.db.prepare("SELECT payload FROM tool_executions WHERE id = ?").get("tool-execution-fixture") as { payload: string };
		expect(JSON.parse(sourceToolPayload.payload).kestrelEncryptedTool).toBe(1);
		expect(JSON.parse(targetToolPayload.payload).kestrelEncryptedTool).toBe(1);
		expect(target.listToolExecutions("session-transfer")[0]?.output).toMatchObject({ text: "synthetic tool execution fixture" });
		expect(source.exportHostProfileTransferSnapshot().semanticSha256).toBe(before.semanticSha256);
	});

	it("rejects wrong keys, unsupported snapshots, malformed envelopes, and FK conflicts atomically", () => {
		const sourceKey = createEncryptionKey();
		const source = database(sourceKey);
		const target = database();
		seed(source, sourceKey);
		const snapshot = source.exportHostProfileTransferSnapshot();
		expect(() => createHostProfileTransferSnapshot(source.db, createEncryptionKey())).toThrow();
		expect(() => source.exportHostProfileTransferSnapshot({ maxBytes: 1 })).toThrow(/byte limit/);
		source.db.exec("CREATE TABLE unsupported_future_data (id TEXT PRIMARY KEY)");
		expect(() => source.exportHostProfileTransferSnapshot()).toThrow(/unknown or missing/);
		source.db.exec("DROP TABLE unsupported_future_data");
		const wrongVersion = { ...snapshot, version: 99 } as unknown as typeof snapshot;
		expect(() => target.importHostProfileTransferSnapshot(wrongVersion)).toThrow(/unsupported/);
		const malformed = structuredClone(snapshot);
		malformed.rows.runtime_messages![0]!.cleartext!.content_ciphertext = null;
		malformed.semanticSha256 = computeHostProfileTransferSemanticHash(malformed.rows);
		expect(() => target.importHostProfileTransferSnapshot(malformed)).toThrow(/protected content/);
		const invalidForeignKey = structuredClone(snapshot);
		invalidForeignKey.rows.runtime_messages![0]!.values.session_id = "missing-session";
		invalidForeignKey.semanticSha256 = computeHostProfileTransferSemanticHash(invalidForeignKey.rows);
		expect(() => target.importHostProfileTransferSnapshot(invalidForeignKey)).toThrow(/atomically/);
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM runtime_sessions").get()).toMatchObject({ count: 0 });
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM runtime_messages").get()).toMatchObject({ count: 0 });
	});

	it("rejects nonempty targets without overwriting existing rows", () => {
		const sourceKey = createEncryptionKey();
		const source = database(sourceKey);
		const target = database();
		seed(source, sourceKey);
		target.saveRuntimeSession({ id: "existing", title: "Existing", allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
		expect(() => target.importHostProfileTransferSnapshot(source.exportHostProfileTransferSnapshot())).toThrow(/atomically/);
		expect(target.listRuntimeSessions().map(({ id }) => id)).toEqual(["existing"]);
	});
});

it("rewraps every populated cipher family and preserves normal readers and tombstones", () => {
 const sourceKey = createEncryptionKey(), targetKey = createEncryptionKey();
 const source = database(sourceKey), target = database(targetKey);
 seed(source, sourceKey);
 const snapshot = source.exportHostProfileTransferSnapshot();
 target.importHostProfileTransferSnapshot(snapshot);
 const families = new Set<string>();
 for (const [table, rows] of Object.entries(snapshot.rows)) {
  const primary = (source.db.pragma(`table_info(${table})`) as Array<{ name: string; pk: number }>).filter(column => column.pk).sort((a,b) => a.pk-b.pk);
  for (const row of rows) for (const [field, plaintext] of Object.entries(row.cleartext ?? {})) {
   if (!field.endsWith("_ciphertext") || plaintext === null) continue;
   const stem = field.slice(0, -"_ciphertext".length), iv = `${stem}_iv`, tag = `${stem}_auth_tag`;
   const sql = `SELECT ${field} AS ciphertext, ${iv} AS iv, ${tag} AS authTag FROM ${table} WHERE ${primary.map(column => `${column.name} = ?`).join(" AND ")}`;
   const keyValues = primary.map(column => row.values[column.name]);
   const original = source.db.prepare(sql).get(...keyValues) as { ciphertext: string; iv: string; authTag: string };
   const restored = target.db.prepare(sql).get(...keyValues) as typeof original;
   expect(restored.ciphertext).not.toBe(original.ciphertext);
   expect(decryptText(restored, targetKey)).toBe(plaintext);
   expect(() => decryptText(restored, sourceKey)).toThrow();
   families.add(table);
  }
 }
 expect([...families].sort()).toEqual(["memories", "runtime_messages", "workspace_mutations", "private_runtime_state", "memory_metadata", "memory_versions", "people", "calendar_events", "context_usage", "calendar_sync_state", "agent_configuration_records", "browser_activity_events", "action_receipts", "memory_timeline_events", "memory_timeline_sessions", "memory_activity_blocks", "memory_daily_summaries", "memory_entities", "memory_entity_edges", "memory_agent_identities", "memory_agent_memories", "memory_working_tasks", "memory_provenance", "memory_capture_policies", "memory_jobs", "memory_embeddings", "memory_workspace_documents", "memory_workspace_day_summaries"].sort());
 const readers = [
  (db: KestrelDatabase) => db.getMemory("memory-transfer"),
  (db: KestrelDatabase) => db.listMemoryVersions("memory-transfer"),
  (db: KestrelDatabase) => db.getPerson("person-transfer"),
  (db: KestrelDatabase) => db.getCalendarEvent("calendar-transfer"),
  (db: KestrelDatabase) => db.listContextUsage(),
  (db: KestrelDatabase) => db.getCalendarSyncState("local"),
  (db: KestrelDatabase) => db.listAgentConfigurationAuditEvents(),
  (db: KestrelDatabase) => db.listBrowserActivity({ ownerSessionId: "session-transfer" }),
  (db: KestrelDatabase) => db.getWorkspaceMutation("mutation-transfer"),
  (db: KestrelDatabase) => db.getActionReceiptForExecution("tool-execution-fixture"),
  (db: KestrelDatabase) => db.getTimelineSession("timeline-session-transfer"),
  (db: KestrelDatabase) => db.getMemoryEntityEdge("edge-transfer"),
  (db: KestrelDatabase) => db.getAgentIdentity("agent-transfer"),
  (db: KestrelDatabase) => db.getAgentMemory("agent-memory-transfer"),
  (db: KestrelDatabase) => db.getWorkingTask("task-transfer"),
  (db: KestrelDatabase) => db.getMemoryProvenance("provenance-transfer"),
  (db: KestrelDatabase) => db.getCapturePolicy("capture-transfer"),
  (db: KestrelDatabase) => db.getMemoryJob("job-transfer"),
  (db: KestrelDatabase) => db.getMemoryEmbedding("embedding-transfer"),
  (db: KestrelDatabase) => db.getMemoryWorkspaceDocument("document-transfer"),
  (db: KestrelDatabase) => db.getMemoryWorkspaceDaySummary("user", undefined, "2026-10-01"),
  (db: KestrelDatabase) => db.getPrivateState("transfer-private-array"),
  (db: KestrelDatabase) => db.getPrivateState("transfer-private-scalar"),
 ];
 for (const read of readers) { expect(read(source)).toBeDefined(); expect(read(target)).toEqual(read(source)); }
 expect(target.getMemoryWorkspaceDocument("document-forgotten")).toBeUndefined();
 expect(target.getMemoryWorkspaceDocument("document-tombstone")).toBeUndefined();
 expect(target.searchRuntimeMessages("redacted index marker")).toEqual([]);
});

it.each([
 ["memory_embeddings", "dimension", 3], ["memory_embeddings", "model", "other-model"],
 ["memory_embeddings", "owner_id", "other-memory"], ["memory_embeddings", "content_hash", "b".repeat(64)],
 ["memory_entities", "kind", "topic"], ["people", "updated_at", "2026-10-02T12:00:00.000Z"],
 ["memory_capture_policies", "enabled", 0], ["context_usage", "updated_at", "2026-10-02T12:00:00.000Z"],
 ["agent_configuration_records", "status", "applied"], ["memory_workspace_documents", "version", 8],
] as const)("rejects source and snapshot payload/index mismatches in %s.%s", (table, column, changed) => {
 const key = createEncryptionKey(), source = database(key), target = database();
 seed(source, key);
 const snapshot = source.exportHostProfileTransferSnapshot();
 const rowIndex = table === "memory_workspace_documents" ? snapshot.rows[table]!.findIndex(row => row.values.status === "active") : 0;
 const first = snapshot.rows[table]![rowIndex]!;
 const original = first.values[column];
 const identifier = first.values.id;
 source.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(changed, identifier);
 expect(() => source.exportHostProfileTransferSnapshot()).toThrow();
 source.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(original, identifier);
 const modified = structuredClone(snapshot);
 modified.rows[table]![rowIndex]!.values[column] = changed;
 modified.semanticSha256 = computeHostProfileTransferSemanticHash(modified.rows);
 expect(() => target.importHostProfileTransferSnapshot(modified)).toThrow(/atomically/);
 expect(target.db.prepare("SELECT COUNT(*) AS count FROM runtime_sessions").get()).toEqual({ count: 0 });
});

it("does not change literal non-tool idempotency values into encrypted tool envelopes", () => {
 const source = database(), target = database();
 const literal = { toolName: "computer.screenshot", marker: "literal application object" };
 source.saveIdempotentResult("literal-object", literal);
 source.saveIdempotentResult("literal-prefix", "kestrel-encrypted-idempotency-v1:literal");
 target.importHostProfileTransferSnapshot(source.exportHostProfileTransferSnapshot());
 expect(target.getIdempotentResult("literal-object")).toEqual(literal);
 expect(target.getIdempotentResult("literal-prefix")).toBe("kestrel-encrypted-idempotency-v1:literal");
});

it("retires live runs, input journals, linked receipts, working tasks and job leases without replay", () => {
 const key = createEncryptionKey(), source = database(key), target = database();
 seed(source, key);
 const originalReceipt = source.getActionReceiptForExecution("tool-execution-fixture")!;
 for (const status of ["running", "blocked"] as const) {
  const execution = { id: `live-${status}`, sessionId: "session-transfer", toolName: "test.generated-action", status, riskLevel: "sensitive" as const, input: { generated: true }, output: { approvalRequired: true }, error: "Generated previous tool diagnostic", startedAt: timestamp };
  source.saveToolExecution(execution);
  source.saveIdempotentResult(`live-cache-${status}`, { ...execution, opaqueMetadata: { preserved: true } });
  source.saveActionReceipt({ ...originalReceipt, id: `receipt-${status}`, toolExecutionId: execution.id, toolName: execution.toolName,
   outcome: status === "running" ? "in_progress" : "waiting_approval", approval: { required: true, result: "pending" } });
 }
 source.saveAgentRun(Contracts.AgentRunSchema.parse({ id: "live-run", sessionId: "session-transfer", model: "fixture", providerIds: ["fixture"], status: "waiting_approval", turn: 1, error: "Generated previous run diagnostic", pendingToolExecutionId: "live-blocked", pendingProviderToolCallId: "pending-call", pendingToolName: "test.generated-action", createdAt: timestamp, updatedAt: timestamp }));
 source.queueMemoryJob({ ...source.getMemoryJob("job-transfer")!, status: "running", lastError: "Generated previous job diagnostic", lockedAt: timestamp, leaseUntil: "2026-10-01T13:00:00.000Z" });
 source.upsertWorkingTask({ ...source.getWorkingTask("task-transfer")!, status: "running", outcomeSummary: "Generated partial task progress" });
 const snapshot = source.exportHostProfileTransferSnapshot();
 expect(snapshot.excluded).toMatchObject({ idempotencyClaims: 1, activeAgentRunsCancelled: 1, activeToolExecutionsRetired: 2, runningMemoryJobsCancelled: 1, activeWorkingTasksCancelled: 1 });
 target.importHostProfileTransferSnapshot(snapshot);
 for (const status of ["running", "blocked"]) {
  expect(target.getToolExecution(`live-${status}`)).toMatchObject({ status: status === "running" ? "failed" : "cancelled", output: { approvalRequired: false } });
  expect(target.getIdempotentResult(`live-cache-${status}`)).toMatchObject({ status: status === "running" ? "failed" : "cancelled", output: { approvalRequired: false }, opaqueMetadata: { preserved: true } });
  expect(target.getActionReceiptForExecution(`live-${status}`)).toMatchObject({ outcome: status === "running" ? "uncertain" : "cancelled", approval: { required: false, result: "unknown" } });
 }
 expect(target.listAgentRuns("session-transfer")[0]).toMatchObject({ status: "cancelled" });
 expect(target.listAgentRuns("session-transfer")[0]?.pendingToolExecutionId).toBeUndefined();
 expect(target.getMemoryJob("job-transfer")).toMatchObject({ status: "cancelled" });
 expect(target.getMemoryJob("job-transfer")?.leaseUntil).toBeUndefined();
 expect(target.getMemoryJob("job-transfer")?.lastError).toBe("Generated previous job diagnostic");
 expect(target.listAgentRuns("session-transfer")[0]?.error).toContain("Generated previous run diagnostic");
 expect(target.getToolExecution("live-running")?.error).toContain("Generated previous tool diagnostic");
 expect(target.getWorkingTask("task-transfer")?.outcomeSummary).toBe("Generated partial task progress");
 expect(target.getWorkingTask("task-transfer")).toMatchObject({ status: "cancelled" });
 expect(source.getToolExecution("live-running")?.status).toBe("running");
 expect(source.getMemoryJob("job-transfer")?.status).toBe("running");
 expect(target.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
});

it("preserves partially removed search terms and unkeyed timeline links under the new key", () => {
 const key = createEncryptionKey(), source = database(key), target = database();
 seed(source, key);
 const retainedRuntime = source.db.prepare("SELECT term_hash FROM runtime_message_terms WHERE message_id = ? LIMIT 1").get("message-transfer") as { term_hash: string };
 source.db.prepare("DELETE FROM runtime_message_terms WHERE message_id = ? AND term_hash != ?").run("message-transfer", retainedRuntime.term_hash);
 const retainedTimeline = source.db.prepare("SELECT term_hash FROM memory_timeline_event_terms WHERE event_id = ? LIMIT 1").get("event-transfer") as { term_hash: string };
 source.db.prepare("DELETE FROM memory_timeline_event_terms WHERE event_id = ? AND term_hash != ?").run("event-transfer", retainedTimeline.term_hash);
 source.db.prepare("INSERT INTO memory_timeline_event_links (event_id,link_type,link_id) VALUES (?,?,?)").run("event-transfer", "project", "explicit-index-link");
 const snapshot = source.exportHostProfileTransferSnapshot();
 target.importHostProfileTransferSnapshot(snapshot);
 for (const term of ["zebra", "quasar", "transfer", "proof", "timeline"]) {
  expect(target.searchRuntimeMessages(term).map(item => item.id)).toEqual(source.searchRuntimeMessages(term).map(item => item.id));
  expect(target.searchTimelineEvents(term).map(item => item.event.id)).toEqual(source.searchTimelineEvents(term).map(item => item.event.id));
 }
 expect(target.db.prepare("SELECT * FROM memory_timeline_event_links").all()).toEqual(source.db.prepare("SELECT * FROM memory_timeline_event_links").all());
 expect(target.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
 const forged = structuredClone(snapshot);
 forged.rows.runtime_messages!.find(row => row.values.id === "message-transfer")!.cleartext!.indexedTerms = ["not-in-the-retained-content"];
 forged.semanticSha256 = computeHostProfileTransferSemanticHash(forged.rows);
 const empty = database();
 expect(() => empty.importHostProfileTransferSnapshot(forged)).toThrow(/atomically/);
});

it("carries source deletion fences without restoring removed evidence or index entries", () => {
 const key = createEncryptionKey(), source = database(key), target = database();
 seed(source, key);
 const privateText = "GENERATED_PRIVATE_SOURCE_MUST_STAY_REMOVED";
 source.upsertTimelineEvent({ ...source.getTimelineEvent("event-transfer")!, id: "source-private-event", source: "connected-source", textSummary: privateText });
 const receipt = { id: "deleted-source-receipt", sessionId: "session-transfer", toolName: "sources.read", status: "verified" as const, riskLevel: "low" as const, input: {}, output: { events: [{ id: "source-private-event", text: privateText }] }, startedAt: timestamp };
 source.saveToolExecution(receipt);
 source.saveIdempotentResult("source-replay-fixture", receipt);
 source.saveRuntimeMessage({ id: "source-linked-message", sessionId: "session-transfer", role: "tool", toolName: "sources.read", toolExecutionId: receipt.id, content: privateText, createdAt: timestamp });
 source.deleteTimelineEvent("source-private-event");
 const snapshot = source.exportHostProfileTransferSnapshot();
 expect(JSON.stringify(snapshot)).not.toContain(privateText);
 target.importHostProfileTransferSnapshot(snapshot);
 expect(target.getToolExecution(receipt.id)).toMatchObject({ status: "failed", output: { sourceEvidenceRemoved: true } });
 expect(target.getIdempotentResult("source-replay-fixture")).toMatchObject({ status: "failed", output: { sourceEvidenceRemoved: true } });
 expect(target.searchRuntimeMessages("GENERATED_PRIVATE_SOURCE_MUST_STAY_REMOVED")).toEqual([]);
 target.saveToolExecution(receipt);
 target.saveIdempotentResult("source-late-fixture", receipt);
 expect(JSON.stringify(target.getIdempotentResult("source-late-fixture"))).not.toContain(privateText);
 expect(target.getToolExecution(receipt.id)?.output).toEqual({ sourceEvidenceRemoved: true });
});

it("retires unexecuted recommendation approvals while preserving their drafts and source state", () => {
 const source = database(), target = database();
 for (const status of ["pending", "approved"] as const) source.saveApproval(Contracts.ApprovalSchema.parse({
  id: `recommendation-${status}`, title: "Generated recommendation", recommendation: "Review fixture only", reasoning: "Generated reasoning",
  proposedEmail: { to: "fixture@example.invalid", subject: "Generated draft", body: "Preserved draft body" },
  proposedCalendarEvent: { title: "Generated event", startsAt: timestamp, durationMinutes: 30 }, proposedStudyBlocks: [], evidence: [],
  riskLevel: "external", approvalLevel: 3, status, policySuggestion: "Generated original suggestion", createdAt: timestamp,
 }));
 const snapshot = source.exportHostProfileTransferSnapshot();
 expect(snapshot.excluded.unexecutedApprovalsRetired).toBe(2);
 target.importHostProfileTransferSnapshot(snapshot);
 expect(target.listApprovals().map(approval => approval.status)).toEqual(["failed", "failed"]);
 expect(target.listApprovals()[0]?.proposedEmail.body).toBe("Preserved draft body");
 expect(target.listApprovals()[0]?.policySuggestion).toContain("Generated original suggestion");
 expect(source.listApprovals().map(approval => approval.status).sort()).toEqual(["approved", "pending"]);
});

it("rejects invalid active document envelopes, schema changes, row limits and mismatched checksums before overwrite", () => {
 const key = createEncryptionKey(), source = database(key), target = database();
 seed(source, key);
 const snapshot = source.exportHostProfileTransferSnapshot();
 const missing = structuredClone(snapshot);
 missing.rows.memory_workspace_documents!.find(row => row.values.status === "active")!.cleartext!.payload_ciphertext = null;
 missing.semanticSha256 = computeHostProfileTransferSemanticHash(missing.rows);
 expect(() => target.importHostProfileTransferSnapshot(missing)).toThrow(/atomically/);
 expect(() => target.importHostProfileTransferSnapshot({ ...snapshot, semanticSha256: "0".repeat(64) })).toThrow(/checksum/);
 source.db.exec("CREATE TRIGGER unsupported_transfer_trigger AFTER INSERT ON runtime_state BEGIN SELECT 1; END");
 expect(() => source.exportHostProfileTransferSnapshot()).toThrow(/schema object/);
 source.db.exec("DROP TRIGGER unsupported_transfer_trigger");
 const insert = source.db.prepare("INSERT INTO runtime_state (key,value,updated_at) VALUES (?, '0', ?)");
 source.db.transaction(() => { for (let i=0; i<100_001; i++) insert.run(`bounded-row-${i}`, timestamp); })();
 expect(() => source.exportHostProfileTransferSnapshot()).toThrow(/row limit/);
 expect(target.listRuntimeSessions()).toEqual([]);
});

it("keeps the source byte-for-byte unchanged during semantic export", () => {
 const key = createEncryptionKey(), source = database(key);
 seed(source, key);
 const before = source.db.serialize();
 source.exportHostProfileTransferSnapshot();
 expect(source.db.serialize()).toEqual(before);
});

it("preserves settled action evidence and retires stale in-progress receipts independently", () => {
 const key = createEncryptionKey(), source = database(key), target = database();
 seed(source, key);
 const settled = source.getActionReceiptForExecution("tool-execution-fixture")!;
 source.saveToolExecution({ id: "unsettled-tool", sessionId: "session-transfer", toolName: "test.generated-action", status: "verified", riskLevel: "low", input: {}, startedAt: timestamp, completedAt: timestamp });
 source.saveActionReceipt({ ...settled, id: "unsettled-receipt", toolExecutionId: "unsettled-tool", toolName: "test.generated-action", outcome: "in_progress" });
 source.saveToolExecution({ ...source.getToolExecution("tool-execution-fixture")!, status: "running" });
 const snapshot = source.exportHostProfileTransferSnapshot();
 expect(snapshot.excluded.unsettledActionReceiptsRetired).toBe(1);
 target.importHostProfileTransferSnapshot(snapshot);
 expect(target.getActionReceiptForExecution("tool-execution-fixture")).toEqual(settled);
 expect(target.getActionReceiptForExecution("unsettled-tool")?.outcome).toBe("uncertain");
});
