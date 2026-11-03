import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { MemoryJobSchema, MemoryQuerySchema, type RuntimeMessage } from "@kestrel/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeContextService } from "./life-context";
import { MemoryManager } from "./memory";
import {
	MemorySubstrate,
	type MemoryEmbeddingProvider,
	localMemoryEmbeddingProvider,
} from "./memory-substrate";
import { AgentRuntime } from "./runtime";
import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";

const temporaryDirectories: string[] = [];

function fixture(options: {
	now?: () => Date;
	embeddingProvider?: MemoryEmbeddingProvider;
	explicitCaptureEnabled?: () => boolean;
	path?: string;
} = {}) {
	let current = options.now?.() ?? new Date("2026-07-22T12:00:00.000Z");
	const now = options.now ?? (() => current);
	const encryptionKey = createEncryptionKey();
	const database = new KestrelDatabase(
		options.path ?? ":memory:",
		encryptionKey,
	);
	const runtime = new AgentRuntime(database, [], () => now().toISOString());
	const main = runtime.ensureMainSession();
	const legacyMemory = new MemoryManager(database, now);
	const substrate = new MemorySubstrate({
		database,
		legacyMemory,
		now,
		...(options.embeddingProvider
			? { embeddingProvider: options.embeddingProvider }
			: {}),
		...(options.explicitCaptureEnabled
			? { explicitCaptureEnabled: options.explicitCaptureEnabled }
			: {}),
	});
	substrate.attachRuntime(runtime);
	return {
		database,
		runtime,
		main,
		legacyMemory,
		substrate,
		advance(value: string) {
			current = new Date(value);
		},
		async close() {
			await substrate.close();
			runtime.close();
			database.close();
		},
	};
}

function memoryInput(
	content: string,
	sourceId = "test-source",
): Parameters<MemorySubstrate["rememberForSession"]>[1] {
	return {
		type: "semantic",
		content,
		structuredData: {},
		sourceIds: [sourceId],
		sourceType: "test",
		confidence: 0.9,
		importance: 0.7,
		sensitivity: "personal",
		entityIds: [],
		userConfirmed: true,
		inferred: false,
	};
}

function queryInput(overrides: Record<string, unknown> = {}) {
	return MemoryQuerySchema.parse({
		query: "",
		...overrides,
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("memory substrate", () => {
	it.each(["domain", "file"] as const)("denies capture when a %s pattern exhausts its match budget", async scope => {
		const state = fixture();
		try {
			state.substrate.upsertCapturePolicy({ id: "generated-complex-pattern", scope,
				pattern: `*${"a".repeat(1_000)}b`, enabled: false });
			const input = { eventType: "note" as const, source: "fixture", textSummary: "Generated bounded capture",
				...(scope === "domain" ? { url: `https://${"a".repeat(4_000)}.invalid/` } : { filePath: "a".repeat(4_000) }) };
			expect(state.substrate.captureActivity(input)).toBeUndefined();
			expect(state.database.listTimelineEvents()).toEqual([]);
		} finally { await state.close(); }
	});

	it.each(["connected-source", "private-session"] as const)("keeps transitive %s content out of local fallback and agent context", async restriction => {
		const state = fixture();
		try {
			const text = "Generated source authority context sentinel";
			const identity = state.substrate.ensureAgentIdentity(state.main);
			const sourceSession = state.runtime.createSession({ title: "Generated source owner" });
			const event = state.substrate.captureActivity({ id: "generated-context-source", eventType: "note", source: "fixture",
				sourceSessionId: sourceSession.id, textSummary: text })!;
			const memory = state.substrate.remember(memoryInput(text, event.id));
			state.substrate.createWorkingTask({ id: "generated-context-task", sessionId: state.main.id, agentId: identity.id,
				sourceIds: [memory.id], projectIds: [], personIds: [], entityIds: [], goal: text, status: "planned", plan: [],
				evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], dependencyTaskIds: [], startedAt: event.startedAt,
			});
			expect(state.substrate.queryTimeline(queryInput({ query: "authority", agentId: identity.id })).results
				.some(value => value.id === memory.id)).toBe(true);
			if (restriction === "connected-source") state.database.upsertTimelineEvent({ ...event, source: "connected-source" });
			else state.database.saveRuntimeSession({ ...sourceSession, privacyMode: "private" });
			const result = state.substrate.queryTimeline(queryInput({ query: "authority", agentId: identity.id, includeSensitive: true, includeRestricted: true }));
			expect(JSON.stringify(result)).not.toContain(text);
			expect(JSON.stringify(state.substrate.listForSession(state.main.id))).not.toContain(text);
			expect(JSON.stringify(state.substrate.searchForSession(state.main.id, "authority"))).not.toContain(text);
			const context = state.substrate.getRelevantContext({ query: "authority", agentId: identity.id, includeSensitive: true, includeRestricted: true });
			expect(JSON.stringify(context)).not.toContain(text);
		} finally { await state.close(); }
	});

	it("preserves existing local timeline history when automatic capture is paused", async () => {
		const state = fixture();
		try {
			const text = "Generated retained history while capture is paused";
			const event = state.substrate.captureActivity({ eventType: "note", source: "fixture", textSummary: text })!;
			state.substrate.setCaptureEnabled(false);
			expect(state.database.getMemoryEmbeddingInput("timeline_event", event.id)).toBeUndefined();
			expect(state.substrate.queryTimeline(queryInput({ query: text })).results.some(value => value.id === event.id)).toBe(true);
		} finally { await state.close(); }
	});

	it("embeds the current event generation after session assignment changes its authority", async () => {
		const state = fixture();
		try {
			const event = state.substrate.captureActivity({ id: "generated-session-assignment", eventType: "note",
				source: "fixture", textSummary: "Generated session assignment evidence" })!;
			const initial = state.database.getMemoryEmbeddingInput("timeline_event", event.id)!;
			await state.substrate.runMaintenance(200);
			const current = state.database.getMemoryEmbeddingInput("timeline_event", event.id)!;
			expect(state.database.getTimelineEvent(event.id)?.sessionId).toMatch(/^timeline-session-/);
			expect(current.generation).not.toBe(initial.generation);
			expect(state.database.listMemoryEmbeddings({ ownerType: "timeline_event", ownerId: event.id, status: "ready" })
				.some(embedding => state.database.isMemoryEmbeddingCurrent(embedding))).toBe(true);
		} finally { await state.close(); }
	});

	it("refreshes a reactivated block even when its summary and events are unchanged", async () => {
		const state = fixture();
		try {
			state.substrate.captureActivity({ id: "generated-block-event", eventType: "note", source: "fixture",
				textSummary: "Generated retained activity block" });
			await state.substrate.runMaintenance(200);
			const block = state.database.listActivityBlocks()[0]!;
			const first = state.database.getMemoryEmbeddingInput("activity_block", block.id)!;
			state.database.upsertActivityBlock({ ...block, status: "deleted" });
			const timestamp = "2026-07-22T12:00:00.000Z";
			state.database.queueMemoryJob(MemoryJobSchema.parse({ id: "generated-block-reactivation",
				kind: "consolidate", dedupeKey: "generated-block-reactivation", payload: {}, status: "pending",
				attempts: 0, maxAttempts: 4, runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp,
			}));
			await state.substrate.runMaintenance(200);
			const current = state.database.getMemoryEmbeddingInput("activity_block", block.id)!;
			expect(state.database.getActivityBlock(block.id)?.status).toBe("active");
			expect(current.generation).not.toBe(first.generation);
			expect(state.database.listMemoryEmbeddings({ ownerType: "activity_block", ownerId: block.id, status: "ready" })
				.some(embedding => state.database.isMemoryEmbeddingCurrent(embedding))).toBe(true);
		} finally { await state.close(); }
	});

	it("queues a fresh opaque generation after a completed A -> B -> A correction", async () => {
		const embedded: string[] = [];
		const state = fixture({ embeddingProvider: {
			provider: "generated", model: "generated", async embed(text) { embedded.push(text); return [1]; },
		} });
		try {
			const text = "Generated alpha release advice";
			const memory = state.substrate.remember(memoryInput(text));
			await state.substrate.runMaintenance(200);
			const first = state.database.getMemoryEmbeddingInput("memory", memory.id)!;
			const original = state.database.listMemoryJobs({ kind: "embed", limit: 2_000 })
				.find(job => job.payload.ownerType === "memory" && job.payload.ownerId === memory.id)!;
			expect(original.status).toBe("completed");
			expect(original.payload.generation).toBe(first.generation);
			const before = embedded.filter(value => value === text).length;
			state.substrate.correct(memory.id, { content: "Generated beta release advice" });
			state.substrate.correct(memory.id, { content: text });
			const returned = state.database.getMemoryEmbeddingInput("memory", memory.id)!;
			expect(returned.generation).not.toBe(first.generation);
			expect(returned.contentHash).toBe(first.contentHash);
			const queued = state.database.listMemoryJobs({ kind: "embed", limit: 2_000 })
				.find(job => job.payload.ownerType === "memory" && job.payload.ownerId === memory.id && job.payload.generation === returned.generation)!;
			expect(queued.status).toBe("pending");
			expect(queued.id).not.toBe(original.id);
			expect(queued.dedupeKey).toBe(`embed:memory:${memory.id}:${returned.generation}`);
			await state.substrate.runMaintenance(200);
			expect(embedded.filter(value => value === text).length).toBeGreaterThan(before);
			expect(state.database.getMemoryJob(queued.id)?.status).toBe("completed");
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id })
				.some(value => state.database.isMemoryEmbeddingCurrent(value))).toBe(true);
		} finally { await state.close(); }
	});

	it.each(["changed-owner", "legacy-vector"] as const)("ignores a ready %s when scoring current timeline text", async mode => {
		const state = fixture();
		try {
			const query = "orchid pearl";
			const event = state.substrate.captureActivity({ id: "generated-vector-owner", eventType: "note",
				source: "fixture", textSummary: "Generated fruit basket", startedAt: "2026-07-22T12:00:00.000Z" })!;
			const input = state.database.getMemoryEmbeddingInput("timeline_event", event.id)!;
			const vector = [...localSemanticEmbedding(query)];
			state.database.upsertMemoryEmbedding({ id: "generated-ready-vector", ownerType: "timeline_event", ownerId: event.id,
				generation: mode === "legacy-vector" ? undefined : input.generation, contentHash: input.contentHash,
				provider: "local-hash", model: "kestrel-local-256-v1", dimension: vector.length, vector,
				status: "ready", createdAt: event.createdAt, updatedAt: event.updatedAt,
			});
			if (mode === "changed-owner") state.database.upsertTimelineEvent({ ...state.database.getTimelineEvent(event.id)!, textSummary: "Generated garden tools" });
			const current = state.database.getTimelineEvent(event.id)!;
			const result = state.substrate.queryTimeline(queryInput({ query, startAt: "2026-07-22T00:00:00.000Z" }));
			const match = result.results.find(value => value.kind === "timeline_event" && value.id === event.id)!;
			expect(match).toBeDefined();
			expect(match.semanticScore).toBeCloseTo(semanticSimilarity(localSemanticEmbedding(query), localSemanticEmbedding(current.textSummary)), 6);
			expect(match.semanticScore).toBeLessThan(0.99);
			expect(state.database.listMemoryEmbeddings({ ownerType: "timeline_event", ownerId: event.id })).toHaveLength(1);
		} finally { await state.close(); }
	});

	it.each([
		["rewrite", false], ["rewrite", true],
		["delete-and-recreate", false], ["delete-and-recreate", true],
	] as const)("discards a pending result after %s, provider failure=%s", async (mutation, failProvider) => {
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { entered = resolve; });
		const fallback = vi.spyOn(localMemoryEmbeddingProvider, "embed");
		const state = fixture({ embeddingProvider: {
			provider: "generated-deferred", model: "generated-deferred",
			async embed() {
				entered(); await pending;
				if (failProvider) throw new Error("Generated provider failure");
				return [1];
			},
		} });
		let maintenance: ReturnType<MemorySubstrate["runMaintenance"]> | undefined;
		try {
			const memory = state.substrate.remember(memoryInput("Generated original memory"));
			state.database.db.prepare("DELETE FROM memory_jobs").run();
			const timestamp = "2026-07-22T12:00:00.000Z";
			state.database.queueMemoryJob(MemoryJobSchema.parse({
				id: "generated-deferred-job", dedupeKey: "generated-deferred-job", kind: "embed",
				status: "pending", payload: { ownerType: "memory", ownerId: memory.id, generation: state.database.getMemoryEmbeddingInput("memory", memory.id)!.generation },
				attempts: 0, maxAttempts: 3, runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp,
			}));
			maintenance = state.substrate.runMaintenance(1);
			await Promise.race([started, maintenance.then(() => {
				throw new Error("Generated embedding provider was not dispatched.");
			})]);
			if (mutation === "rewrite") state.database.upsertMemory({ ...memory, content: "Generated replacement memory" });
			else {
				state.database.purgeMemory(memory.id);
				state.database.upsertMemory(memory);
			}
			release();
			const result = await maintenance;
			expect(result.jobsCompleted).toBe(0);
			expect(state.database.listMemoryEmbeddings()).toEqual([]);
			expect(fallback).not.toHaveBeenCalled();
			if (mutation === "rewrite") {
				expect(result.jobsRetried).toBe(1);
				expect(state.database.getMemoryJob("generated-deferred-job")?.status).toBe("pending");
			} else expect(state.database.getMemoryJob("generated-deferred-job")).toBeUndefined();
		} finally {
			try { release(); await maintenance; }
			finally { fallback.mockRestore(); await state.close(); }
		}
	});

	it("repairs a completed descendant vector after source privacy changes without reading the descendant", async () => {
		const calls: string[] = [];
		const state = fixture({ embeddingProvider: { provider: "repair", model: "repair", async embed(text) { calls.push(text); return [1]; } } });
		try {
			const source = state.runtime.createSession({ title: "Repair source" });
			const event = state.substrate.captureActivity({ id: "repair-source-event", eventType: "note", source: "fixture",
				sourceSessionId: source.id, textSummary: "Repair source event" })!;
			const text = "Repair descendant memory sentinel";
			const memory = state.substrate.remember(memoryInput(text, event.id));
			await state.substrate.runMaintenance(100);
			const before = state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id, status: "ready" })[0]!;
			expect(before).toBeDefined();
			const priorCalls = calls.filter(value => value === text).length;
			state.database.saveRuntimeSession({ ...source, privacyMode: "private" });
			state.database.saveRuntimeSession({ ...source, privacyMode: "standard" });
			expect(state.database.listMemoryJobs({ kind: "embed", status: "pending", limit: 2000 })
				.some(job => job.payload.ownerType === "memory" && job.payload.ownerId === memory.id)).toBe(false);
			for (let i = 0; i < 4; i++) await state.substrate.runMaintenance(100);
			const current = state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id, status: "ready" });
			expect(current.some(value => state.database.isMemoryEmbeddingCurrent(value))).toBe(true);
			expect(calls.filter(value => value === text).length).toBeGreaterThan(priorCalls);
		} finally { await state.close(); }
	});

	it("dispatches a fresh descendant generation when source authority changes before dispatch", async () => {
		const calls: string[] = [];
		const state = fixture({ embeddingProvider: { provider: "repair", model: "repair", async embed(text) { calls.push(text); return [1]; } } });
		try {
			const source = state.runtime.createSession({ title: "Pending source" });
			const event = state.substrate.captureActivity({ id: "pending-source-event", eventType: "note", source: "fixture",
				sourceSessionId: source.id, textSummary: "Pending source event" })!;
			const text = "Pending descendant memory sentinel";
			const memory = state.substrate.remember(memoryInput(text, event.id));
			state.database.saveRuntimeSession({ ...source, privacyMode: "private" });
			state.database.saveRuntimeSession({ ...source, privacyMode: "standard" });
			for (let i = 0; i < 4; i++) await state.substrate.runMaintenance(100);
			expect(calls).toContain(text);
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id, status: "ready" })
				.some(value => state.database.isMemoryEmbeddingCurrent(value))).toBe(true);
		} finally { await state.close(); }
	});

	it("requeues a changed descendant after an in-flight final attempt", async () => {
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { entered = resolve; });
		const calls: string[] = [];
		const state = fixture({ embeddingProvider: { provider: "repair", model: "repair", async embed(text) {
			calls.push(text); if (calls.length === 1) { entered(); await pending; } return [1];
		} } });
		let maintenance: ReturnType<MemorySubstrate["runMaintenance"]> | undefined;
		try {
			const source = state.runtime.createSession({ title: "Deferred source" });
			const event = state.substrate.captureActivity({ id: "deferred-source-event", eventType: "note", source: "fixture",
				sourceSessionId: source.id, textSummary: "Deferred source event" })!;
			const text = "Deferred descendant memory sentinel";
			const memory = state.substrate.remember(memoryInput(text, event.id));
			const generation = state.database.getMemoryEmbeddingInput("memory", memory.id)!.generation;
			state.database.db.prepare("DELETE FROM memory_jobs").run();
			const timestamp = "2026-07-22T12:00:00.000Z";
			state.database.queueMemoryJob(MemoryJobSchema.parse({ id: "final-attempt", dedupeKey: "final-attempt", kind: "embed",
				status: "pending", payload: { ownerType: "memory", ownerId: memory.id, generation }, attempts: 0, maxAttempts: 1,
				runAfter: timestamp, createdAt: timestamp, updatedAt: timestamp }));
			maintenance = state.substrate.runMaintenance(1);
			await Promise.race([started, maintenance.then(() => { throw new Error("Provider was not dispatched"); })]);
			state.database.saveRuntimeSession({ ...source, privacyMode: "private" });
			state.database.saveRuntimeSession({ ...source, privacyMode: "standard" });
			release(); await maintenance;
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id })).toHaveLength(0);
			// The replacement must be durable even without an old cache row.
			for (let i = 0; i < 4; i++) await state.substrate.runMaintenance(100);
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id, status: "ready" })
				.some(value => state.database.isMemoryEmbeddingCurrent(value))).toBe(true);
		} finally { release(); await maintenance; await state.close(); }
	});

	it("does not dispatch a descendant embedding while its source session is private", async () => {
		const calls: string[] = [];
		const state = fixture({ embeddingProvider: { provider: "repair", model: "repair", async embed(text) { calls.push(text); return [1]; } } });
		try {
			const source = state.runtime.createSession({ title: "Private source" });
			const event = state.substrate.captureActivity({ id: "private-repair-event", eventType: "note", source: "fixture",
				sourceSessionId: source.id, textSummary: "Private event sentinel" })!;
			const text = "Private descendant sentinel";
			const memory = state.substrate.remember(memoryInput(text, event.id));
			state.database.saveRuntimeSession({ ...source, privacyMode: "private" });
			for (let i = 0; i < 3; i++) await state.substrate.runMaintenance(100);
			expect(calls).not.toContain(text);
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id })).toHaveLength(0);
		} finally { await state.close(); }
	});

	it("rediscovers a denied pending descendant after its source is regranted without a cached vector", async () => {
		const calls: string[] = [];
		const state = fixture({ embeddingProvider: { provider: "repair", model: "repair", async embed(text) { calls.push(text); return [1]; } } });
		try {
			const source = state.runtime.createSession({ title: "Regrant source" });
			const event = state.substrate.captureActivity({ id: "regrant-source-event", eventType: "note", source: "fixture",
				sourceSessionId: source.id, textSummary: "Regrant source event" })!;
			const text = "Regrant descendant sentinel";
			const memory = state.substrate.remember(memoryInput(text, event.id));
			state.database.saveRuntimeSession({ ...source, privacyMode: "private" });
			for (let i = 0; i < 4; i++) await state.substrate.runMaintenance(100);
			expect(calls).not.toContain(text);
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id })).toHaveLength(0);
			expect(state.database.listMemoryJobs({ kind: "embed", status: "pending", limit: 2000 })
				.some(job => job.payload.ownerType === "memory" && job.payload.ownerId === memory.id)).toBe(false);
			state.database.saveRuntimeSession({ ...source, privacyMode: "standard" });
			for (let i = 0; i < 12; i++) await state.substrate.runMaintenance(100);
			expect(calls).toContain(text);
			expect(state.database.listMemoryEmbeddings({ ownerType: "memory", ownerId: memory.id, status: "ready" })
				.some(value => state.database.isMemoryEmbeddingCurrent(value))).toBe(true);
		} finally { await state.close(); }
	});

	it("does not revive an exhausted current generation during repeated repair", async () => {
		const calls: string[] = [];
		const state = fixture({ embeddingProvider: { provider: "repair", model: "repair", async embed(text) { calls.push(text); return [1]; } } });
		try {
			const text = "Exhausted generation sentinel";
			const memory = state.substrate.remember(memoryInput(text));
			const input = state.database.getMemoryEmbeddingInput("memory", memory.id)!;
			const job = state.database.listMemoryJobs({ kind: "embed", limit: 2000 })
				.find(value => value.payload.ownerType === "memory" && value.payload.ownerId === memory.id)!;
			expect(job.payload.generation).toBe(input.generation);
			state.database.db.prepare("DELETE FROM memory_jobs WHERE id <> ?").run(job.id);
			state.database.queueMemoryJob({ ...job, status: "failed", attempts: job.maxAttempts, lastError: "Exhausted fixture" });
			const timestamp = "2026-07-22T12:00:00.000Z";
			state.database.upsertMemoryEmbedding({ id: "exhausted-stale-vector", ownerType: "memory", ownerId: memory.id,
				contentHash: input.contentHash, provider: "repair", model: "old", dimension: 1, vector: [1], status: "ready",
				createdAt: timestamp, updatedAt: timestamp });
			for (let i = 0; i < 12; i++) await state.substrate.runMaintenance(100);
			expect(calls).not.toContain(text);
			expect(state.database.getMemoryJob(job.id)).toMatchObject({ status: "failed", attempts: job.maxAttempts });
		} finally { await state.close(); }
	});

	it("captures redacted runtime activity and builds searchable aggregates", async () => {
		const state = fixture();
		try {
			const first = state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: "The deployment password=super-secret must never be retained.",
			});
			state.advance("2026-07-22T12:05:00.000Z");
			state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "assistant",
				content: "I will keep the release checklist in RELEASE.md.",
			});

			await state.substrate.runMaintenance(100);
			const events = state.database.listTimelineEvents({ ascending: true });
			expect(events).toHaveLength(2);
			expect(events[0]?.textSummary).toContain("password=[redacted]");
			expect(events[0]?.textSummary).not.toContain("super-secret");
			expect(state.database.listTimelineSessions()).toHaveLength(1);
			expect(state.database.listActivityBlocks()).toHaveLength(1);
			expect(state.database.listDailySummaries()).toHaveLength(1);
			expect(
				state.database.listMemoryEmbeddings({ status: "ready" }).length,
			).toBeGreaterThan(0);

			const result = state.substrate.queryTimeline(
				queryInput({
					query: "release checklist",
					includeMemories: false,
					includeEntities: false,
					includeAgents: false,
					includeTasks: false,
				}),
			);
			expect(result.events.some((event) => event.id === `timeline-message-${first.id}`)).toBe(true);
			expect(result.results.some((item) => item.kind === "timeline_event" || item.kind === "activity_block")).toBe(true);
		} finally {
			await state.close();
		}
	});

	it("keeps credentials out of every memory ingress and derived surface", async () => {
		const embedded: string[] = [];
		const state = fixture({
			explicitCaptureEnabled: () => true,
			embeddingProvider: {
				provider: "test",
				model: "test-v1",
				async embed(text) {
					embedded.push(text);
					return [1];
				},
			},
		});
		const secrets = [
			"correct-horse-battery-staple",
			"plain-language-password-should-not-persist",
			"sk-proj-12345678901234567890",
			"654321",
			"cvv-test-492",
			"-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----",
		];
		try {
			state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: `password=${secrets[0]} api_key=${secrets[1]} otp=${secrets[2]} cvv=${secrets[3]}\\n${secrets[4]}`,
			});
			state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: `Remember that my recovery code is ${secrets[2]}.`,
			});
			state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: `I prefer password=${secrets[0]}`,
			});
			state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: `My password is ${secrets[1]}.`,
			});
			state.substrate.remember(memoryInput(`private_key=${secrets[4]}`));
			await state.substrate.runMaintenance(200);

			const persisted = JSON.stringify({
				events: state.database.listTimelineEvents(),
				sessions: state.database.listTimelineSessions(),
				blocks: state.database.listActivityBlocks(),
				summaries: state.database.listDailySummaries(),
				memories: state.legacyMemory.list(),
				agentMemories: state.database.listAllAgentMemories(),
				provenance: state.database.listMemoryProvenance({ limit: 500 }),
			});
			for (const secret of secrets) expect(persisted).not.toContain(secret);
			for (const text of embedded) for (const secret of secrets) expect(text).not.toContain(secret);
			expect(embedded.length).toBeGreaterThan(0);
		} finally {
			await state.close();
		}
	});

	it("keeps explicit Remember writes available while automatic capture is disabled", async () => {
		const state = fixture();
		try {
			state.substrate.setCaptureEnabled(false);
			const message = state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: "Remember that deployment notes live in ops.md.",
			});

			expect(state.database.listTimelineEvents()).toEqual([]);
			expect(state.legacyMemory.activeMemories()).toMatchObject([
			{ content: "deployment notes live in ops.md.", sourceIds: [message.id] },
		]);
			expect(state.substrate.captureStatus().configuration.enabled).toBe(false);
		} finally {
			await state.close();
		}
	});

	it("isolates persistent parents from personal memory and each other", async () => {
		const state = fixture();
		try {
			const first = state.runtime.createSession({ title: "Engineering", kind: "agent" });
			const second = state.runtime.createSession({ title: "School", kind: "agent" });
			state.substrate.remember(memoryInput("Personal private preference", "personal"));
			const remembered = state.substrate.rememberForSession(first.id,
				memoryInput("Engineering mechanism decision", "engineering"));
			expect(state.substrate.listForSession(first.id)).toContainEqual(remembered);
			expect(state.substrate.listForSession(second.id)).toEqual([]);
			expect(state.substrate.listForSession(state.main.id).map(item => item.content))
				.not.toContain("Engineering mechanism decision");
			const identity = state.substrate.ensureAgentIdentity(first);
			const context = state.substrate.getRelevantContext({ query: "private preference mechanism",
				sessionId: first.id, agentId: identity.id, includeSharedMemory: true });
			expect(context.prompt).not.toContain("Personal private preference");
			expect(context.prompt).toContain("Engineering mechanism decision");
			expect(state.substrate.getRelevantContext({ query: "private preference", sessionId: first.id }).prompt)
				.not.toContain("Personal private preference");
			expect(() => state.substrate.getRelevantContext({ query: "mechanism", sessionId: second.id, agentId: identity.id }))
				.toThrow(/another agent/);
		} finally { await state.close(); }
	});

	it("keeps private agent memory separate from global context and tasks", async () => {
		const state = fixture();
		try {
			const child = state.runtime.createSession({
				title: "Private delegated worker",
				parentSessionId: state.main.id,
			});
			const childIdentity = state.substrate.ensureAgentIdentity(child);
			state.substrate.remember(memoryInput("Global user preference", "global"));
			const privateMemory = state.substrate.rememberForSession(
				child.id,
				memoryInput("Private worker checkpoint", "private"),
			);
			const sibling = state.runtime.createSession({
				title: "Another delegated worker",
				parentSessionId: state.main.id,
			});
			const privateTask = state.substrate.createWorkingTask({
				id: "private-task",
				sessionId: child.id,
				agentId: childIdentity.id,
				sourceIds: ["private-task-source"],
				projectIds: [],
				personIds: [],
				entityIds: [],
				goal: "Keep private worker context bounded",
				plan: [],
				status: "running",
				evidence: [],
				artifacts: [],
				failures: [],
				unresolvedQuestions: [],
				subtaskIds: [],
				dependencyTaskIds: [],
				startedAt: new Date("2026-07-22T12:00:00.000Z").toISOString(),
			});

			const privateContext = state.substrate.getRelevantContext({
				query: "private worker",
				sessionId: child.id,
				agentId: childIdentity.id,
				includeSharedMemory: false,
			});
			expect(privateContext.prompt).toContain("Private worker checkpoint");
			expect(privateContext.prompt).toContain(privateTask.goal);
			expect(privateContext.prompt).not.toContain("Global user preference");

			const globalQuery = state.substrate.queryTimeline(
				queryInput({
					query: "private worker",
					includeTimeline: false,
					includeMemories: false,
					includeEntities: false,
					includeAgents: false,
					includeTasks: true,
				}),
			);
			expect(globalQuery.results.some((item) => item.id === privateTask.id)).toBe(false);
			expect(state.substrate.listForSession(child.id)).toContainEqual(privateMemory);
			expect(state.substrate.listForSession(child.id)).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ content: "Global user preference" }),
				]),
			);

			const corrected = state.substrate.correctAgentMemory(
				child.id,
				privateMemory.id,
				"Private worker checkpoint, corrected by the user.",
			);
			expect(corrected.content).toContain("corrected");
			expect(
				state.substrate
					.listAgentMemoryProvenance(child.id, corrected.id)
					.some((item) => item.sourceType === "user-correction"),
			).toBe(true);
			expect(() =>
				state.substrate.listAgentMemoryProvenance(sibling.id, corrected.id),
			).toThrow("not found in this session");
			expect(state.substrate.forgetAgentMemory(child.id, corrected.id).status).toBe(
				"deleted",
			);
			expect(state.substrate.listForSession(child.id)).toEqual([]);

			const mainIdentity = state.substrate.ensureAgentIdentity(state.main);
			const completedTask = state.substrate.createWorkingTask({
				id: "main-outcome-task",
				sessionId: state.main.id,
				agentId: mainIdentity.id,
				sourceIds: ["main-outcome-task"],
				projectIds: [],
				personIds: [],
				entityIds: [],
				goal: "Summarize the main task",
				plan: [],
				status: "completed",
				evidence: [],
				artifacts: [],
				failures: [],
				unresolvedQuestions: [],
				subtaskIds: [],
				dependencyTaskIds: [],
				outcomeSummary: "Main task outcome is available to the main agent.",
				startedAt: "2026-07-22T12:00:00.000Z",
				completedAt: "2026-07-22T12:01:00.000Z",
				createdAt: "2026-07-22T12:00:00.000Z",
				updatedAt: "2026-07-22T12:01:00.000Z",
			});
		state.substrate.recordTaskOutcome(completedTask, mainIdentity.id);
			expect(
				state.substrate.listForSession(state.main.id).some(
					(memory) => memory.id === "agent-outcome-main-outcome-task",
				),
			).toBe(true);
		} finally {
			await state.close();
		}
	});

	it("does not capture private or incognito conversations", async () => {
		const state = fixture();
		try {
			const privateSession = state.runtime.createSession({
				title: "Private conversation",
				privacyMode: "private",
			});
			const incognitoSession = state.runtime.createSession({
				title: "Incognito conversation",
				privacyMode: "incognito",
			});
			state.runtime.appendMessage({
				sessionId: privateSession.id,
				role: "user",
				content: "This must not be captured.",
			});
			state.runtime.appendMessage({
				sessionId: incognitoSession.id,
				role: "user",
				content: "Neither should this be captured.",
			});

			const identityIds = state.database
				.listAgentIdentities()
				.map((identity) => identity.id);
			expect(identityIds).not.toContain(`agent-${privateSession.id}`);
			expect(identityIds).not.toContain(`agent-${incognitoSession.id}`);
			expect(state.substrate.isPrivateMemorySession(privateSession.id)).toBe(true);
			expect(state.substrate.isPrivateMemorySession(incognitoSession.id)).toBe(true);
			expect(() => state.substrate.assertMemorySession(privateSession.id)).toThrow(
				"Memory tools are disabled",
			);
			expect(() => state.substrate.listForSession(incognitoSession.id)).toThrow(
				"Memory tools are disabled",
			);
			expect(
				state.substrate.captureActivity({
					sessionId: privateSession.id,
					eventType: "note",
					source: "test",
					textSummary: "This must stay private.",
				}),
			).toBeUndefined();
			expect(() =>
				state.substrate.getRelevantContext({
					sessionId: incognitoSession.id,
					query: "incognito",
				}),
			).toThrow("Memory tools are disabled");
			expect(state.database.listTimelineEvents()).toEqual([]);
			expect(() =>
				state.substrate.rememberForSession(
					privateSession.id,
					memoryInput("private conversation memory"),
				),
			).toThrow(/disabled for private and incognito/i);
		} finally {
			await state.close();
		}
	});

	it("supports temporal retrieval, sensitivity filters, and person relation cleanup", async () => {
		const state = fixture();
		try {
			const person = new LifeContextService(
				state.database,
				undefined,
				() => new Date("2026-07-22T12:00:00.000Z"),
				state.legacyMemory,
			).upsertPerson({ displayName: "Ada Lovelace", sourceId: "people-test", sensitivity: "personal" });
			state.substrate.reconcilePeople();
			state.substrate.captureActivity({
				id: "tuesday-event",
				startedAt: "2026-07-21T15:00:00.000Z",
				eventType: "note",
				source: "test",
				textSummary: "Ada reviewed the release plan.",
				personIds: [person.id],
			});
			state.substrate.captureActivity({
				id: "sensitive-event",
				startedAt: "2026-07-22T15:00:00.000Z",
				eventType: "note",
				source: "test",
				textSummary: "Sensitive note.",
				sensitivity: "sensitive",
			});
			state.substrate.captureActivity({
				id: "restricted-event",
				startedAt: "2026-07-22T16:00:00.000Z",
				eventType: "note",
				source: "test",
				textSummary: "Restricted note.",
				sensitivity: "restricted",
			});
			await state.substrate.runMaintenance(100);

			const tuesday = state.substrate.queryTimeline("last Tuesday");
			expect(tuesday.events.map((event) => event.id)).toContain("tuesday-event");
			const ordinary = state.substrate.queryTimeline("note");
			expect(ordinary.events.map((event) => event.id)).not.toContain("sensitive-event");
			expect(ordinary.events.map((event) => event.id)).not.toContain("restricted-event");
			const privileged = state.substrate.queryTimeline(
				queryInput({ query: "note", includeSensitive: true, includeRestricted: true }),
			);
			expect(privileged.events.map((event) => event.id)).toEqual(
				expect.arrayContaining(["sensitive-event", "restricted-event"]),
			);

			const personId = person.id;
			new LifeContextService(
				state.database,
				undefined,
				() => new Date("2026-07-22T12:00:00.000Z"),
				state.legacyMemory,
			).deletePerson(personId);
			state.substrate.reconcilePeople();
			expect(state.database.getMemoryEntity(`memory-person-${personId}`)).toBeUndefined();
			expect(state.database.getTimelineEvent("tuesday-event")?.personIds).toEqual([]);
		} finally {
			await state.close();
		}
	});

	it("persists across a restart and reconciles direct legacy deletion", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-memory-substrate-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "profile.sqlite");
		const key = createEncryptionKey();
		const firstDatabase = new KestrelDatabase(path, key);
		const firstRuntime = new AgentRuntime(firstDatabase, [], () => "2026-07-22T12:00:00.000Z");
		const firstMain = firstRuntime.ensureMainSession();
		const firstLegacy = new MemoryManager(firstDatabase, () => new Date("2026-07-22T12:00:00.000Z"));
		const firstSubstrate = new MemorySubstrate({ database: firstDatabase, legacyMemory: firstLegacy, now: () => new Date("2026-07-22T12:00:00.000Z") });
		firstSubstrate.attachRuntime(firstRuntime);
		const remembered = firstSubstrate.remember(memoryInput("Survives a profile restart", "restart-source"));
		firstRuntime.appendMessage({ sessionId: firstMain.id, role: "user", content: "Restart persistence event." });
		firstRuntime.close();
		await firstSubstrate.close();
		firstDatabase.close();

		const secondDatabase = new KestrelDatabase(path, key);
		const secondRuntime = new AgentRuntime(secondDatabase, [], () => "2026-07-22T12:00:00.000Z");
		const secondLegacy = new MemoryManager(secondDatabase, () => new Date("2026-07-22T12:00:00.000Z"));
		const secondSubstrate = new MemorySubstrate({ database: secondDatabase, legacyMemory: secondLegacy, now: () => new Date("2026-07-22T12:00:00.000Z") });
		secondSubstrate.attachRuntime(secondRuntime);
		try {
			expect(secondLegacy.list()).toMatchObject([{ id: remembered.id, content: "Survives a profile restart" }]);
			expect(secondDatabase.listTimelineEvents()).toHaveLength(1);
			secondLegacy.forget(remembered.id);
			expect(secondSubstrate.queryTimeline("restart").results.some((item) => item.id === remembered.id)).toBe(false);
			expect(secondDatabase.getAgentMemory(`agent-memory-${remembered.id}`)).toBeUndefined();
		} finally {
			await secondSubstrate.close();
			secondRuntime.close();
			secondDatabase.close();
		}
	});

	it("redacts corrections, preserves supersession, and falls back from a bad embedder", async () => {
		const badEmbedder: MemoryEmbeddingProvider = {
			provider: "test-remote",
			model: "test-bad-v1",
			async embed() {
				return [Number.NaN];
			},
		};
		const state = fixture({ embeddingProvider: badEmbedder });
		try {
			const first = state.substrate.remember({
				...memoryInput("I prefer compact release notes", "preference-1"),
				structuredData: { conflictKey: "style" },
			});
			const second = state.substrate.remember({
				...memoryInput("I prefer detailed release notes", "preference-2"),
				structuredData: { conflictKey: "style" },
			});
			expect(state.legacyMemory.list().find((memory) => memory.id === first.id)?.status).toBe("superseded");
			expect(state.legacyMemory.list().find((memory) => memory.id === second.id)?.status).toBe("active");

			const corrected = state.substrate.correct(first.id, {
				content: "password=never-store-this token=sk-12345678901234567890",
			});
			expect(corrected.content).not.toContain("never-store-this");
			expect(corrected.content).not.toContain("sk-12345678901234567890");
			expect(state.database.getAgentMemory(`agent-memory-${first.id}`)?.content).toBe(corrected.content);
			expect(
			state.database
				.listMemoryProvenance({ ownerType: "memory", ownerId: first.id })
				.every((item) => !JSON.stringify(item).includes("never-store-this")),
			).toBe(true);

			await state.substrate.runMaintenance(100);
			expect(state.database.listMemoryEmbeddings({ status: "ready" }).length).toBeGreaterThan(0);
		} finally {
			await state.close();
		}
	});

	it("retries malformed background work without taking down the runtime", async () => {
		const state = fixture();
		try {
			const message: RuntimeMessage = state.runtime.appendMessage({
				sessionId: state.main.id,
				role: "user",
				content: "A malformed extraction candidate should be ignored: \u0000\u0001",
			});
			await state.substrate.runMaintenance(100);
			expect(state.database.getTimelineEvent(`timeline-message-${message.id}`)).toBeDefined();
			expect(state.legacyMemory.activeMemories()).toEqual([]);
			expect(state.runtime.getSession(state.main.id).status).toBe("active");
		} finally {
			await state.close();
		}
	});
});

 it("does not embed a source-linked task even when the source row is gone", async () => {
  const embedded: string[] = [];
  const state = fixture({ embeddingProvider: { provider: "fixture", model: "fixture", embed: async text => { embedded.push(text); return [1]; } } });
  try {
   const identity = state.substrate.ensureAgentIdentity(state.main);
   state.substrate.createWorkingTask({ id: "source-task", sessionId: state.main.id, agentId: identity.id,
    sourceIds: ["observation-deleted-fixture"], projectIds: [], personIds: [], entityIds: [], goal: "Private source-derived request", outcomeSummary: "Private source-derived result", status: "completed", plan: [], evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], dependencyTaskIds: [], startedAt: "2026-07-22T12:00:00.000Z" });
   const sourceTask = state.database.getWorkingTask("source-task")!;
   state.substrate.createWorkingTask({ ...sourceTask, id: "ordinary-task", sourceIds: [], goal: "Ordinary permitted task", outcomeSummary: "Ordinary result" });
   await state.substrate.runMaintenance(200);
   expect(embedded.some(text => text.includes("Ordinary permitted task"))).toBe(true);
   expect(embedded.some(text => text.includes("Private source-derived"))).toBe(false);
   expect(state.database.getWorkingTask("source-task")).toBeDefined();
  } finally { await state.close(); }
 });
