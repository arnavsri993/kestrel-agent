import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import type { AgentMemoryRecord } from "@kestrel/shared-types";
import type { MemorySubstrate } from "./memory-substrate";

/** User-only recovery plans are bounded, ephemeral, and invalid after restart. */
export class AgentMemoryRecovery {
	private readonly plans = new Map<string, { sessionId: string; expires: number; records: AgentMemoryRecord[]; expected: Array<string | null> }>();
	constructor(private readonly database: KestrelDatabase, private readonly memory: MemorySubstrate, private readonly now = () => Date.now()) {}
	export(sessionId: string): string {
		const identity = this.memory.ensureAgentIdentity(this.memory.assertMemorySession(sessionId));
		return this.database.exportAgentKnowledge(identity.id);
	}
	preview(sessionId: string, encoded: string) {
		const identity = this.memory.ensureAgentIdentity(this.memory.assertMemorySession(sessionId));
		const records = this.database.readAgentKnowledgeBackup(encoded, identity.id);
		const expected = records.map(record => { const existing = this.database.getAgentMemory(record.id); return existing ? JSON.stringify(existing) : null; });
		for (const [key, plan] of this.plans) if (plan.expires <= this.now() || plan.sessionId === sessionId) this.plans.delete(key);
		if (this.plans.size >= 4) throw new Error("Close another recovery preview before opening a new one.");
		const planId = randomUUID(); const expires = this.now() + 10 * 60_000;
		this.plans.set(planId, { sessionId, expires, records, expected });
		return { planId, scopeName: identity.name, newRecords: expected.filter(value => value === null).length, existingRecords: expected.filter(value => value !== null).length, expiresAt: new Date(expires).toISOString() };
	}
	apply(sessionId: string, planId: string): number {
		const identity = this.memory.ensureAgentIdentity(this.memory.assertMemorySession(sessionId));
		const plan = this.plans.get(planId);
		if (!plan || plan.sessionId !== sessionId || plan.expires <= this.now() || plan.records.some(record => record.agentId !== identity.id)) throw new Error("Recovery preview expired or belongs to another scope. Preview the file again.");
		const restored = this.database.restoreAgentKnowledge(plan.records, plan.expected);
		this.plans.delete(planId);
		return restored;
	}
}
