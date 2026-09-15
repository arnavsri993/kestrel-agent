import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { ROBOTICS_AGENT_TEMPLATE, AgentMemoryRecordSchema, WorkingTaskSchema } from "@kestrel/shared-types";
import { expect, it } from "vitest";
import { AgentCore } from "./index";

it("creates a template through IPC and preserves specialist definitions, identity and memory after restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "kestrel-persistent-agents-"));
	const key = createEncryptionKey();
	const path = join(root, "state.sqlite");
	let core = new AgentCore({ database: new KestrelDatabase(path, key), seedDevelopmentFixtures: false });
	try {
		const result = await core.handle({ type: "runtime-create-session", kind: "agent", title: "Robotics", agentTemplate: ROBOTICS_AGENT_TEMPLATE });
		if (!result.ok || !result.session) throw new Error("Template creation failed");
		const parentId = result.session.id;
		const specialists = core.runtime.listSessions().filter(item => item.parentSessionId === parentId);
		expect(specialists).toHaveLength(8);
		const specialist = specialists[0]!;
		const identity = core.memorySubstrate.ensureAgentIdentity(specialist);
		const memory = core.memorySubstrate.rememberForSession(specialist.id, {
			type: "semantic", content: "A reported commitment is not completed work.", structuredData: {},
			sourceIds: ["synthetic-observation"], sourceType: "test", confidence: 1, importance: 0.7,
			sensitivity: "personal", entityIds: [], userConfirmed: true, inferred: false,
		});
		const edited = await core.handle({ type: "runtime-configure-agent", sessionId: specialist.id,
			title: "Renamed specialist", instructions: "Report evidence and uncertainty.",
			specialistDefinition: { ...specialist.specialistDefinition!, enabled: false, archived: true } });
		expect(edited.ok).toBe(true);
		await core.close();
		core = new AgentCore({ database: new KestrelDatabase(path, key), seedDevelopmentFixtures: false });
		const reloaded = core.runtime.getSession(specialist.id);
		expect(reloaded.title).toBe("Renamed specialist");
		expect(reloaded.specialistDefinition?.enabled).toBe(false);
		expect(reloaded.specialistDefinition?.archived).toBe(true);
		expect(core.memorySubstrate.ensureAgentIdentity(reloaded).id).toBe(identity.id);
		expect(core.memorySubstrate.listForSession(reloaded.id)).toContainEqual(memory);
		expect(core.runtime.listSessions().filter(item => item.parentSessionId === parentId)).toHaveLength(8);
		expect(core.runtime.listMessages(specialist.id)).toEqual([]);
		const invalid = await core.handle({ type: "runtime-configure-agent", sessionId: specialist.id, title: reloaded.title, instructions: "",
			specialistDefinition: { ...reloaded.specialistDefinition!, enabled: true } });
		expect(invalid.ok).toBe(false);
		const restored = await core.handle({ type: "runtime-configure-agent", sessionId: specialist.id, title: reloaded.title, instructions: "",
			specialistDefinition: { ...reloaded.specialistDefinition!, archived: false, enabled: false } });
		expect(restored.ok).toBe(true);
		expect(core.memorySubstrate.listForSession(specialist.id)).toContainEqual(memory);
	} finally {
		await core.close(); rmSync(root, { recursive: true, force: true });
	}
});

it("pages scoped knowledge and combined specialist work beyond the first page", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const core = new AgentCore({ database, seedDevelopmentFixtures: false });
 try {
  const parent = core.runtime.createSession({ title: "Robotics", kind: "agent" });
  const specialist = core.runtime.createSession({ title: "Code", kind: "subagent", parentSessionId: parent.id, specialistDefinition: ROBOTICS_AGENT_TEMPLATE.specialists[0]! });
  const school = core.runtime.createSession({ title: "School", kind: "agent" });
  const agentId = core.memorySubstrate.ensureAgentIdentity(parent).id;
  const specialistId = core.memorySubstrate.ensureAgentIdentity(specialist).id;
  const now = "2026-09-14T18:00:00.000Z";
  for (let index = 0; index < 205; index++) database.upsertAgentMemory(AgentMemoryRecordSchema.parse({
   id: `page-memory-${String(index).padStart(3, "0")}`, agentId, kind: "fact", horizon: "long_term", content: `Synthetic knowledge ${index}`, sourceIds: ["fixture"], taskIds: [], projectIds: [], confidence: 0, importance: 0, sensitivity: "personal", status: "active", createdAt: now, updatedAt: now,
  }));
  for (let index = 0; index < 120; index++) database.upsertWorkingTask(WorkingTaskSchema.parse({
   id: `page-task-${String(index).padStart(3, "0")}`, sessionId: index % 2 ? specialist.id : parent.id, agentId: index % 2 ? specialistId : agentId,
   goal: `Synthetic task ${index}`, plan: [], status: "completed", evidence: [], artifacts: [], failures: [], unresolvedQuestions: [], subtaskIds: [], startedAt: now, createdAt: now, updatedAt: now,
  }));
  const request = { type: "memory-agent-inspect" as const, sessionId: parent.id, includeInactive: false, includeSpecialists: true, limit: 200 };
  const first = await core.handle(request);
  if (!first.ok) throw new Error(first.error);
  expect(first.memoryAgentMemories).toHaveLength(200); expect(first.memoryAgentTasks).toHaveLength(100);
  expect(first.memoryNextOffset).toBe(200); expect(first.taskNextOffset).toBe(100);
  const second = await core.handle({ ...request, memoryOffset: 200, taskOffset: 100 });
  if (!second.ok) throw new Error(second.error);
  expect(second.memoryAgentMemories).toHaveLength(5); expect(second.memoryAgentTasks).toHaveLength(20);
  expect(second.memoryNextOffset).toBeUndefined(); expect(second.taskNextOffset).toBeUndefined();
  expect(new Set([...first.memoryAgentTasks!, ...second.memoryAgentTasks!].map(task => task.id)).size).toBe(120);
  const other = await core.handle({ ...request, sessionId: school.id });
  expect(other.ok && other.memoryAgentMemories).toEqual([]); expect(other.ok && other.memoryAgentTasks).toEqual([]);
 } finally { await core.close(); }
});

it("keeps agent people and calendar entries out of personal and other agent scopes", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const core = new AgentCore({ database, seedDevelopmentFixtures: false });
 try {
  const first = core.runtime.createSession({ title: "Robotics", kind: "agent" });
  const second = core.runtime.createSession({ title: "School", kind: "agent" });
  const person = await core.handle({ type: "people-upsert", sessionId: first.id, displayName: "Rishi", role: "", nicknames: [], sourceId: "explicit-fixture", sensitivity: "personal" });
  expect(person.ok && person.people?.length).toBe(1);
  const personalPeople = await core.handle({ type: "people-list" });
  const otherPeople = await core.handle({ type: "people-list", sessionId: second.id });
  expect(personalPeople.ok && personalPeople.people).toEqual([]);
  expect(otherPeople.ok && otherPeople.people).toEqual([]);
  const event = await core.handle({ type: "calendar-create-local", sessionId: first.id, title: "Proposed robotics meeting", startsAt: "2026-09-20T20:00:00.000Z", endsAt: "2026-09-20T21:00:00.000Z", origin: "suggested", confidence: 0, sourceId: "explicit-fixture" });
  expect(event.ok && event.calendarEvents?.[0]?.status).toBe("suggested");
  const range = { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-10-01T00:00:00.000Z" };
  const personal = await core.handle({ type: "calendar-list", ...range });
  const other = await core.handle({ type: "calendar-list", sessionId: second.id, ...range });
  expect(personal.ok && personal.calendarEvents).toEqual([]);
  expect(other.ok && other.calendarEvents).toEqual([]);
  expect(core.memory.list()).toEqual([]);
  const ownContext = await core.runtime.callTool(first.id, "agent.life.read", range);
  expect(JSON.stringify(ownContext)).toContain("Proposed robotics meeting");
  expect(JSON.stringify(ownContext)).toContain("suggested");
  const otherContext = await core.runtime.callTool(second.id, "agent.life.read", range);
  expect(JSON.stringify(otherContext)).not.toContain("Proposed robotics meeting");
  expect(JSON.stringify(otherContext)).not.toContain("Rishi");
  if (!event.ok || !event.calendarEvents?.[0]) throw new Error("Fixture event missing");
  const wrongDelete = await core.handle({ type: "calendar-delete-local", sessionId: second.id, id: event.calendarEvents[0].id });
  expect(wrongDelete.ok).toBe(false);
 } finally { await core.close(); }
});
