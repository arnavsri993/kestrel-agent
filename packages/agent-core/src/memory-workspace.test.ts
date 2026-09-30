import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { MemoryDocumentSaveSchema } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { AgentCore } from "./index";
import { dayFingerprint } from "./memory-consolidation";

function fixture(path = ":memory:", key = createEncryptionKey()) {
 const database = new KestrelDatabase(path, key);
 const core = new AgentCore({ database, workspaceRoots: [tmpdir()], projects: [{ id: "robotics", order: 0, name: "Robotics", path: tmpdir(), createdAt: "2026-09-16T15:00:00.000Z", updatedAt: "2026-09-16T15:00:00.000Z" }], now: () => "2026-09-16T15:00:00.000Z" });
 const save = (input: Record<string, unknown>) => core.memoryWorkspace.save(MemoryDocumentSaveSchema.parse({ kind: "memory", title: "Context", text: "Useful context", ...input }));
 return { database, core, save, close: async () => { await core.close(); database.close(); } };
}

describe("canonical memory workspace", () => {
 it("preserves encrypted documents across restart and retains legacy sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-memory-workspace-")); const path = join(root, "profile.sqlite"); const key = createEncryptionKey();
  const first = fixture(path, key);
  const document = first.save({ kind: "tool", title: "CAD", text: "Preserve assembly constraints before changing geometry." });
  await first.close();
  const second = fixture(path, key);
  try { expect(second.core.memoryWorkspace.read().documents.find(item => item.id === document.id)?.text).toBe(document.text); expect(readFileSync(path).includes(Buffer.from(document.text))).toBe(false); }
  finally { await second.close(); rmSync(root, { recursive: true, force: true }); }
 });
 it("separates user domains and narrows individual person passages", async () => {
  const f = fixture(); try {
   f.save({ kind: "person", title: "Teammate", text: "Robotics context\n\nPersonal context", passages: [
    { id: "robotics", text: "Robotics context", domainIds: ["robotics"], sourceIds: ["r"], sharing: "domain_shared" },
    { id: "personal", text: "Personal context", domainIds: ["personal"], sourceIds: ["p"] },
   ] });
   const scoped = f.core.memoryWorkspace.read({ domainId: "robotics" });
   expect(scoped.documents).toHaveLength(1); expect(scoped.documents[0]?.text).toBe("Robotics context");
   expect(scoped.documents[0]?.sourceIds).toEqual(["r"]);
  } finally { await f.close(); }
 });
 it("inherits only explicitly shared domain context and prevents editing inherited documents", async () => {
  const f = fixture(); try {
   const parent = f.core.runtime.createSession({ title: "Robotics", kind: "agent", projectId: "robotics" });
   const child = f.core.runtime.createSession({ title: "CAD", parentSessionId: parent.id, projectId: "robotics" });
   const parentId = f.core.memorySubstrate.ensureAgentIdentity(parent).id;
   const childId = f.core.memorySubstrate.ensureAgentIdentity(child).id;
   const shared = f.save({ text: "Shared robotics design", ownerAgentId: parentId, domainIds: ["robotics"], sharing: "domain_shared" });
   f.save({ text: "Private autonomy debug history", ownerAgentId: parentId, domainIds: ["robotics"] });
   f.save({ text: "Personal holidays", domainIds: ["personal"], sharing: "domain_shared" });
   expect(f.core.memoryWorkspace.read({ viewerId: childId }).documents.map(item => item.text)).toEqual(["Shared robotics design"]);
   expect(() => f.save({ ...shared, viewerId: childId, text: "Overwrite", expectedVersion: shared.version })).toThrow(/own|Inherited/);
  } finally { await f.close(); }
 });
 it("does not leak sensitive passage text in a mixed document", async () => {
  const f = fixture(); try {
   f.save({ text: "Public detail\n\nSensitive detail", passages: [ { id: "a", text: "Public detail", sensitivity: "public" }, { id: "b", text: "Sensitive detail", sensitivity: "sensitive" } ] });
   expect(f.core.memoryWorkspace.read().documents[0]?.text).toBe("Public detail");
  } finally { await f.close(); }
 });
 it("invalidates a stored day summary when its evidence changes", async () => {
  const f = fixture(); try {
   const event = f.core.memorySubstrate.captureActivity({ source: "test", eventType: "project_activity", textSummary: "Worked on design.", importance: 0.8 });
   expect(event).toBeDefined();
   const day = f.core.memoryWorkspace.read().days[0]!;
   f.core.memoryWorkspace.saveDaySummary({ viewerId: "user", day: day.day, summary: "Completed design work.", summaryMethod: "model", sourceIds: [event!.id], eventIds: [event!.id], fingerprint: dayFingerprint(day.events) });
   expect(f.core.memoryWorkspace.read().days[0]?.summaryMethod).toBe("model");
   f.core.memorySubstrate.captureActivity({ source: "test", eventType: "project_activity", textSummary: "Reviewed constraints.", importance: 0.8 });
   expect(f.core.memoryWorkspace.read().days[0]?.summaryMethod).toBe("deterministic");
  } finally { await f.close(); }
 });
 it("forgets consolidated documents and scoped passages with their source", async () => {
  const f = fixture(); try {
   const event = f.core.memorySubstrate.captureActivity({ source: "test", sourceId: "source-to-forget", eventType: "project_activity", textSummary: "Reviewed the chassis constraints.", importance: 0.8 })!;
   const document = f.save({ title: "Chassis decision", sourceIds: [event.id] });
   const retained = f.save({ title: "Unrelated decision", sourceIds: ["different-source"] });
   f.core.memorySubstrate.forgetSource("source-to-forget");
   const ids = f.core.memoryWorkspace.read().documents.map(item => item.id);
   expect(ids).not.toContain(document.id); expect(ids).toContain(retained.id);
  } finally { await f.close(); }
 });

});
