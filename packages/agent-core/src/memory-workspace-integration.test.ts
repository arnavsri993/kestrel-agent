import { tmpdir } from "node:os";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { CoreRequestSchema, CoreResponseSchema, MemoryDocumentSaveSchema, MemoryWorkspaceSchema } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { AgentCore, type ModelProvider } from "./index";

function setup(provider?: ModelProvider) {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const core = new AgentCore({ database, workspaceRoots: [tmpdir()], projects: [{ id: "robotics", name: "Robotics", path: tmpdir(), order: 0, createdAt: "2026-09-16T15:00:00.000Z", updatedAt: "2026-09-16T15:00:00.000Z" }], ...(provider ? { modelProviders: [provider] } : {}), now: () => "2026-09-16T15:00:00.000Z" });
	return { core, database, send: (input: unknown) => core.handle(CoreRequestSchema.parse(input)) };
}

describe("memory workspace integration", () => {
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
