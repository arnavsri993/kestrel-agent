import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { expect, it, vi } from "vitest";
import { AgentCore } from "./index";

it("runs one consented bounded review and preserves the observation/task link", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 let calls = 0;
 let observationId = "";
 const core = new AgentCore({ database, seedDevelopmentFixtures: false, modelProviders: [{
  id: "review-fixture", capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: true },
  complete: async request => {
   calls++;
   expect(request.tools?.map(tool => tool.name)).toEqual(["sources.read"]);
   return { providerId: "review-fixture", model: request.model, text: calls === 1 ? "" : "Reported request: inspect CAD. Missing dimensions; no work executed.",
    toolCalls: calls === 1 ? [{ id: "read", name: "sources.read", arguments: { connectionId: "fixture", resourceId: "group", observationId } }] : [],
    usage: { inputTokens: 1, outputTokens: 1 }, finishReason: calls === 1 ? "tool_calls" : "stop" };
  }
 }] });
 try {
  const session = core.runtime.createSession({ title: "Review", kind: "agent", allowedTools: ["sources.read"] });
  core.runtime.setResourceGrants(session.id, [{ connectionId: "fixture", resourceId: "group", capability: "read" }]);
  const selection = { sessionId: session.id, connectionId: "fixture", resourceId: "group", label: "Fixture", processingConsent: true as const, modelProcessingConsent: false, privacy: "permitted" as const, status: "ready" as const, coverage: "unknown" as const, updatedAt: new Date().toISOString() };
  core.sourceIngestion.select(selection);
  await core.sourceIngestion.ingest({ ...selection, captureId: "review", observations: [{ providerMessageId: "one", occurredAt: new Date().toISOString(), text: "Inspect CAD", state: "observed", attachments: [] }] });
  observationId = core.sourceIngestion.page(selection).events[0]!.id;
  const request = { type: "source-run-review" as const, sessionId: session.id, observationId, model: "fixture", providerIds: ["review-fixture"] };
  expect(await core.handle(request)).toMatchObject({ ok: false }); expect(calls).toBe(0);
  core.sourceIngestion.select({ ...selection, modelProcessingConsent: true });
  const result = await core.handle(request);
  expect(result).toMatchObject({ ok: true, memoryAgentTasks: [{ status: "completed", sourceIds: [observationId] }] });
  expect(calls).toBe(2);
  expect(await core.handle(request)).toMatchObject({ ok: false }); expect(calls).toBe(2);
  database.deleteTimelineEvent(observationId);
  if (result.ok) expect(database.getWorkingTask(result.memoryAgentTasks![0]!.id)).toBeUndefined();
 } finally { await core.close(); }
});

it("stops a review without starting another run", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 let entered = false;
 const core = new AgentCore({ database, seedDevelopmentFixtures: false, modelProviders: [{ id: "stop-fixture", capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: true },
  complete: async (_request, options) => { entered = true; return await new Promise<never>((_resolve, reject) => { const stop = () => reject(new Error("Stopped fixture")); if (options?.signal?.aborted) stop(); else options?.signal?.addEventListener("abort", stop, { once: true }); }); }
 }] });
 try {
  const session = core.runtime.createSession({ title: "Stop review", kind: "agent", allowedTools: ["sources.read"] });
  const selection = { sessionId: session.id, connectionId: "fixture", resourceId: "group", label: "Fixture", processingConsent: true as const, modelProcessingConsent: true, privacy: "permitted" as const, status: "ready" as const, coverage: "unknown" as const, updatedAt: new Date().toISOString() };
  core.runtime.setResourceGrants(session.id, [{ connectionId: "fixture", resourceId: "group", capability: "read" }]); core.sourceIngestion.select(selection);
  await core.sourceIngestion.ingest({ ...selection, captureId: "stop", observations: [{ providerMessageId: "one", occurredAt: new Date().toISOString(), text: "Review this", state: "observed", attachments: [] }] });
  const observationId = core.sourceIngestion.page(selection).events[0]!.id;
  const request = { type: "source-run-review" as const, sessionId: session.id, observationId, model: "fixture", providerIds: ["stop-fixture"] };
  const pending = core.handle(request);
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(await core.handle(request)).toMatchObject({ ok: false });
  expect(await core.handle({ type: "source-stop-review", sessionId: session.id })).toMatchObject({ ok: true });
  await pending;
  expect(core.sourceIngestion.queueReview(session.id, observationId).status).toBe("cancelled");
 } finally { await core.close(); }
});
