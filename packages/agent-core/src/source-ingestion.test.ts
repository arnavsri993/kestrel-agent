import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { SourceObservation, SourceSelection } from "@kestrel/shared-types";
import { expect, it } from "vitest";
import { AgentCore } from "./index";

function fixture(database = new KestrelDatabase(":memory:", createEncryptionKey())) {
 const core = new AgentCore({ database, seedDevelopmentFixtures: false });
 const parent = core.runtime.createSession({ title: "Robotics fixture", kind: "agent" });
 const selection: SourceSelection = { sessionId: parent.id, connectionId: "fixture", resourceId: "selected-team", label: "Synthetic team conversation", processingConsent: true, modelProcessingConsent: false, privacy: "permitted", status: "ready", coverage: "unknown", updatedAt: new Date().toISOString() };
 core.runtime.setResourceGrants(parent.id, [{ connectionId: selection.connectionId, resourceId: selection.resourceId, capability: "read" }]);
 core.sourceIngestion.select(selection);
 const base = { sessionId: parent.id, connectionId: selection.connectionId, resourceId: selection.resourceId };
 return { core, database, parent, selection, base };
}
const message: SourceObservation = { providerMessageId: "message-a", senderId: "source-rishi", senderName: "Rishi", occurredAt: "2026-09-10T20:00:00.000Z", originalTimestamp: "9/10/2026 3:00 PM", timezone: "America/Chicago", text: "I will finish the CAD tonight", state: "observed", attachments: [] };
it.each(["expired", "delete-source"] as const)("removes transitive and mixed-source knowledge on %s", async mode => {
 const f = fixture();
 try {
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "derived", observations: [message] });
  const event = f.core.sourceIngestion.page(f.base).events[0]!;
  const base = { agentId: event.agentId!, kind: "fact" as const, horizon: "mid_term" as const, content: "Synthetic derived source content", taskIds: [], projectIds: [], personIds: [], entityIds: [], confidence: 0, importance: 0, sensitivity: "sensitive" as const, status: "active" as const, createdAt: event.createdAt, updatedAt: event.createdAt };
  f.database.upsertAgentMemory({ ...base, id: "derived-first", sourceIds: [event.id, "unrelated-evidence"] });
  f.database.upsertAgentMemory({ ...base, id: "derived-second", sourceIds: ["memory:derived-first"], status: "superseded" });
  f.database.upsertAgentMemory({ ...base, id: "derived-third", sourceIds: ["agent_memory:derived-second", "derived-third"] });
  f.database.upsertAgentMemory({ ...base, id: "unrelated", sourceIds: ["unrelated-evidence"] });
  const review = f.core.sourceIngestion.queueReview(f.parent.id, event.id);
  f.database.upsertWorkingTask({ ...review, status: "completed", outcomeSummary: "Sensitive source-derived result", sourceIds: [event.id, "other-evidence"] });
  f.database.upsertWorkingTask({ ...review, id: "indirect-task", status: "completed", sourceIds: ["task:" + review.id], outcomeSummary: "Indirect source-derived result" });
  f.database.upsertWorkingTask({ ...review, id: "unrelated-task", sourceIds: ["other-evidence"] });
  f.database.upsertAgentMemory({ ...base, id: "task-derived-memory", sourceIds: ["other-evidence"], taskIds: ["indirect-task"] });
  if (mode === "expired") await f.core.sourceIngestion.ingest({ ...f.base, captureId: "expire-derived", observations: [{ ...message, state: "expired" }] });
  else expect(f.database.deleteMemoryArtifactsForSource(event.sourceSessionId!).agentMemories).toBe(4);
  for (const id of ["derived-first", "derived-second", "derived-third", "task-derived-memory"]) expect(f.database.getAgentMemory(id)).toBeUndefined();
  expect(f.database.getAgentMemory("unrelated")).toBeDefined();
  expect(f.database.getWorkingTask(review.id)).toBeUndefined();
  expect(f.database.getWorkingTask("indirect-task")).toBeUndefined();
  expect(f.database.getWorkingTask("unrelated-task")).toBeDefined();
  expect(() => f.database.upsertWorkingTask({ ...review, status: "completed", outcomeSummary: "Late private result" })).toThrow("stale result");
  expect(() => f.database.upsertAgentMemory({ ...base, id: "task-derived-memory", sourceIds: ["other-evidence"] })).toThrow("stale result");
  expect(f.database.getWorkingTask(review.id)).toBeUndefined();
 } finally { await f.core.close(); }
});
it("queues one durable review per observation without copying untrusted content or granting execution", async () => {
 const f = fixture();
 try {
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "review", observations: [message] });
  const event = f.core.sourceIngestion.page(f.base).events[0]!;
  const response = await f.core.handle({ type: "source-queue-review", sessionId: f.parent.id, observationId: event.id });
  expect(response.ok).toBe(true);
  const task = f.core.sourceIngestion.queueReview(f.parent.id, event.id);
  expect(response.ok && response.memoryAgentTasks?.[0]?.id).toBe(task.id);
  expect(task.status).toBe("planned");
  expect(task.sourceIds).toEqual([event.id]);
  expect(JSON.stringify(task)).not.toContain(message.text);
  expect(f.database.getWorkingTask(task.id)?.id).toBe(task.id);
  const other = f.core.runtime.createSession({ title: "School", kind: "agent" });
  expect(() => f.core.sourceIngestion.queueReview(other.id, event.id)).toThrow("unavailable in this scope");
  f.core.runtime.setResourceGrants(f.parent.id, []);
  expect(() => f.core.sourceIngestion.queueReview(f.parent.id, event.id)).toThrow("revoked");
  f.core.runtime.setResourceGrants(f.parent.id, [{ connectionId: f.selection.connectionId, resourceId: f.selection.resourceId, capability: "read" }]);
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "deleted-review", observations: [{ ...message, state: "deleted" }] });
  expect(() => f.core.sourceIngestion.queueReview(f.parent.id, event.id)).toThrow("unavailable");
  expect(f.database.getWorkingTask(task.id)?.status).toBe("cancelled");
  expect(f.database.getWorkingTask(task.id)?.sourceIds).toEqual([]);
 } finally { await f.core.close(); }
});
it("rejects child imports and malformed captures before storing source data", async () => {
 const f = fixture();
 try {
  const child = f.core.runtime.createSession({ title: "Code", kind: "subagent", parentSessionId: f.parent.id });
  f.core.runtime.setResourceGrants(child.id, f.core.runtime.getResourceGrants(f.parent.id));
  await expect(f.core.sourceIngestion.ingest({ ...f.base, sessionId: child.id, captureId: "child", observations: [message] })).rejects.toThrow("parent agent scope");
  await expect(f.core.sourceIngestion.ingest({ ...f.base, captureId: "malformed", observations: [message, { ...message, occurredAt: "invalid" }] })).rejects.toThrow();
  expect(f.core.sourceIngestion.page(f.base).events).toEqual([]);
  expect(f.core.sourceIngestion.selections(f.parent.id)[0]?.checkpoint).toBeUndefined();
 } finally { await f.core.close(); }
});
it("retains queued source review identity across restart", async () => {
 const root = mkdtempSync(join(tmpdir(), "kestrel-source-review-"));
 const key = createEncryptionKey(); const path = join(root, "fixture.sqlite");
 const f = fixture(new KestrelDatabase(path, key));
 let closed = false;
 try {
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "restart", observations: [message] });
  const event = f.core.sourceIngestion.page(f.base).events[0]!;
  const task = f.core.sourceIngestion.queueReview(f.parent.id, event.id);
  await f.core.close(); closed = true;
  const reopenedDatabase = new KestrelDatabase(path, key);
  const reopened = new AgentCore({ database: reopenedDatabase, seedDevelopmentFixtures: false });
  try {
   const retained = reopened.sourceIngestion.queueReview(f.parent.id, event.id);
   expect(retained.id).toBe(task.id); expect(retained.status).toBe("planned");
   reopenedDatabase.upsertWorkingTask({ ...retained, status: "running" });
   reopenedDatabase.deleteTimelineEvent(event.id);
  } finally { await reopened.close(); }
  const afterDeletion = new KestrelDatabase(path, key);
  try {
   expect(afterDeletion.getWorkingTask(task.id)).toBeUndefined();
   expect(() => afterDeletion.upsertWorkingTask({ ...task, status: "completed", outcomeSummary: "Late result after restart" })).toThrow("stale result");
  } finally { afterDeletion.close(); }
 } finally { if (!closed) await f.core.close(); rmSync(root, { recursive: true, force: true }); }
});
it("preserves dates, uncertain identical messages, idempotency, revisions, consent and privacy deletion", async () => {
 const f = fixture();
 try {
  const observations = [message, { ...message, providerMessageId: "message-b" }];
  expect((await f.core.sourceIngestion.ingest({ ...f.base, captureId: "first", observations })).inserted).toBe(2);
  expect((await f.core.sourceIngestion.ingest({ ...f.base, captureId: "second", observations })).repeated).toBe(2);
  let page = f.core.sourceIngestion.page(f.base);
  expect(page.events).toHaveLength(2);
  expect(page.events[0]?.startedAt).toBe(message.occurredAt);
  expect(page.events[0]?.structuredData.claimStatus).toBe("reported");
  expect(page.events[0]?.structuredData.senderEvidence).toBe("observed_sender_not_roster");
  expect(f.core.sourceIngestion.page({ ...f.base, observationId: page.events[0]!.id }).events).toHaveLength(1);
  expect(() => f.core.sourceIngestion.page({ ...f.base, observationId: "missing" })).toThrow("unavailable");
  await expect(f.core.runtime.callTool(f.parent.id, "sources.read", f.base)).rejects.toThrow("Model processing");
  f.core.sourceIngestion.select({ ...f.selection, modelProcessingConsent: true });
  expect((await f.core.runtime.callTool(f.parent.id, "sources.read", f.base)).status).toBe("verified");
  const exact = await f.core.runtime.callTool(f.parent.id, "sources.read", { ...f.base, observationId: page.events[0]!.id });
  expect(exact.status).toBe("verified");
  expect((exact.output as { events: unknown[] }).events).toHaveLength(1);
  const { providerMessageId: _id, ...uncertain } = message;
  expect((await f.core.sourceIngestion.ingest({ ...f.base, captureId: "uncertain", observations: [uncertain, uncertain] })).inserted).toBe(2);
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "edit", observations: [{ ...message, state: "edited", text: "CAD is delayed" }] });
  page = f.core.sourceIngestion.page(f.base);
  expect(page.events).toHaveLength(5);
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "deleted", observations: [{ ...message, state: "deleted", text: "" }] });
  page = f.core.sourceIngestion.page(f.base);
  expect(page.events.filter(item => (item.structuredData.observation as SourceObservation).providerMessageId === message.providerMessageId)).toHaveLength(1);
  expect(JSON.stringify(page.events)).not.toContain("CAD is delayed");
  f.core.sourceIngestion.select({ ...f.selection, privacy: "blocked", status: "privacy_blocked" });
  await expect(f.core.sourceIngestion.ingest({ ...f.base, captureId: "blocked", observations: [message] })).rejects.toThrow("privacy-blocked");
 } finally { await f.core.close(); }
});

it("removes sender evidence with deleted source content and blocks replay", async () => {
 const f = fixture();
 try {
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "only", observations: [message] });
  const event = f.core.sourceIngestion.page(f.base).events[0]!;
  expect(f.database.getPerson(event.personIds[0]!)).toBeDefined();
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "erase", observations: [{ ...message, state: "deleted" }] });
  expect(f.database.getPerson(event.personIds[0]!)).toBeUndefined();
  expect(JSON.stringify(f.core.sourceIngestion.page(f.base))).not.toContain("Rishi");
  expect((await f.core.sourceIngestion.ingest({ ...f.base, captureId: "replay", observations: [message] })).repeated).toBe(1);
 } finally { await f.core.close(); }
});

it("keeps observed people while other source evidence remains", async () => {
 const f = fixture();
 try {
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "three", observations: [0, 1, 2].map(index => ({ ...message, providerMessageId: `retained-${index}` })) });
  const personId = f.core.sourceIngestion.page(f.base).events[0]!.personIds[0]!;
  for (const index of [0, 2]) await f.core.sourceIngestion.ingest({ ...f.base, captureId: `remove-${index}`, observations: [{ ...message, providerMessageId: `retained-${index}`, state: "deleted" }] });
  expect(f.database.getPerson(personId)).toBeDefined();
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "remove-last", observations: [{ ...message, providerMessageId: "retained-1", state: "expired" }] });
  expect(f.database.getPerson(personId)).toBeUndefined();
 } finally { await f.core.close(); }
});

it("measures 50,000 encrypted source records, indexed retrieval, pagination, cancellation and restart", async () => {
 const root = mkdtempSync(join(tmpdir(), "kestrel-source-scale-"));
 const key = createEncryptionKey();
 const path = join(root, "fixture.sqlite");
 const f = fixture(new KestrelDatabase(path, key));
 let closed = false;
 try {
  const started = performance.now();
  for (let batch = 0; batch < 250; batch++) {
   const observations = Array.from({ length: 200 }, (_, row) => {
    const index = batch * 200 + row;
    return { ...message, providerMessageId: `synthetic-${index}`, text: `Synthetic robotics observation ${index} ${index === 7 ? "uniquemechanismneedle" : "reported discussion"}`, occurredAt: new Date(Date.UTC(2026, 8, 1) + index * 1000).toISOString() };
   });
   await f.core.sourceIngestion.ingest({ ...f.base, captureId: `batch-${batch}`, observations });
  }
  const ingestionMs = performance.now() - started;
  const searchStart = performance.now();
  const found = f.core.sourceIngestion.page({ ...f.base, query: "uniquemechanismneedle", limit: 10 });
  const searchMs = performance.now() - searchStart;
  expect(found.events).toHaveLength(1);
  expect(found.events[0]?.textSummary).toContain("observation 7 ");
  const pageStart = performance.now();
  const page = f.core.sourceIngestion.page({ ...f.base, offset: 49_900, limit: 100 });
  const pageMs = performance.now() - pageStart;
  expect(page.events).toHaveLength(100); expect(page.nextOffset).toBeUndefined();
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  const cancellationStart = performance.now();
  const cancelled = await f.core.sourceIngestion.ingest({ ...f.base, captureId: "cancel-batch", observations: Array.from({ length: 200 }, (_, i) => ({ ...message, providerMessageId: `cancel-${i}` })), signal: controller.signal });
  const cancellationMs = performance.now() - cancellationStart;
  expect(cancelled.interrupted).toBe(true); expect(cancelled.inserted).toBeLessThan(200);
  await f.core.close(); closed = true;
  const reopened = new AgentCore({ database: new KestrelDatabase(path, key), seedDevelopmentFixtures: false });
  try {
   expect(reopened.sourceIngestion.page({ ...f.base, query: "uniquemechanismneedle" }).events).toHaveLength(1);
   expect(reopened.sourceIngestion.selections(f.parent.id)[0]?.coverage).toBe("interrupted");
  } finally { await reopened.close(); }
  const report = { fixture: "encrypted SQLite, synthetic only", records: 50_000, ingestionMs: Math.round(ingestionMs), indexedSearchMs: Math.round(searchMs), deepPageMs: Math.round(pageMs), cancellationMs: Math.round(cancellationMs), recordsBeforeCancellation: cancelled.inserted };
  if (process.env.KESTREL_SOURCE_BENCHMARK_REPORT) writeFileSync(process.env.KESTREL_SOURCE_BENCHMARK_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
 } finally { if (!closed) await f.core.close(); rmSync(root, { recursive: true, force: true }); }
// Keep the full dataset on shared CI runners, where encrypted disk writes compete
// with the rest of the suite. This is a correctness test, not a two-minute SLA.
}, 300_000);
