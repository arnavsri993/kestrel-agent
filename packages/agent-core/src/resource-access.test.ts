import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { ResourceAccess } from "@kestrel/shared-types";
import { describe, it, expect } from "vitest";
import { AgentRuntime } from "./runtime";

const access: ResourceAccess = { connectionId: "fixture-account", resourceId: "team-thread", capability: "read" };
function fixture() {
 const database = new KestrelDatabase(":memory:", createEncryptionKey());
 const runtime = new AgentRuntime(database, []);
 let reads = 0;
 runtime.registerExternalTool({ descriptor: { name: "fixture.read", title: "Read", description: "Fixture read", category: "connector", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "connector", tags: [] },
 inputSchema: { type: "object" }, resourceAccess: input => [{ ...access, resourceId: String(input.id) }], execute: () => { reads++; return { text: "private team data" }; } });
 const parent = runtime.createSession({ title: "Robotics", kind: "agent", allowedTools: ["fixture.read"] });
 const child = runtime.createSession({ title: "Code", kind: "subagent", parentSessionId: parent.id, allowedTools: ["fixture.read"] });
 const now = new Date().toISOString();
 database.saveAgentRun({ id: "run-resource", sessionId: child.id, model: "fixture", providerIds: ["fixture"], status: "running", turn: 0, createdAt: now, updatedAt: now, toolScope: ["fixture.read"], resourceScope: [access] });
 return { database, runtime, parent, child, reads: () => reads };
}

describe("resource execution boundary", () => {
 it("intersects agent, parent, task and exact resource grants before cache reuse", async () => {
  const f = fixture();
  try {
   f.runtime.setResourceGrants(f.parent.id, [access]);
   await expect(f.runtime.callTool(f.child.id, "fixture.read", { id: access.resourceId }, { runId: "run-resource" })).rejects.toThrow("not granted");
   f.runtime.setResourceGrants(f.child.id, [access]);
   const options = { runId: "run-resource", idempotencyKey: "read-once" };
   expect((await f.runtime.callTool(f.child.id, "fixture.read", { id: access.resourceId }, options)).status).toBe("verified");
   await expect(f.runtime.callTool(f.child.id, "fixture.read", { id: "personal-thread" }, options)).rejects.toThrow("not granted");
   f.runtime.setResourceGrants(f.parent.id, []);
   await expect(f.runtime.callTool(f.child.id, "fixture.read", { id: access.resourceId }, options)).rejects.toThrow("not granted");
   expect(f.reads()).toBe(1);
  } finally { f.database.close(); }
 });
 it("rejects absent task scope and spoofed run identity", async () => {
  const f = fixture();
  try {
   for (const session of [f.parent, f.child]) f.runtime.setResourceGrants(session.id, [access]);
   await expect(f.runtime.callTool(f.child.id, "fixture.read", { id: access.resourceId })).rejects.toThrow("bounded task");
   await expect(f.runtime.callTool(f.parent.id, "fixture.read", { id: access.resourceId }, { runId: "run-resource" })).rejects.toThrow("identity");
   const run = f.database.getAgentRun("run-resource")!;
   f.database.saveAgentRun({ ...run, resourceScope: [] });
   await expect(f.runtime.callTool(f.child.id, "fixture.read", { id: access.resourceId }, { runId: run.id })).rejects.toThrow("task scope");
   expect(f.reads()).toBe(0);
  } finally { f.database.close(); }
 });
 it("rechecks retained conversation results after resource revocation", async () => {
  const f = fixture();
  try {
   for (const session of [f.parent, f.child]) f.runtime.setResourceGrants(session.id, [access]);
   const execution = await f.runtime.callTool(f.child.id, "fixture.read", { id: access.resourceId }, { runId: "run-resource" });
   f.runtime.appendMessage({ sessionId: f.child.id, role: "tool", toolName: "fixture.read", toolExecutionId: execution.id, content: JSON.stringify(execution.output) });
   expect(() => f.runtime.assertConversationResourceAccess(f.child.id, "run-resource")).not.toThrow();
   f.runtime.setResourceGrants(f.parent.id, []);
   expect(() => f.runtime.assertConversationResourceAccess(f.child.id, "run-resource")).toThrow("not granted");
  } finally { f.database.close(); }
 });
 it("discards a read response if access is revoked during its request", async () => {
  const f = fixture();
  try {
   f.runtime.setResourceGrants(f.parent.id, [access]);
   f.runtime.registerExternalTool({ descriptor: { name: "fixture.revoked", title: "Read", description: "Read fixture", category: "connector", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "connector", tags: [] }, inputSchema: { type: "object" }, resourceAccess: () => [access], execute: async () => { f.runtime.setResourceGrants(f.parent.id, []); return { secret: "must not enter journal or context" }; } });
   f.runtime.allowTool(f.parent.id, "fixture.revoked");
   const result = await f.runtime.callTool(f.parent.id, "fixture.revoked", {});
   expect(result.status).toBe("failed");
   expect(result.output).toBeUndefined();
   expect(JSON.stringify(f.database.getToolExecution(result.id))).not.toContain("must not enter");
  } finally { f.database.close(); }
 });
});
