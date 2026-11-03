import { createEncryptionKey } from "@kestrel/encryption";
import { createHash } from "node:crypto";
import * as C from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index.js";
import { EMBEDDING_AUTHORITY_STATE_PREFIX, embeddingAuthorityStateKey, newEmbeddingAuthorityState, parseReservedEmbeddingAuthorityState } from "./memory-embedding-authority.js";
import { newEmbeddingStateSecret } from "./memory-embedding-state.js";
import { sourceReceiptDeletionKey } from "./source-evidence-redaction.js";

const time = "2026-11-03T12:00:00.000Z";
const databases: KestrelDatabase[] = [];
function database() { const db = new KestrelDatabase(":memory:", createEncryptionKey()); databases.push(db); return db; }
function event(db: KestrelDatabase, id: string, change: Partial<C.TimelineEvent> = {}) {
	const value = C.TimelineEventSchema.parse({ id, startedAt: time, eventType: "note", source: "fixture", actor: "user", textSummary: `Generated ${id}`,
		structuredData: {}, projectIds: [], personIds: [], entityIds: [], importance: 0.5, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "queued", status: "active", createdAt: time, updatedAt: time, ...change });
	db.upsertTimelineEvent(value); return value;
}
function memory(db: KestrelDatabase, id: string, sourceIds: string[], change: Partial<C.MemoryRecord> = {}) {
	const value = C.MemoryRecordSchema.parse({ id, type: "semantic", content: `Generated ${id}`, structuredData: {}, sourceIds, sourceType: "fixture",
		createdAt: time, updatedAt: time, confidence: 0.8, importance: 0.5, sensitivity: "personal", status: "active", entityIds: [], userConfirmed: true, inferred: false, ...change });
	db.upsertMemory(value); return value;
}
function task(db: KestrelDatabase, id: string, change: Partial<C.WorkingTask> = {}) {
	const value = C.WorkingTaskSchema.parse({ id, goal: `Generated ${id}`, status: "planned", plan: [], evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], sourceIds: [],
		projectIds: [], personIds: [], entityIds: [], startedAt: time, createdAt: time, updatedAt: time, ...change });
	db.upsertWorkingTask(value); return value;
}
function runtimeSession(db: KestrelDatabase, id: string, change: Partial<C.RuntimeSession> = {}) {
	const value = C.RuntimeSessionSchema.parse({ id, title: "Generated session", privacyMode: "standard", allowedTools: [], status: "active", checkpoints: [], createdAt: time, updatedAt: time, ...change });
	db.saveRuntimeSession(value); return value;
}
function provenance(db: KestrelDatabase, id: string, ownerId: string, sourceId: string, change: Partial<C.ProvenanceRecord> = {}) {
	const value = C.ProvenanceRecordSchema.parse({ id, ownerType: "memory", ownerId, sourceType: "fixture", sourceId, actor: "user", extractionMethod: "user", confidence: 1,
		transformationHistory: [], createdAt: time, updatedAt: time, ...change }); db.upsertMemoryProvenance(value); return value;
}
function claim(db: KestrelDatabase, type: C.EmbeddingRecord["ownerType"], id: string) {
	const desired = db.getMemoryEmbeddingInput(type, id)!;
	expect(desired).toBeDefined();
	db.queueMemoryJob(C.MemoryJobSchema.parse({ id: `job-${id}`, kind: "embed", dedupeKey: `job-${id}`, status: "pending", payload: { ownerType: type, ownerId: id, generation: desired.generation }, attempts: 0,
		maxAttempts: 4, runAfter: time, createdAt: time, updatedAt: time }));
	const job = db.claimMemoryJob(time)!;
	const input = db.snapshotMemoryEmbeddingJob(job, time)!;
	const vector = C.EmbeddingRecordSchema.parse({ id: `vector-${id}`, ownerType: type, ownerId: id, generation: input.generation, contentHash: input.contentHash,
		provider: "fixture", model: "fixture", dimension: 1, vector: [1], status: "ready", createdAt: time, updatedAt: time });
	return { job, input, vector };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("transitive embedding authority", () => {
	it("keeps constructors and missing-owner reads lazy", () => {
		const db = database();
		expect(db.getMemoryEmbeddingInput("memory", "missing")).toBeUndefined();
		expect(db.db.prepare("SELECT count(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
	});

	it("rejects connected-source events through aggregate, source, task and provenance paths", () => {
		const db = database(); event(db, "observation-hidden", { source: "connected-source", sourceId: "opaque-provider-item" });
		const aggregate = { projectIds: [], personIds: [], entityIds: [], importance: 0.5, confidence: 0.8, status: "active", createdAt: time, updatedAt: time };
		db.upsertTimelineSession(C.TimelineSessionSchema.parse({ ...aggregate, id: "session-aggregate", startedAt: time, title: "Generated", summary: "Generated", eventIds: ["observation-hidden"], activityBlockIds: [], sourceSessionIds: [] }));
		db.upsertActivityBlock(C.ActivityBlockSchema.parse({ ...aggregate, id: "block-aggregate", sessionId: "session-aggregate", startedAt: time, title: "Generated", summary: "Generated", eventIds: ["observation-hidden"] }));
		db.upsertDailySummary(C.DailySummarySchema.parse({ ...aggregate, id: "day-aggregate", day: "2026-11-03", title: "Generated", summary: "Generated", eventIds: [], activityBlockIds: ["block-aggregate"] }));
		memory(db, "derived-memory", ["opaque-provider-item"]);
		task(db, "derived-task", { sourceIds: ["memory:derived-memory"] });
		memory(db, "provenance-memory", ["explicit-user-control"]); provenance(db, "provenance-link", "provenance-memory", "observation-hidden");
		for (const [type, id] of [["timeline_session", "session-aggregate"], ["activity_block", "block-aggregate"], ["daily_summary", "day-aggregate"], ["memory", "derived-memory"], ["task", "derived-task"], ["memory", "provenance-memory"]] as const)
			{ expect(db.getMemoryEmbeddingInput(type, id)).toBeUndefined(); expect(db.hasMemoryOwnerSourceAuthority(type, id)).toBe(false); }
	});

	it("checks agent-memory task links and task dependencies and evidence", () => {
		const db = database(); event(db, "observation-hidden", { source: "connected-source" });
		task(db, "hidden-task", { sourceIds: ["observation-hidden"] });
		task(db, "dependent-task", { dependencyTaskIds: ["hidden-task"] });
		task(db, "evidence-task", { evidence: [{ type: "timeline_event", id: "observation-hidden" }] });
		db.upsertAgentIdentity(C.AgentIdentitySchema.parse({ id: "agent", kind: "main", name: "Generated", purpose: "fixture", specialization: "fixture", memoryScope: "private", status: "active", createdAt: time, updatedAt: time }));
		db.upsertAgentMemory(C.AgentMemoryRecordSchema.parse({ id: "agent-memory", agentId: "agent", kind: "fact", horizon: "long_term", content: "Generated", sourceIds: ["explicit-user-control"], taskIds: ["dependent-task"], projectIds: [], personIds: [], entityIds: [], confidence: 1, importance: 0.5, sensitivity: "personal", status: "active", createdAt: time, updatedAt: time }));
		for (const id of ["hidden-task", "dependent-task", "evidence-task"]) expect(db.getMemoryEmbeddingInput("task", id)).toBeUndefined();
		expect(db.getMemoryEmbeddingInput("agent_memory", "agent-memory")).toBeUndefined();
	});

	it("treats repeated event origin labels as provenance rather than sibling dependency cycles", () => {
		const db = database();
		for (const id of ["first-event", "second-event"]) {
			event(db, id, { sourceId: "opaque-shared-origin" });
			provenance(db, `provenance-${id}`, id, "opaque-shared-origin", { ownerType: "timeline_event", timelineEventId: id, originalContentRef: "opaque-shared-origin" });
		}
		memory(db, "derived", ["opaque-shared-origin"]);
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeDefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(true);
	});

	it("invalidates an unchanged descendant on same-clock source revoke and regrant", () => {
		const db = database(); const original = event(db, "source-event"); memory(db, "derived", [original.id]);
		const { job, input, vector } = claim(db, "memory", "derived");
		db.upsertMemoryEmbedding(vector);
		event(db, original.id, { source: "connected-source" });
		event(db, original.id);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
		expect(db.isMemoryEmbeddingCurrent(vector)).toBe(false);
	});

	it("denies deleted untyped source IDs and invalidates delete/recreate authority", () => {
		const db = database(); const original = event(db, "source-event"); memory(db, "derived", [original.id]);
		const before = db.getMemoryEmbeddingInput("memory", "derived")!;
		db.deleteTimelineEvent(original.id);
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
		db.upsertTimelineEvent(original);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(before.generation);
	});

	it("does not downgrade a deleted event source alias into an opaque permitted label", () => {
		const db = database(); const source = event(db, "source-event", { sourceId: "opaque-origin" }); memory(db, "derived", ["opaque-origin"]);
		const { job, input, vector } = claim(db, "memory", "derived");
		db.deleteTimelineEvent(source.id);
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(false);
		db.upsertTimelineEvent(source);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
	});

	it("fences an observed alias after a transient forbidden member is added and moved away", () => {
		const db = database();
		event(db, "permitted-source", { sourceId: "shared-origin" });
		memory(db, "derived", ["shared-origin"]);
		const { job, input, vector } = claim(db, "memory", "derived");
		db.upsertMemoryEmbedding(vector);
		const forbidden = event(db, "transient-source", { source: "connected-source", sourceId: "shared-origin" });
		db.upsertTimelineEvent({ ...forbidden, sourceId: "other-origin" });
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
		expect(db.isMemoryEmbeddingCurrent(vector)).toBe(false);
	});

	it("fences an observed provenance set after a transient forbidden link is added and removed", () => {
		const db = database(); memory(db, "derived", ["explicit-user-control"]);
		const { job, input, vector } = claim(db, "memory", "derived");
		db.upsertMemoryEmbedding(vector);
		provenance(db, "transient-provenance", "derived", "observation-transient", { sourceType: "connected-source" });
		expect(db.deleteMemoryProvenance("memory", "derived")).toBe(1);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
		expect(db.isMemoryEmbeddingCurrent(vector)).toBe(false);
	});

	it("retains an explicit memory's independent runtime-message source after its capture event is removed", () => {
		const db = database(); const session = runtimeSession(db, "runtime-source");
		db.saveRuntimeMessage(C.RuntimeMessageSchema.parse({ id: "message-source", sessionId: session.id, role: "user", content: "Generated explicit source", createdAt: time }));
		const source = event(db, "source-event", { sourceId: "message-source", sourceSessionId: session.id });
		memory(db, "explicit", ["message-source"]);
		expect(db.getMemoryEmbeddingInput("memory", "explicit")).toBeDefined();
		db.deleteTimelineEvent(source.id);
		expect(db.hasMemoryOwnerSourceAuthority("memory", "explicit")).toBe(true);
		expect(db.getMemoryEmbeddingInput("memory", "explicit")).toBeDefined();
	});

	it.each(["receipt", "derived-task"] as const)("observes %s tombstones and invalidates API set/clear without intermediate reads", mode => {
		const db = database();
		if (mode === "derived-task") task(db, "source-task");
		memory(db, "derived", [mode === "derived-task" ? "task:source-task" : "opaque-receipt"]);
		const key = mode === "receipt" ? sourceReceiptDeletionKey("opaque-receipt")
			: `source-derived-deleted.${createHash("sha256").update(JSON.stringify(["task", "source-task"])).digest("hex")}`;
		const { job, input, vector } = claim(db, "memory", "derived"); db.upsertMemoryEmbedding(vector);
		db.setPrivateState(key, { deleted: true }); db.deletePrivateState(key);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
		expect(db.isMemoryEmbeddingCurrent(vector)).toBe(false);
		db.setPrivateState(key, { deleted: true });
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(false);
	});

	it.each(["private", "incognito", "forgotten"] as const)("invalidates descendants on runtime %s revoke/regrant without an intermediate read", mode => {
		const db = database(); const session = runtimeSession(db, "runtime-source"); event(db, "source-event", { sourceSessionId: session.id }); memory(db, "derived", ["source-event"]);
		const { input, job, vector } = claim(db, "memory", "derived");
		db.saveRuntimeSession({ ...session, ...(mode === "forgotten" ? { forgottenAt: time } : { privacyMode: mode }) });
		db.saveRuntimeSession(session);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
	});

	it("checks runtime message and agent identity ownership", () => {
		const db = database(); const session = runtimeSession(db, "runtime-source");
		db.saveRuntimeMessage(C.RuntimeMessageSchema.parse({ id: "message-source", sessionId: session.id, role: "user", content: "Generated message", createdAt: time }));
		memory(db, "message-derived", ["message-source"]);
		db.upsertAgentIdentity(C.AgentIdentitySchema.parse({ id: "agent", sessionId: session.id, kind: "main", name: "Generated", purpose: "fixture", specialization: "fixture", memoryScope: "private", status: "active", createdAt: time, updatedAt: time }));
		task(db, "agent-task", { agentId: "agent" });
		expect(db.getMemoryEmbeddingInput("memory", "message-derived")).toBeDefined();
		db.saveRuntimeSession({ ...session, privacyMode: "private" });
		expect(db.getMemoryEmbeddingInput("memory", "message-derived")).toBeUndefined();
		expect(db.getMemoryEmbeddingInput("task", "agent-task")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "message-derived")).toBe(false);
		expect(db.hasMemoryOwnerSourceAuthority("task", "agent-task")).toBe(false);
	});

	it("applies capture policies to event-derived work while preserving explicit opaque user memory", () => {
		const db = database(); event(db, "source-event", { url: "https://private.example/document" }); memory(db, "derived", ["source-event"]);
		const { job, input, vector } = claim(db, "memory", "derived");
		const policy = C.CapturePolicySchema.parse({ id: "deny-domain", scope: "domain", pattern: "private.example", enabled: false, createdAt: time, updatedAt: time });
		db.upsertCapturePolicy(policy);
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(true);
		db.upsertCapturePolicy({ ...policy, enabled: true });
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(false);
		memory(db, "explicit", ["explicit-user-control"]);
		db.setPrivateState("memory.capture.configuration", { version: 1, enabled: false, defaultRetentionDays: 90, policies: [], updatedAt: time });
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(true);
		expect(db.getMemoryEmbeddingInput("memory", "explicit")).toBeDefined();
	});

	it("invalidates capture disable/re-enable and policy delete/recreate without intermediate descendant reads", () => {
		const db = database(); event(db, "source-event"); memory(db, "derived", ["source-event"]);
		const original = db.getMemoryEmbeddingInput("memory", "derived")!;
		const config = { version: 1, enabled: false, defaultRetentionDays: 90, policies: [], updatedAt: time };
		db.setPrivateState("memory.capture.configuration", config);
		db.setPrivateState("memory.capture.configuration", { ...config, enabled: true });
		const granted = db.getMemoryEmbeddingInput("memory", "derived")!;
		expect(granted.generation).not.toBe(original.generation);
		const policy = C.CapturePolicySchema.parse({ id: "policy", scope: "application", pattern: "*", enabled: true, createdAt: time, updatedAt: time });
		db.upsertCapturePolicy(policy);
		const before = db.getMemoryEmbeddingInput("memory", "derived")!;
		db.deleteCapturePolicy(policy.id); db.upsertCapturePolicy(policy);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(before.generation);
	});

	it("preserves authority for source metadata, session titles and policy timestamp-only writes", () => {
		const db = database(); const session = runtimeSession(db, "runtime-source"); const source = event(db, "source-event", { sourceSessionId: session.id });
		const policy = C.CapturePolicySchema.parse({ id: "policy", scope: "domain", pattern: "example.org", enabled: true, createdAt: time, updatedAt: time }); db.upsertCapturePolicy(policy);
		memory(db, "derived", [source.id]); const { job, input, vector } = claim(db, "memory", "derived");
		db.upsertTimelineEvent({ ...source, importance: 0.9, embeddingStatus: "ready" });
		db.saveRuntimeSession({ ...session, title: "A changed title", updatedAt: "2026-11-03T12:01:00.000Z" });
		db.upsertCapturePolicy({ ...policy, updatedAt: "2026-11-03T12:01:00.000Z" });
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).toBe(input.generation);
		expect(db.commitMemoryEmbeddingJob(job, input, vector, time)).toBe(true);
	});

	it("scans provenance beyond the public listing cap and fails closed on corrupt bindings", () => {
		const db = database(); memory(db, "derived", ["explicit-user-control"]);
		for (let index = 0; index < 250; index++) provenance(db, `provenance-${String(index).padStart(4, "0")}`, "derived", "opaque-fixture");
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeDefined();
		event(db, "observation-hidden", { source: "connected-source" });
		provenance(db, "provenance-9999", "derived", "observation-hidden");
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
		db.db.prepare("DELETE FROM memory_provenance WHERE id=?").run("provenance-9999");
		db.db.prepare("UPDATE memory_provenance SET source_id=? WHERE id=?").run("forged-binding", "provenance-0000");
		expect(db.getMemoryEmbeddingInput("memory", "derived")).toBeUndefined();
	});

	it("invalidates provenance link A-B-A and rejects cycles and missing declared dependencies", () => {
		const db = database(); memory(db, "derived", ["opaque-fixture"]); const link = provenance(db, "provenance-link", "derived", "opaque-first");
		const before = db.getMemoryEmbeddingInput("memory", "derived")!;
		db.upsertMemoryProvenance({ ...link, sourceId: "opaque-second" }); db.upsertMemoryProvenance(link);
		expect(db.getMemoryEmbeddingInput("memory", "derived")?.generation).not.toBe(before.generation);
		memory(db, "cycle-a", ["memory:cycle-b"]); memory(db, "cycle-b", ["memory:cycle-a"]);
		expect(db.getMemoryEmbeddingInput("memory", "cycle-a")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "cycle-a")).toBe(false);
		task(db, "missing-task", { dependencyTaskIds: ["absent-task"] });
		expect(db.getMemoryEmbeddingInput("task", "missing-task")).toBeUndefined();
	});

	it("fails closed on depth and provenance-node budgets", () => {
		const db = database();
		for (let index = 70; index >= 0; index--) task(db, `depth-${index}`, { dependencyTaskIds: index === 70 ? [] : [`depth-${index + 1}`] });
		expect(db.getMemoryEmbeddingInput("task", "depth-0")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("task", "depth-0")).toBe(false);
		memory(db, "wide", ["opaque-fixture"]);
		for (let index = 0; index < 1_100; index++) provenance(db, `wide-${index}`, "wide", "opaque-fixture");
		expect(db.getMemoryEmbeddingInput("memory", "wide")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "wide")).toBe(false);
	});

	it("bounds transitive plaintext bytes while leaving retained memory content intact", () => {
		const db = database(); const content = "Generated fixture ".repeat(60_000);
		memory(db, "large-source", ["opaque-fixture"], { content });
		expect(db.getMemoryEmbeddingInput("memory", "large-source")).toBeDefined();
		memory(db, "large-derived", ["memory:large-source"], { content });
		expect(db.getMemory("large-derived")?.content).toBe(content);
		expect(db.getMemoryEmbeddingInput("memory", "large-derived")).toBeUndefined();
		expect(db.hasMemoryOwnerSourceAuthority("memory", "large-derived")).toBe(false);
	});

	it("fails the local source boundary closed on malformed reserved epoch state", () => {
		const db = database(); memory(db, "derived", ["opaque-fixture"]);
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(true);
		const row = db.db.prepare("SELECT key FROM private_runtime_state WHERE key LIKE ?").get(`${EMBEDDING_AUTHORITY_STATE_PREFIX}owner.%`) as { key: string };
		db.setPrivateState(row.key, { version: 1, invalid: true });
		expect(db.hasMemoryOwnerSourceAuthority("memory", "derived")).toBe(false);
	});

	it("strictly validates and binds reserved authority metadata", () => {
		const secret = newEmbeddingStateSecret(); const state = newEmbeddingAuthorityState("owner", "memory:fixture", "a".repeat(64));
		const key = embeddingAuthorityStateKey(secret, state.scope, state.identity);
		expect(parseReservedEmbeddingAuthorityState(key, state, secret)).toEqual(state);
		for (const value of [{ ...state, identity: "memory:forged" }, { ...state, epoch: "bad" }, { ...state, extra: true }]) expect(() => parseReservedEmbeddingAuthorityState(key, value, secret)).toThrow();
		expect(key.startsWith(EMBEDDING_AUTHORITY_STATE_PREFIX)).toBe(true);
	});
});
