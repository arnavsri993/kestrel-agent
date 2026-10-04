import { tmpdir } from "node:os";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentMemoryRecordSchema, CoreRequestSchema, CoreResponseSchema, MemoryDocumentSaveSchema, MemoryWorkspaceSchema, WorkingTaskSchema } from "@kestrel/shared-types";
import { describe, expect, it, vi } from "vitest";
import { AgentCore, type ModelProvider } from "./index";

function setup(provider?: ModelProvider) {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const core = new AgentCore({ database, workspaceRoots: [tmpdir()], projects: [{ id: "robotics", name: "Robotics", path: tmpdir(), order: 0, createdAt: "2026-09-16T15:00:00.000Z", updatedAt: "2026-09-16T15:00:00.000Z" }], ...(provider ? { modelProviders: [provider] } : {}), now: () => "2026-09-16T15:00:00.000Z" });
	return { core, database, send: (input: unknown) => core.handle(CoreRequestSchema.parse(input)) };
}

describe("memory workspace integration", () => {
	it("stops remembering a chat atomically and keeps its transcript", async () => {
		const { core, database, send } = setup();
		try {
			const session = core.runtime.ensureMainSession();
			const message = core.runtime.appendMessage({ sessionId: session.id, role: "user", content: "Owned remembered fixture." });
			const eventId = `timeline-message-${message.id}`;
			const task = core.memorySubstrate.createWorkingTask(WorkingTaskSchema.parse({ id: "owned-running-task", sessionId: session.id, agentId: "agent-main", goal: "Owned pending work", status: "running", sourceIds: [`session:${session.id}`], plan: [], evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], startedAt: message.createdAt, createdAt: message.createdAt, updatedAt: message.createdAt }));
			expect(database.getTimelineEvent(eventId)).toBeDefined();
			const saved = await send({ type: "memory-document-save", document: { kind: "memory", title: "Owned source note", text: "Owned remembered fixture.", sourceIds: [eventId] } });
			if (!saved.ok || !saved.memoryDocument) throw new Error("Document missing");
			const forget = core.memorySubstrate.forgetSource.bind(core.memorySubstrate);
			const failure = vi.spyOn(core.memorySubstrate, "forgetSource").mockImplementationOnce(sourceId => { forget(sourceId); throw new Error("Owned removal failure"); });
			const failed = await send({ type: "runtime-stop-remembering-session", sessionId: session.id });
			expect(failed.ok).toBe(false);
			expect(core.runtime.getSession(session.id).privacyMode ?? "standard").toBe("standard");
			expect(database.getTimelineEvent(eventId)).toBeDefined();
			expect(core.memoryWorkspace.read().documents.some(document => document.id === saved.memoryDocument!.id)).toBe(true);
			failure.mockRestore();
			const stopped = await send({ type: "runtime-stop-remembering-session", sessionId: session.id });
			expect(stopped.ok && stopped.session?.privacyMode).toBe("private");
			expect(database.getTimelineEvent(eventId)).toBeUndefined();
			expect(core.memoryWorkspace.read().documents.some(document => document.id === saved.memoryDocument!.id)).toBe(false);
			expect(database.listRuntimeMessages(session.id).some(item => item.id === message.id)).toBe(true);
			const next = core.runtime.appendMessage({ sessionId: session.id, role: "user", content: "Owned unremembered fixture." });
			expect(database.getTimelineEvent(`timeline-message-${next.id}`)).toBeUndefined();
			core.memorySubstrate.recordTaskOutcome({ ...task, status: "completed", outcomeSummary: "Owned completion after privacy changed" });
			expect(database.getWorkingTask(task.id)).toBeUndefined();
			expect(database.getAgentMemory(`agent-outcome-${task.id}`)).toBeUndefined();
			core.memorySubstrate.createWorkingTask({ ...task, id: "owned-private-task" });
			expect(database.getWorkingTask("owned-private-task")).toBeUndefined();
			expect((await send({ type: "runtime-stop-remembering-session", sessionId: session.id })).ok).toBe(true);
		} finally { await core.close(); database.close(); }
	});

	it("keeps historical point events out of the selected Memory period", async () => {
		const { core, database, send } = setup();
		try {
			const startAt = "2026-09-16T00:00:00.000Z";
			const endAt = "2026-09-23T00:00:00.000Z";
			for (const [id, startedAt] of [["old-point", "2026-09-01T15:00:00.000Z"], ["current-point", "2026-09-16T15:00:00.000Z"], ["end-point", endAt]]) {
				database.upsertTimelineEvent({ id: id!, startedAt: startedAt!, source: "synthetic-test", eventType: "project_activity", actor: "user", projectIds: [], personIds: [], entityIds: [], textSummary: "Synthetic period activity", structuredData: {}, importance: 0.5, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "not_requested", status: "active", createdAt: startAt, updatedAt: startAt });
			}
			const response = await send({ type: "memory-workspace-read", query: { viewerId: "user", startAt, endAt } });
			expect(response.ok).toBe(true);
			if (!response.ok || !response.memoryWorkspace) throw new Error("Workspace missing");
			expect(response.memoryWorkspace.days).toHaveLength(1);
			expect(response.memoryWorkspace.days[0]?.events.map(event => [event.id, event.startedAt])).toEqual([["current-point", "2026-09-16T15:00:00.000Z"]]);
		} finally { await core.close(); database.close(); }
	});

	it("loads notes and complete provenance for a busy day through the IPC contract", async () => {
		const { core, database, send } = setup();
		try {
			const at = "2026-09-16T15:00:00.000Z";
			const note = await send({ type: "memory-document-save", document: { kind: "memory", title: "Busy day", text: "Keep the useful note available." } });
			if (!note.ok || !note.memoryDocument) throw new Error("Document missing");
			for (let index = 0; index <= 2_000; index += 1) {
				const suffix = String(index).padStart(4, "0");
				database.upsertTimelineEvent({
					id: `busy-event-${suffix}`, sourceId: `busy-source-${suffix}`, startedAt: at,
					source: "synthetic-test", eventType: "project_activity", actor: "user",
					projectIds: ["robotics"], personIds: [], entityIds: [],
					textSummary: `Synthetic activity ${suffix}`, structuredData: {}, importance: 0.5,
					sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "not_requested",
					status: "active", createdAt: at, updatedAt: at,
				});
			}
			const result = CoreResponseSchema.parse(await send({ type: "memory-workspace-read", query: { viewerId: "user", domainId: "robotics" } }));
			expect(result.ok).toBe(true);
			if (!result.ok || !result.memoryWorkspace) throw new Error("Workspace missing");
			const workspace = result.memoryWorkspace;
			const day = workspace.days[0]!;
			expect(day.eventCount).toBe(2_000);
			expect(day.events).toHaveLength(2_000);
			expect(day.sourceIds).toEqual(day.events.flatMap(event => [event.id, event.sourceId]));
			expect(day.sourceIds).toHaveLength(4_000);
			expect(workspace.truncated).toBe(true);
			expect(day.sourceIds).not.toContain("busy-event-2000");
			const notes = await send({ type: "memory-workspace-read", query: { viewerId: "user" } });
			expect(notes.ok && notes.memoryWorkspace?.documents.some(document => document.id === note.memoryDocument!.id)).toBe(true);
			const unrelated = core.runtime.createSession({ title: "Unrelated scope", kind: "agent" });
			const identity = core.memorySubstrate.ensureAgentIdentity(unrelated);
			const scoped = await send({ type: "memory-workspace-read", query: { viewerId: identity.id } });
			expect(scoped.ok && scoped.memoryWorkspace?.days).toEqual([]);
			expect(MemoryWorkspaceSchema.safeParse({ ...workspace, days: [{ ...day, sourceIds: [...day.sourceIds, "overflow"] }] }).success).toBe(false);
			expect(MemoryDocumentSaveSchema.safeParse({ kind: "memory", title: "Bounded note", text: "Context", sourceIds: day.sourceIds.slice(0, 501) }).success).toBe(false);
		} finally { await core.close(); database.close(); }
	});

	it("reviews and applies an exact cleanup through the human contract without a model cleanup tool", async () => {
		const { core, database, send } = setup();
		try {
			const session = core.runtime.ensureMainSession();
			const identity = core.memorySubstrate.ensureAgentIdentity(session);
			const record = AgentMemoryRecordSchema.parse({ id: "owned-cleanup-ipc", agentId: identity.id, kind: "outcome", horizon: "mid_term", content: "Owned cleanup contract fixture", sourceIds: ["synthetic:cleanup"], taskIds: [], projectIds: [], personIds: [], entityIds: [], confidence: .6, importance: .5, sensitivity: "personal", status: "active", pinned: false, accessCount: 0, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", fadesAt: "2025-03-01T00:00:00.000Z" });
			database.upsertAgentMemory(record);
			const review = await send({ type: "memory-fade-plan" });
			if (!review.ok || !review.memoryFadePreview) throw new Error("Cleanup preview missing");
			expect(review.memoryFadePreview.candidates).toEqual([{ id: record.id, kind: "agent", content: record.content }]);
			expect(database.getAgentMemory(record.id)).toEqual(record);
			const names = [...core.runtime.discoverTools(session.id), ...core.runtime.discoverDeferredTools()].map(tool => tool.name);
			expect(names.some(name => /memory[.-]fade/u.test(name))).toBe(false);
			const applied = await send({ type: "memory-fade-apply", planId: review.memoryFadePreview.plan.id, approved: true });
			expect(applied.ok && applied.memoryFadeDryRun?.applied).toBe(true);
			expect(database.getAgentMemory(record.id)).toBeUndefined();
			const replay = await send({ type: "memory-fade-apply", planId: review.memoryFadePreview.plan.id, approved: true });
			expect(replay.ok).toBe(false);
		} finally { await core.close(); database.close(); }
	});
	it("persists, corrects, and forgets a person through the real IPC contract", async () => {
		const { core, database, send } = setup();
		try {
			const saved = await send({ type: "memory-document-save", document: { kind: "person", title: "Test teammate", text: "A robotics collaborator. We communicate directly.", domainIds: ["robotics"] } });
			expect(saved.ok).toBe(true);
			if (!saved.ok || !saved.memoryDocument) throw new Error("Document missing");
			const document = saved.memoryDocument;
			const read = await send({ type: "memory-workspace-read", query: { viewerId: "user", domainId: "robotics" } });
			expect(read.ok && read.memoryWorkspace?.documents.some(item => item.id === document.id)).toBe(true);
			const changed = await send({ type: "memory-document-save", document: { ...document, text: "A robotics collaborator focused on mechanical design.", passages: [], expectedVersion: document.version } });
			expect(changed.ok).toBe(true);
			const stale = await send({ type: "memory-document-save", document: { ...document, text: "Stale overwrite", passages: [], expectedVersion: document.version } });
			expect(stale.ok).toBe(false);
			await send({ type: "memory-document-forget", id: document.id });
			expect(core.memoryWorkspace.search({ query: "Test teammate robotics" })).toEqual([]);
		} finally { await core.close(); database.close(); }
	});

	it("forgets the same canonical document returned by the agent list tool", async () => {
		const { core, database, send } = setup();
		try {
			const saved = await send({ type: "memory-document-save", document: { kind: "memory", title: "Temporary context", text: "Review the chassis constraints." } });
			if (!saved.ok || !saved.memoryDocument) throw new Error("Document missing");
			const session = core.runtime.ensureMainSession();
			const listed = await core.runtime.callTool(session.id, "memory.list", {}, { approvalStatus: "approved" });
			expect(JSON.stringify(listed.output)).toContain(saved.memoryDocument.id);
			const forgotten = await core.runtime.callTool(session.id, "memory.forget", { id: saved.memoryDocument.id }, { approvalStatus: "approved", idempotencyKey: "forget-document" });
			expect(forgotten.status).toBe("verified");
			expect(core.memoryWorkspace.read().documents.some(document => document.id === saved.memoryDocument!.id)).toBe(false);
		} finally { await core.close(); database.close(); }
	});

	it("injects relevant person text in a real agent request without unrelated life memory", async () => {
		let received = "";
		const provider: ModelProvider = { id: "memory-proof", defaultModel: "memory-proof", capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: true },
			complete: async request => {
				received = JSON.stringify(request.messages);
				return { providerId: "memory-proof", model: request.model, text: "Draft prepared.", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };
			} };
		const { core, database, send } = setup(provider);
		try {
			await send({ type: "memory-document-save", document: { kind: "person", title: "Avery", text: "Avery is a robotics teammate. Messages are casual and direct.", domainIds: ["robotics"] } });
			await send({ type: "memory-document-save", document: { kind: "memory", title: "Orchard", text: "The unrelated orchard has a blue gate.", domainIds: ["gardening"] } });
			const session = core.runtime.ensureMainSession();
			const result = await send({ type: "runtime-run-agent", sessionId: session.id, model: "memory-proof", providerIds: ["memory-proof"], message: "Draft a message to Avery about robotics changes." });
			expect(result.ok).toBe(true);
			expect(received).toContain("casual and direct");
			expect(received).not.toContain("blue gate");
			await send({ type: "memory-document-save", document: { kind: "person", title: "Morgan", text: "Morgan reviews robotics assemblies with concise technical feedback.", domainIds: ["robotics"], sharing: "domain_shared" } });
			const parent = core.runtime.createSession({ title: "Robotics", kind: "agent", projectId: "robotics" });
			core.memorySubstrate.ensureAgentIdentity(parent);
			const delegated = await core.orchestrator.delegate({ parentSessionId: parent.id, title: "CAD", prompt: "Draft an update to Morgan about robotics assemblies.", model: "memory-proof", providerIds: ["memory-proof"], allowedTools: [] });
			expect(delegated.result.run.status).toBe("completed");
			expect(received).toContain("concise technical feedback");
			expect(received).not.toContain("blue gate");
		} finally { await core.close(); database.close(); }
	});
});
