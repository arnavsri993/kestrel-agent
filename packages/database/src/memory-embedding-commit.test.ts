import { createEncryptionKey } from "@kestrel/encryption";
import * as Contracts from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index";

const timestamp = "2026-11-02T12:00:00.000Z";
const ownerTypes = ["timeline_event", "timeline_session", "activity_block", "daily_summary", "memory", "agent_memory", "task"] as const;
type Owner = typeof ownerTypes[number];
const tables: Record<Owner, string> = {
	timeline_event: "memory_timeline_events", timeline_session: "memory_timeline_sessions",
	activity_block: "memory_activity_blocks", daily_summary: "memory_daily_summaries",
	memory: "memories", agent_memory: "memory_agent_memories", task: "memory_working_tasks",
};
const databases: KestrelDatabase[] = [];

function writeOwner(database: KestrelDatabase, type: Owner, text: string) {
	const common = {
		id: "generated-owner", createdAt: timestamp, updatedAt: timestamp,
		status: "active", importance: 0.5, confidence: 0.8,
		projectIds: [], personIds: [], entityIds: [], sourceIds: ["generated-fixture"],
	};
	if (type === "activity_block") database.upsertTimelineSession(Contracts.TimelineSessionSchema.parse({
		...common, id: "generated-session", startedAt: timestamp, title: "Generated parent",
		summary: "Generated parent", eventIds: [], activityBlockIds: [], sourceSessionIds: [],
	}));
	if (type === "memory") database.upsertMemory(Contracts.MemoryRecordSchema.parse({
		...common, type: "semantic", content: text, structuredData: {}, sourceType: "fixture",
		sensitivity: "personal", userConfirmed: true, inferred: false,
	}));
	else if (type === "agent_memory") database.upsertAgentMemory(Contracts.AgentMemoryRecordSchema.parse({
		...common, agentId: "generated-agent", kind: "fact", horizon: "short_term",
		content: text, taskIds: [], sensitivity: "personal",
	}));
	else if (type === "task") database.upsertWorkingTask(Contracts.WorkingTaskSchema.parse({
		...common, status: "planned", goal: text, plan: [], evidence: [], artifacts: [],
		failures: [], unresolvedQuestions: [], subtaskIds: [], startedAt: timestamp,
	}));
	else if (type === "timeline_event") database.upsertTimelineEvent(Contracts.TimelineEventSchema.parse({
		...common, startedAt: timestamp, eventType: "note", source: "fixture", actor: "user",
		textSummary: text, structuredData: {}, sensitivity: "personal", retentionPolicy: "durable",
		embeddingStatus: "queued",
	}));
	else if (type === "timeline_session") database.upsertTimelineSession(Contracts.TimelineSessionSchema.parse({
		...common, startedAt: timestamp, title: "Generated session", summary: text,
		eventIds: [], activityBlockIds: [], sourceSessionIds: [],
	}));
	else if (type === "activity_block") database.upsertActivityBlock(Contracts.ActivityBlockSchema.parse({
		...common, sessionId: "generated-session", startedAt: timestamp,
		title: "Generated block", summary: text, eventIds: [],
	}));
	else database.upsertDailySummary(Contracts.DailySummarySchema.parse({
		...common, day: "2026-11-02", title: "Generated day", summary: text,
		activityBlockIds: [], eventIds: [],
	}));
}

function fixture(type: Owner) {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	databases.push(database);
	database.upsertAgentIdentity(Contracts.AgentIdentitySchema.parse({
		id: "generated-agent", kind: "main", name: "Generated", purpose: "fixture",
		specialization: "fixture", memoryScope: "private", status: "active",
		createdAt: timestamp, updatedAt: timestamp,
	}));
	writeOwner(database, type, "Generated first text");
	const desired = database.getMemoryEmbeddingInput(type, "generated-owner")!;
	database.queueMemoryJob(Contracts.MemoryJobSchema.parse({
		id: "generated-job", dedupeKey: "generated-job", kind: "embed", status: "pending",
		payload: { ownerType: type, ownerId: "generated-owner", generation: desired.generation }, attempts: 0, maxAttempts: 3,
		runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp,
	}));
	const job = database.claimMemoryJob(timestamp)!;
	const input = database.snapshotMemoryEmbeddingJob(job, timestamp)!;
	const embedding = Contracts.EmbeddingRecordSchema.parse({
		id: "generated-embedding", ownerType: type, ownerId: "generated-owner",
		provider: "fixture", model: "fixture", dimension: 1, contentHash: desired.contentHash, generation: desired.generation,
		vector: [1], status: "ready", createdAt: timestamp, updatedAt: timestamp,
	});
	return { database, job, input, embedding };
}

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("atomic embedding result commits", () => {
	it.each(ownerTypes)("commits an unchanged %s input and completes its claim", (type) => {
		const { database, job, input, embedding } = fixture(type);
		expect(input.text).toContain("Generated first text");
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toBe(true);
		expect(database.getMemoryEmbedding(embedding.id)).toEqual(embedding);
		expect(database.getMemoryJob(job.id)).toMatchObject({ status: "completed", attempts: 1 });
		expect(database.getMemoryJob(job.id)?.leaseToken).toBeUndefined();
	});

	it.each(ownerTypes)("rejects same-clock A -> B -> A writes for %s", (type) => {
		const { database, job, input, embedding } = fixture(type);
		writeOwner(database, type, "Generated second text");
		writeOwner(database, type, "Generated first text");
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toBe(false);
		expect(database.listMemoryEmbeddings()).toEqual([]);
		expect(database.getMemoryJob(job.id)?.status).toBe("running");
	});

	it.each(ownerTypes)("allows a fresh ciphertext for unchanged %s input while its provider is running", (type) => {
		const { database, job, input, embedding } = fixture(type);
		writeOwner(database, type, "Generated first text");
		const current = database.getMemoryEmbeddingInput(type, "generated-owner")!;
		expect(current.revision).not.toBe(input.revision);
		expect(current.generation).toBe(input.generation);
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toBe(true);
		expect(database.getMemoryJob(job.id)?.status).toBe("completed");
	});

	it.each(ownerTypes)("rejects deletion and identical ID recreation for %s", (type) => {
		const { database, job, input, embedding } = fixture(type);
		// Retain the generated job deliberately, exercising the owner guard itself.
		if (type === "memory") {
			database.purgeMemory("generated-owner");
			database.queueMemoryJob(job);
		} else database.db.prepare(`DELETE FROM ${tables[type]} WHERE id=?`).run("generated-owner");
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toBe(false);
		writeOwner(database, type, "Generated first text");
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toBe(false);
		expect(database.listMemoryEmbeddings()).toEqual([]);
	});

	it.each(ownerTypes)("invalidates completed %s embedding on A -> B -> A and preserves metadata-only generations", (type) => {
		const { database, job, input, embedding } = fixture(type);
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toBe(true);
		expect(database.isMemoryEmbeddingCurrent(embedding)).toBe(true);
		writeOwner(database, type, "Generated first text");
		expect(database.getMemoryEmbeddingInput(type, "generated-owner")?.generation).toBe(input.generation);
		writeOwner(database, type, "Generated second text");
		expect(database.isMemoryEmbeddingCurrent(embedding)).toBe(false);
		writeOwner(database, type, "Generated first text");
		const fresh = database.getMemoryEmbeddingInput(type, "generated-owner")!;
		expect(fresh.generation).not.toBe(input.generation);
		expect(fresh.contentHash).toBe(input.contentHash);
		expect(database.isMemoryEmbeddingCurrent(embedding)).toBe(false);
	});

	it("rotates on source authority changes and eligibility revoke and regrant", () => {
		const { database, input, embedding } = fixture("timeline_event");
		const original = database.getTimelineEvent("generated-owner")!;
		database.upsertTimelineEvent({ ...original, sourceId: "new-source" });
		const changed = database.getMemoryEmbeddingInput("timeline_event", original.id)!;
		expect(changed.generation).not.toBe(input.generation);
		database.upsertTimelineEvent({ ...original, source: "connected-source" });
		expect(database.getMemoryEmbeddingInput("timeline_event", original.id)).toBeUndefined();
		database.upsertTimelineEvent(original);
		expect(database.getMemoryEmbeddingInput("timeline_event", original.id)?.generation).not.toBe(input.generation);
		expect(database.isMemoryEmbeddingCurrent(embedding)).toBe(false);
	});

	it("leaves generation state lazy until an owner write", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		databases.push(database);
		expect(database.getMemoryEmbeddingInput("memory", "missing")).toBeUndefined();
		expect(database.db.prepare("SELECT count(*) AS count FROM private_runtime_state WHERE key LIKE 'kestrel.embedding-generation.v1.%'").get()).toEqual({ count: 0 });
	});

	it("queues current generations for surviving aggregates after deleting a timeline event", () => {
		const { database } = fixture("timeline_event");
		const event = database.getTimelineEvent("generated-owner")!;
		database.upsertTimelineEvent({ ...event, id: "generated-surviving-event", textSummary: "Retained generated event" });
		const eventIds = [event.id, "generated-surviving-event"];
		const common = { projectIds: [], personIds: [], entityIds: [], importance: 0.5, confidence: 0.8, status: "active" };
		database.upsertTimelineSession(Contracts.TimelineSessionSchema.parse({
			...common,
			id: "generated-session", startedAt: timestamp, title: "Generated session", summary: "Generated session summary",
			eventIds, activityBlockIds: ["generated-block"], sourceSessionIds: [], createdAt: timestamp, updatedAt: timestamp,
		}));
		database.upsertActivityBlock(Contracts.ActivityBlockSchema.parse({
			...common,
			id: "generated-block", sessionId: "generated-session", startedAt: timestamp,
			title: "Generated block", summary: "Generated block summary", eventIds, createdAt: timestamp, updatedAt: timestamp,
		}));
		database.upsertDailySummary(Contracts.DailySummarySchema.parse({
			...common,
			id: "generated-summary", day: "2026-11-02", title: "Generated day", summary: "Generated day summary",
			activityBlockIds: ["generated-block"], eventIds, createdAt: timestamp, updatedAt: timestamp,
		}));
		const owners = [["timeline_session", "generated-session"], ["activity_block", "generated-block"], ["daily_summary", "generated-summary"]] as const;
		const before = new Map(owners.map(([type, id]) => [type, database.getMemoryEmbeddingInput(type, id)!.generation]));
		expect(database.deleteTimelineEvent(event.id)).toBeDefined();
		const now = new Date(Date.now() + 1_000).toISOString();
		for (let count = 0; count < owners.length; count++) {
			const job = database.claimMemoryJob(now)!;
			expect(job.kind).toBe("embed");
			const input = database.snapshotMemoryEmbeddingJob(job, now)!;
			expect(input).toBeDefined();
			expect(input.generation).toBe(job.payload.generation);
			expect(input.generation).not.toBe(before.get(input.ownerType as typeof owners[number][0]));
			expect(input.text).toContain("Retained generated event");
			expect(database.completeMemoryJob(job.id, now, job.leaseToken)).toBe(true);
		}
		expect(database.claimMemoryJob(now)).toBeUndefined();
	});

	it("rejects missing or mismatched generation and fails closed on malformed reserved state", () => {
		const { database, job, input, embedding } = fixture("memory");
		expect(database.isMemoryEmbeddingCurrent({ ...embedding, generation: undefined })).toBe(false);
		expect(database.commitMemoryEmbeddingJob(job, input, { ...embedding, generation: undefined }, timestamp)).toBe(false);
		expect(database.commitMemoryEmbeddingJob(job, input, { ...embedding, contentHash: "0".repeat(64) }, timestamp)).toBe(false);
		database.queueMemoryJob({ ...job, payload: { ownerType: "memory", ownerId: "generated-owner" } });
		expect(database.snapshotMemoryEmbeddingJob(job, timestamp)).toBeUndefined();
		const owner = database.db.prepare("SELECT key FROM private_runtime_state WHERE key LIKE 'kestrel.embedding-generation.v1.owner.memory.%'").get() as { key: string };
		database.setPrivateState(owner.key, { version: 1, generation: "bad" });
		expect(() => database.getMemoryEmbeddingInput("memory", "generated-owner")).toThrow("Invalid embedding owner generation state");
	});

	it("rejects stale claims and unavailable results without writing either state", () => {
		const { database, job, input, embedding } = fixture("memory");
		const expiredAt = job.leaseUntil!;
		expect(database.commitMemoryEmbeddingJob(job, input, embedding, expiredAt)).toBe(false);
		const replacement = database.claimMemoryJob(expiredAt)!;
		expect(database.commitMemoryEmbeddingJob(job, input, { ...embedding, status: "unavailable", vector: [0] }, expiredAt)).toBe(false);
		expect(database.getMemoryJob(job.id)?.leaseToken).toBe(replacement.leaseToken);
		expect(database.listMemoryEmbeddings()).toEqual([]);
	});

	it("rolls back the vector when updating its owner fails", () => {
		const { database, job, input, embedding } = fixture("timeline_event");
		database.db.exec(`CREATE TRIGGER generated_failure BEFORE UPDATE ON memory_timeline_events
			BEGIN SELECT RAISE(ABORT, 'generated owner write failure'); END`);
		expect(() => database.commitMemoryEmbeddingJob(job, input, embedding, timestamp)).toThrow("generated owner write failure");
		expect(database.listMemoryEmbeddings()).toEqual([]);
		expect(database.getMemoryJob(job.id)?.status).toBe("running");
		expect(database.getTimelineEvent("generated-owner")?.embeddingStatus).toBe("queued");
	});
});
