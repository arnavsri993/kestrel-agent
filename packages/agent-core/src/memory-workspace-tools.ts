import { z } from "zod";
import type { AgentRuntime, ExternalRuntimeTool } from "./runtime";
import type { MemorySubstrate } from "./memory-substrate";
import type { MemoryWorkspaceService } from "./memory-workspace";

/** The old tool names now read the same canonical documents as the Memory UI. */
export function installMemoryWorkspaceTools(runtime: AgentRuntime, workspace: MemoryWorkspaceService, substrate: MemorySubstrate, mainSessionId: string): void {
	const register = (name: string, title: string, readOnly: boolean, inputSchema: Record<string, unknown>, execute: ExternalRuntimeTool["execute"]) => {
		runtime.registerExternalTool({ descriptor: { name, title, description: title,
			category: "memory", riskLevel: "sensitive", readOnly, requiresWorkspace: false,
			source: "builtin", tags: ["memory", "provenance"] }, inputSchema, execute });
		runtime.allowTool(mainSessionId, name);
	};
	register("memory.search", "Retrieve relevant memory, people and learned tool context", true, {
		type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 10_000 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"], additionalProperties: false,
	}, async ({ session }, input) => {
		const { query, limit } = z.object({ query: z.string().min(1).max(10_000), limit: z.number().int().min(1).max(100).default(12) }).parse(input);
		substrate.assertMemorySession(session.id);
		return { memories: workspace.search({ query, sessionId: session.id }).slice(0, limit) };
	});
	register("memory.list", "Read this agent's visible memory documents", true, { type: "object", properties: {}, additionalProperties: false }, async ({ session }) => {
		substrate.assertMemorySession(session.id);
		const identity = substrate.ensureAgentIdentity(session);
		const viewerId = session.kind === "agent" || session.parentSessionId ? identity.id : "user";
		return { memories: workspace.read({ viewerId }).documents.filter(document => document.kind !== "knowledge").slice(0, 100) };
	});
	register("memory.forget", "Forget an owned memory document", false, {
		type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
	}, async ({ session }, input) => {
		const { id } = z.object({ id: z.string().min(1) }).parse(input);
		substrate.assertMemorySession(session.id);
		if (!id.startsWith("workspace:") && !id.startsWith("workspace-memory-")) return { memory: substrate.forgetForSession(session.id, id) };
		const identity = substrate.ensureAgentIdentity(session);
		const viewerId = session.kind === "agent" || session.parentSessionId ? identity.id : "user";
		const document = workspace.read({ viewerId }).documents.find(item => item.id === id);
		if (!document) throw new Error("Memory document is not visible to this agent.");
		return { memory: workspace.forget(id, viewerId, document.version) };
	});
	register("memory.document.update", "Consolidate an owned memory document using its existing evidence", false, {
		type: "object", properties: { id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 20_000 }, expectedVersion: { type: "integer", minimum: 1 } }, required: ["id", "text", "expectedVersion"], additionalProperties: false,
	}, async ({ session }, input) => {
		const parsed = z.object({ id: z.string().min(1), text: z.string().trim().min(1).max(20_000), expectedVersion: z.number().int().positive() }).parse(input);
		substrate.assertMemorySession(session.id);
		const identity = substrate.ensureAgentIdentity(session);
		const viewerId = session.kind === "agent" || session.parentSessionId ? identity.id : "user";
		const document = workspace.read({ viewerId }).documents.find(item => item.id === parsed.id);
		if (!document) throw new Error("Memory document is not visible to this agent.");
		if (document.passages.length > 1) throw new Error("Consolidate individual scoped passages in Memory; a combined document cannot be rewritten by an agent.");
		return { memory: workspace.save({ ...document, viewerId, expectedVersion: parsed.expectedVersion,
			text: parsed.text, passages: [], confirmation: "inferred", confidence: Math.min(document.confidence, 0.8) }) };
	});
}
