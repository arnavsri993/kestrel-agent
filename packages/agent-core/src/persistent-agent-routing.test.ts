import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { expect, it, vi } from "vitest";
import { AgentCore } from "./index";
import { ModelCatalog } from "./providers/model-catalog";
import { ModelRegistry } from "./model-orchestration";
import type { ModelProvider, ModelRequest, ModelResult } from "./providers";

function provider(id: string, tools: boolean): ModelProvider {
 return {
  id, defaultModel: `${id}-model`,
  capabilities: { streaming: false, tools, images: false, audio: false, documents: false, local: true },
  complete: vi.fn(async (request: ModelRequest): Promise<ModelResult> => ({ providerId: id, model: request.model, text: "Ready.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" as const })),
 };
}

it("routes vague persistent-agent direction to a tool provider and executes a durable tool call", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const text = provider("text", false);
 const worker = provider("worker", true);
 worker.complete = vi.fn(async (request: ModelRequest): Promise<ModelResult> => {
  const hasResult = request.messages.some(message => message.role === "tool");
  return { providerId: worker.id, model: request.model, text: hasResult ? "Checked the available tools." : "",
   toolCalls: hasResult ? [] : [{ id: "check-tools", name: "tools.search", arguments: {} }],
   usage: { inputTokens: 1, outputTokens: 1 }, finishReason: hasResult ? "stop" : "tool_calls" };
 });
 const core = new AgentCore({ database, seedDevelopmentFixtures: false, modelProviders: [text, worker] });
 try {
  const session = core.runtime.createSession({ title: "Robotics", kind: "agent", allowedTools: ["tools.search"] });
  const result = await core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Keep going.", model: "auto", providerIds: ["auto"] });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(worker.complete).toHaveBeenCalled();
  expect(text.complete).not.toHaveBeenCalled();
  expect(database.listToolExecutions(session.id)).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "tools.search", status: "verified" })]));
  const retry = await core.handle({ type: "runtime-retry-agent", sessionId: session.id, model: "auto", providerIds: ["auto"] });
  expect(retry.ok, JSON.stringify(retry)).toBe(true);
  expect(text.complete).not.toHaveBeenCalled();
 } finally { await core.close(); }
});

it("skips text-only explicit fallbacks and preserves tools for the capable endpoint", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const text = provider("text", false);
 const worker = provider("worker", true);
 const core = new AgentCore({ database, seedDevelopmentFixtures: false, modelProviders: [text, worker] });
 try {
  const session = core.runtime.createSession({ title: "Robotics", kind: "agent", allowedTools: ["tools.search"] });
  const result = await core.agentLoop.run({ sessionId: session.id, model: "fixture", providerIds: [text.id, worker.id], userContent: [{ type: "text", text: "Continue" }] });
  expect(result.run.status).toBe("completed");
  expect(text.complete).not.toHaveBeenCalled();
  expect(worker.complete).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "tools.search" })]) }), expect.anything());
 } finally { await core.close(); }
});

it("fails executable work before calling a text-only endpoint instead of reporting completion", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const text = provider("text", false);
 const core = new AgentCore({ database, seedDevelopmentFixtures: false, modelProviders: [text] });
 try {
  const session = core.runtime.createSession({ title: "Robotics", kind: "agent", allowedTools: ["tools.search"] });
  await expect(core.agentLoop.run({ sessionId: session.id, model: "fixture", providerIds: [text.id], userContent: [{ type: "text", text: "Continue" }] })).rejects.toThrow("Kestrel tool support");
  expect(database.listAgentRuns(session.id)).toEqual([expect.objectContaining({ status: "failed" })]);
  expect(text.complete).not.toHaveBeenCalled();
  const automatic = await core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Keep going.", model: "auto", providerIds: ["auto"] });
  expect(automatic).toMatchObject({ ok: false, error: expect.stringContaining("Kestrel tool support") });
  expect(text.complete).not.toHaveBeenCalled();
 } finally { await core.close(); }
});

it("keeps ordinary chat and explicitly tool-free specialist work available on text routes", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const text = provider("text", false);
 const core = new AgentCore({ database, seedDevelopmentFixtures: false, modelProviders: [text] });
 try {
  const chat = core.runtime.createSession({ title: "Chat" });
  const parent = core.runtime.createSession({ title: "Robotics", kind: "agent" });
  const specialist = core.runtime.createSession({ title: "Code", kind: "subagent", parentSessionId: parent.id, specialistDefinition: { key: "code", name: "Code", purpose: "Software", instructions: "", enabled: true } });
  for (const session of [chat, specialist]) {
   const result = await core.agentLoop.run({ sessionId: session.id, model: "fixture", providerIds: [text.id], ...(session === specialist ? { allowedTools: [] } : {}), userContent: [{ type: "text", text: "Hello" }] });
   expect(result.run.status).toBe("completed");
  }
  expect(text.complete).toHaveBeenCalledTimes(2);
 } finally { await core.close(); }
});

it("does not let model catalog capabilities grant tools to a text-only transport", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const text = provider("text", false);
 text.discoverModels = async () => [{ id: "advertised-model", availability: "available", source: "provider_api", capabilities: { capabilityProvenance: "confirmed", tools: true } }];
 try {
  const catalog = new ModelCatalog(database, [text]);
  await catalog.refresh([text]);
  const registry = new ModelRegistry(database, [text], [], undefined, catalog);
  const profile = registry.list().find(item => item.model === "advertised-model");
  expect(profile).toBeDefined();
  expect(profile?.features.tools).toBe(false);
  expect(profile?.capabilities.tool_use).toBe(0);
 } finally { database.close(); }
});
