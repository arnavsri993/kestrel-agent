import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { MemoryQuerySchema, type RuntimeMessage } from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { LifeContextService } from "./life-context";
import { MemoryManager } from "./memory";
import {
	MemorySubstrate,
	type MemoryEmbeddingProvider,
} from "./memory-substrate";
import { AgentRuntime } from "./runtime";

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
