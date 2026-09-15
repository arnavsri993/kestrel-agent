import { expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentMemoryRecordSchema } from "@kestrel/shared-types";
import { AgentCore } from "./index";
import { AgentMemoryRecovery } from "./memory-recovery";

it("previews encrypted same-scope knowledge recovery and never overwrites conflicts", async () => {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const core = new AgentCore({ database, seedDevelopmentFixtures: false });
	try {
		const session = core.runtime.createSession({ title: "Robotics", kind: "agent" });
		const agentId = core.memorySubstrate.ensureAgentIdentity(session).id;
		const now = new Date().toISOString();
		const record = AgentMemoryRecordSchema.parse({ id: "recoverable", agentId, kind: "procedure", horizon: "long_term", content: "Synthetic retained knowledge", sourceIds: ["explicit-fixture"], taskIds: [], projectIds: [], confidence: 0, importance: 0, sensitivity: "personal", status: "active", createdAt: now, updatedAt: now });
		database.upsertAgentMemory(record);
		database.upsertAgentMemory({ ...record, id: "restricted", sensitivity: "restricted", content: "Private account fixture" });
		database.upsertAgentMemory({ ...record, id: "source-derived", sourceIds: ["observation-fixture"], content: "Expiring source fixture" });
		database.upsertAgentMemory({ ...record, id: "task-derived", taskIds: ["task-fixture"], content: "Derived task output" });
		database.setPrivateState("credential-fixture", "Do not export account fixture");
		const encoded = core.memoryRecovery.export(session.id);
		expect(encoded).not.toContain(record.content);
		const decoded = database.readAgentKnowledgeBackup(encoded, agentId);
		expect(decoded).toEqual([record]);
		const unchanged = core.memoryRecovery.preview(session.id, encoded);
		expect(unchanged).toMatchObject({ newRecords: 0, existingRecords: 1 });
		expect(core.memoryRecovery.apply(session.id, unchanged.planId)).toBe(0);
		database.deleteAgentMemory(record.id);
		const preview = core.memoryRecovery.preview(session.id, encoded);
		expect(preview).toMatchObject({ newRecords: 1, existingRecords: 0 });
		expect(database.getAgentMemory(record.id)).toBeUndefined();
		expect(core.memoryRecovery.apply(session.id, preview.planId)).toBe(1);
		expect(database.getAgentMemory(record.id)).toEqual(record);
		expect(() => core.memoryRecovery.apply(session.id, preview.planId)).toThrow(/expired/);
		const conflict = core.memoryRecovery.preview(session.id, encoded);
		database.upsertAgentMemory({ ...record, content: "Newer correction" });
		expect(() => core.memoryRecovery.apply(session.id, conflict.planId)).toThrow(/changed after/);
		expect(database.getAgentMemory(record.id)?.content).toBe("Newer correction");
		const other = core.runtime.createSession({ title: "School", kind: "agent" });
		expect(() => core.memoryRecovery.preview(other.id, encoded)).toThrow(/another profile or scope/);
		expect(() => core.memoryRecovery.apply(other.id, conflict.planId)).toThrow(/another scope/);
		const envelope = JSON.parse(encoded); envelope.authTag = Buffer.alloc(16).toString("base64");
		expect(() => core.memoryRecovery.preview(session.id, JSON.stringify(envelope))).toThrow(/damaged/);
		const differentProfile = new KestrelDatabase(":memory:", createEncryptionKey());
		try { expect(() => differentProfile.readAgentKnowledgeBackup(encoded, agentId)).toThrow(/another profile/); } finally { differentProfile.close(); }
	} finally { await core.close(); }
});

it("expires preview authority and fails atomically if any destination changes", async () => {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const core = new AgentCore({ database, seedDevelopmentFixtures: false });
	try {
		const session = core.runtime.createSession({ title: "Recovery fixture", kind: "agent" });
		let time = Date.now();
		const recovery = new AgentMemoryRecovery(database, core.memorySubstrate, () => time);
		const agentId = core.memorySubstrate.ensureAgentIdentity(session).id;
		const timestamp = new Date(time).toISOString();
		const base = AgentMemoryRecordSchema.parse({ id: "first", agentId, kind: "fact", horizon: "long_term", content: "Fixture fact", sourceIds: ["fixture"], taskIds: [], projectIds: [], confidence: 0, importance: 0, sensitivity: "personal", status: "active", createdAt: timestamp, updatedAt: timestamp });
		database.upsertAgentMemory(base); database.upsertAgentMemory({ ...base, id: "second" });
		const backup = recovery.export(session.id);
		database.deleteAgentMemory("first"); database.deleteAgentMemory("second");
		const preview = recovery.preview(session.id, backup);
		database.upsertAgentMemory({ ...base, id: "second", content: "Changed after preview" });
		expect(() => recovery.apply(session.id, preview.planId)).toThrow(/changed after/);
		expect(database.getAgentMemory("first")).toBeUndefined();
		const refreshed = recovery.preview(session.id, backup);
		time += 10 * 60_000;
		expect(() => recovery.apply(session.id, refreshed.planId)).toThrow(/expired/);
		const afterRestart = new AgentMemoryRecovery(database, core.memorySubstrate, () => time);
		expect(() => afterRestart.apply(session.id, refreshed.planId)).toThrow(/expired/);
	} finally { await core.close(); }
});
