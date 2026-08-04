import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";

function registerMutation(runtime: AgentRuntime, sessionId: string, execute: (input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  runtime.registerExternalTool({
    descriptor: { name: "fixture.idempotent-mutation", title: "Idempotent mutation", description: "Exercise input-bound idempotency.", category: "connector", riskLevel: "low", readOnly: false, requiresWorkspace: false, source: "plugin", tags: ["test"] },
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: (_context, input) => execute(input),
    verify: async (_context, _input, output) => ({ method: "fixture-readback", evidence: output })
  });
  runtime.allowTool(sessionId, "fixture.idempotent-mutation");
}

describe("runtime idempotency input binding", () => {
  it("rejects a persisted key when the normalized input changes", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Idempotency" });
    let calls = 0;
    registerMutation(runtime, session.id, (input) => {
      calls += 1;
      return { receipt: String(input.value) };
    });

    const first = await runtime.callTool(session.id, "fixture.idempotent-mutation", { value: "one" }, { idempotencyKey: "same-key" });
    await expect(runtime.callTool(session.id, "fixture.idempotent-mutation", { value: "two" }, { idempotencyKey: "same-key" })).rejects.toThrow("different input");
    expect(await runtime.callTool(session.id, "fixture.idempotent-mutation", { value: "one" }, { idempotencyKey: "same-key" })).toEqual(first);
    expect(calls).toBe(1);
    database.close();
  });

  it("rejects a concurrent key when the input changes", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Concurrent idempotency" });
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedSignal = new Promise<void>((resolve) => { started = resolve; });
    registerMutation(runtime, session.id, async (input) => {
      started();
      await gate;
      return { receipt: String(input.value) };
    });

    const firstPromise = runtime.callTool(session.id, "fixture.idempotent-mutation", { value: "one" }, { idempotencyKey: "concurrent-key" });
    await startedSignal;
    await expect(runtime.callTool(session.id, "fixture.idempotent-mutation", { value: "two" }, { idempotencyKey: "concurrent-key" })).rejects.toThrow("different input");
    release();
    await expect(firstPromise).resolves.toMatchObject({ status: "verified", output: { receipt: "one" } });
    database.close();
  });
});
