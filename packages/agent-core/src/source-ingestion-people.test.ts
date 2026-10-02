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
it.each(["active", "archived"] as const)("preserves confirmed person details and %s status across source imports", async status => {
 const f = fixture();
 try {
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "person-first", observations: [message] });
  const event = f.core.sourceIngestion.page(f.base).events[0]!;
  const personId = event.personIds[0]!;
  const confirmed = f.core.lifeContext.upsertPerson({ id: personId, agentId: event.agentId!, displayName: "Confirmed teammate",
   relationship: "Teammate", organization: "Synthetic robotics club", role: "Designer", timeZone: "America/Chicago",
   nicknames: ["CAD teammate"], tone: "friendly", sourceId: "user-confirmation", sensitivity: "restricted" });
  f.database.upsertPerson({ ...confirmed, status });
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "person-next", observations: [{ ...message, providerMessageId: "message-new", senderName: "Untrusted alias", occurredAt: "2026-09-11T20:00:00.000Z" }] });
  const updated = f.database.getPerson(personId)!;
  const { sourceIds: _sourceIds, updatedAt: _updatedAt, ...details } = confirmed;
  expect(updated).toMatchObject({ ...details, status, lastInteractionAt: "2026-09-11T20:00:00.000Z" });
  expect(updated.sourceIds).toContain("user-confirmation");
  await f.core.sourceIngestion.ingest({ ...f.base, captureId: "person-history", observations: [{ ...message, providerMessageId: "message-old", occurredAt: "2026-09-09T20:00:00.000Z" }] });
  expect(f.database.getPerson(personId)?.lastInteractionAt).toBe("2026-09-11T20:00:00.000Z");
  const historicalEvent = f.core.sourceIngestion.page(f.base).events.find(item => (item.structuredData.observation as SourceObservation).providerMessageId === "message-old")!;
  expect(f.database.getPerson(personId)?.sourceIds).toEqual(["user-confirmation", event.id, historicalEvent.id]);
  for (const providerMessageId of ["message-a", "message-new", "message-old"]) {
   await f.core.sourceIngestion.ingest({ ...f.base, captureId: `person-remove-${providerMessageId}`, observations: [{ ...message, providerMessageId, state: providerMessageId === "message-old" ? "expired" : "deleted" }] });
  }
  expect(f.database.getPerson(personId)).toMatchObject({ ...details, status, sourceIds: ["user-confirmation"] });
  expect(f.core.sourceIngestion.page(f.base).events.every(item => ["deleted", "expired"].includes((item.structuredData.observation as SourceObservation).state))).toBe(true);
  expect(JSON.stringify(f.core.sourceIngestion.page(f.base))).not.toContain(message.text);
 } finally { await f.core.close(); }
});
