import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime";

describe("host-owned runtime tool ceiling", () => {
  it("limits discovery and execution even after session grants or caller mutation", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    try {
      const names = ["tools.search"];
      const runtime = new AgentRuntime(database, [], undefined, undefined, [], [], names);
      const session = runtime.createSession({ title: "Restricted host" });
      runtime.allowTool(session.id, "tools.search");
      runtime.allowTool(session.id, "tools.activate");
      names.push("tools.activate");
      expect(runtime.discoverTools(session.id).map((tool) => tool.name)).toEqual(["tools.search"]);
      await expect(runtime.callTool(session.id, "tools.activate", { name: "tools.search" }, { approvalStatus: "approved" })).rejects.toThrow("unavailable");
      const result = await runtime.callTool(session.id, "tools.search", { query: "" });
      expect(result.status).toBe("verified");
    } finally { database.close(); }
  });
  it("treats an explicit empty ceiling as no tools", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    try {
      const runtime = new AgentRuntime(database, [], undefined, undefined, [], [], []);
      const session = runtime.createSession({ title: "No tools" });
      expect(runtime.discoverTools(session.id)).toEqual([]);
    } finally { database.close(); }
  });
});
