import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { DEFAULT_USAGE_POLICY, UsageGovernor } from "./usage-governor";
import { AgentRuntime } from "./runtime";

describe("usage governor", () => {
  it("falls back to the default policy when persisted state is malformed", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    database.setPrivateState("runtime.usage-policy", {
      maximumConcurrentCalls: "unbounded",
    });
    const governor = new UsageGovernor(database);

    expect(governor.getPolicy()).toEqual(DEFAULT_USAGE_POLICY);
    expect(governor.acquire()).toBeDefined();
    database.close();
  });

  it("calculates configurable token cost and enforces concurrency", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const governor = new UsageGovernor(database, () => new Date("2026-07-22T18:00:00.000Z"));
    governor.setPolicy({
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: 100,
      perCallReservationUsd: 1,
      maximumConcurrentCalls: 1,
      defaultRate: { inputPerMillionUsd: 2, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.5, reasoningPerMillionUsd: 4 },
      rates: {}
    });
    expect(governor.estimateCost("provider", "model", { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 200_000, reasoningTokens: 50_000 })).toBe(2.9);
    expect(governor.estimateCost("provider", "model", { inputTokens: 100, outputTokens: -100, cachedInputTokens: 500, reasoningTokens: Number.NaN })).toBe(0.00005);
    const lease = governor.acquire();
    expect(() => governor.acquire()).toThrow("concurrency limit");
    lease.release();
    expect(governor.acquire()).toBeDefined();
    const ciphertext = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("runtime.usage-policy") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain("maximumConcurrentCalls");
    database.close();
  });

  it("reserves budget before calls and blocks daily or monthly overspend", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const governor = new UsageGovernor(database, () => new Date("2026-07-22T18:00:00.000Z"));
    governor.setPolicy({
      dailyBudgetUsd: 1,
      monthlyBudgetUsd: 10,
      perCallReservationUsd: 0.2,
      maximumConcurrentCalls: 2,
      defaultRate: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, cachedInputPerMillionUsd: 1, reasoningPerMillionUsd: 1 },
      rates: {}
    });
    const session = new AgentRuntime(database).createSession({ title: "Budget fixture" });
    database.saveAgentRun({ id: "run-1", sessionId: session.id, model: "model", providerIds: ["provider"], status: "completed", turn: 1, createdAt: "2026-07-22T17:00:00.000Z", updatedAt: "2026-07-22T17:00:00.005Z" });
    database.saveModelCallAudit({
      id: "audit-1", runId: "run-1", sessionId: session.id, providerId: "provider", model: "model", status: "completed",
      inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.9, durationMs: 5,
      startedAt: "2026-07-22T17:00:00.000Z", completedAt: "2026-07-22T17:00:00.005Z"
    });
    expect(() => governor.acquire()).toThrow("Daily model budget");
    expect(governor.spending()).toMatchObject({ dailyUsd: 0.9, monthlyUsd: 0.9, activeCalls: 0 });
    database.close();
  });
});
