import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptionKey, encryptText } from "@kestrel/encryption";
import { KestrelDatabase } from "./index";

const temporaryDirectories: string[] = [];

function sharedDatabases() {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-database-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "kestrel.sqlite");
  const encryptionKey = createEncryptionKey();
  return {
    first: new KestrelDatabase(path, encryptionKey),
    second: new KestrelDatabase(path, encryptionKey),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("idempotency claims", () => {
  it("coordinates one owner across database connections and preserves the first terminal result", () => {
    const { first, second } = sharedDatabases();
    try {
      expect(first.claimIdempotentResult("runtime-tool:one", "owner-one", 101, { status: "running", id: "first" }))
        .toMatchObject({ state: "claimed", claim: { ownerToken: "owner-one", ownerPid: 101, pendingResult: { id: "first" } } });
      expect(second.claimIdempotentResult("runtime-tool:one", "owner-two", 202, { status: "running", id: "second" }))
        .toMatchObject({ state: "active", claim: { ownerToken: "owner-one", ownerPid: 101, pendingResult: { id: "first" } } });
      expect(() => second.completeIdempotentResult("runtime-tool:one", "owner-two", { status: "verified", id: "second" }))
        .toThrow("not owned");

      expect(first.completeIdempotentResult("runtime-tool:one", "owner-one", { status: "verified", id: "first" }))
        .toEqual({ completed: true, result: { status: "verified", id: "first" } });
      expect(second.claimIdempotentResult("runtime-tool:one", "owner-two", 202, { status: "running", id: "second" }))
        .toEqual({ state: "completed", result: { status: "verified", id: "first" } });
      expect(second.completeIdempotentResult("runtime-tool:one", "owner-two", { status: "verified", id: "second" }))
        .toEqual({ completed: false, result: { status: "verified", id: "first" } });
      expect(first.listIdempotentClaims()).toEqual([]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("releases only the matching owner claim so a safe pre-effect retry can acquire it", () => {
    const { first, second } = sharedDatabases();
    try {
      expect(first.claimIdempotentResult("runtime-tool:released", "owner-one", 101, { status: "running" }).state)
        .toBe("claimed");
      expect(second.releaseIdempotentClaim("runtime-tool:released", "owner-two")).toBe(false);
      expect(first.releaseIdempotentClaim("runtime-tool:released", "owner-one")).toBe(true);
      expect(second.claimIdempotentResult("runtime-tool:released", "owner-two", 202, { status: "running" }).state)
        .toBe("claimed");
    } finally {
      first.close();
      second.close();
    }
  });

  it("terminalizes an abandoned claim and refuses a late owner overwrite", () => {
    const { first, second } = sharedDatabases();
    try {
      first.claimIdempotentResult("runtime-tool:abandoned", "dead-owner", 999_999, { status: "running", id: "pending" });
      expect(second.listIdempotentClaims<{ status: string; id: string }>("runtime-tool:"))
        .toMatchObject([{ key: "runtime-tool:abandoned", ownerToken: "dead-owner", pendingResult: { id: "pending" } }]);

      const uncertain = { status: "failed", id: "pending", error: "Outcome is uncertain; the mutation will not be retried." };
      expect(second.abandonIdempotentClaim("runtime-tool:abandoned", "dead-owner", uncertain))
        .toEqual({ completed: true, result: uncertain });
      expect(first.completeIdempotentResult("runtime-tool:abandoned", "dead-owner", { status: "verified", id: "pending" }))
        .toEqual({ completed: false, result: uncertain });
      expect(first.getIdempotentClaim("runtime-tool:abandoned")).toBeUndefined();
      expect(second.getIdempotentResult("runtime-tool:abandoned")).toEqual(uncertain);
    } finally {
      first.close();
      second.close();
    }
  });

  it("keeps the existing completed-result API backward-compatible after migration", () => {
    const { first, second } = sharedDatabases();
    try {
      first.saveIdempotentResult("legacy-key", { accepted: true });
      expect(second.getIdempotentResult("legacy-key")).toEqual({ accepted: true });
      expect(second.claimIdempotentResult("legacy-key", "owner", 303, { accepted: false }))
        .toEqual({ state: "completed", result: { accepted: true } });
      expect(second.db.prepare("SELECT version FROM schema_migrations WHERE version = 7").get())
        .toEqual({ version: 7 });
      expect(second.db.prepare("SELECT version FROM schema_migrations WHERE version = 8").get())
        .toEqual({ version: 8 });
    } finally {
      first.close();
      second.close();
    }
  });
});

describe("context usage", () => {
  it("normalizes malformed list limits before binding the SQL LIMIT", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const bundle = (id: string, createdAt: string) => ({ id, query: "query", memories: [], people: [], events: [], influences: [], prompt: "prompt", createdAt });
    try {
      database.saveContextUsage(bundle("context-1", "2026-07-23T00:00:00.000Z"));
      database.saveContextUsage(bundle("context-2", "2026-07-23T00:01:00.000Z"));
      expect(database.listContextUsage(Number.NaN)).toHaveLength(2);
      expect(database.listContextUsage(1.9)).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

describe("configuration history recovery", () => {
  it("skips malformed encrypted versions in the recovery view", () => {
    const key = createEncryptionKey();
    const database = new KestrelDatabase(":memory:", key);
    const corrupt = encryptText(JSON.stringify({ id: "not-a-version" }), key);
    database.db
      .prepare(
        `INSERT INTO agent_configuration_records (
          id, kind, status, payload_ciphertext, payload_iv,
          payload_auth_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "corrupt-version",
        "version",
        "verified",
        corrupt.ciphertext,
        corrupt.iv,
        corrupt.authTag,
        "2026-07-29T12:00:00.000Z",
        "2026-07-29T12:00:00.000Z",
      );

    expect(database.listValidAgentConfigurationVersions()).toEqual([]);
    expect(() => database.listAgentConfigurationVersions()).toThrow();
    database.close();
  });
});

describe("runtime messages", () => {
  it("truncates messages correctly by keeping the most recent count", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const sessionId = "session-trunc";
    database.saveRuntimeSession({ id: sessionId, title: "Test", allowedTools: [], status: "active", checkpoints: [], createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" });
    
    for (let i = 1; i <= 5; i++) {
      database.saveRuntimeMessage({ id: `msg-${i}`, sessionId, role: "user", content: `Message ${i}`, createdAt: `2026-07-29T10:0${i}:00.000Z` });
    }
    
    expect(database.listRuntimeMessages(sessionId)).toHaveLength(5);
    
    database.truncateRuntimeMessages(sessionId, 2);
    
    const remaining = database.listRuntimeMessages(sessionId);
    expect(remaining).toHaveLength(2);
    expect(remaining.map(m => m.id)).toEqual(["msg-4", "msg-5"]);
    database.close();
  });

  it("searches runtime messages by term matching", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const sessionId = "session-search";
    database.saveRuntimeSession({ id: sessionId, title: "Test", allowedTools: [], status: "active", checkpoints: [], createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" });
    
    database.saveRuntimeMessage({ id: "msg-a", sessionId, role: "user", content: "hello world specialterm", createdAt: "2026-07-29T10:00:00.000Z" });
    database.saveRuntimeMessage({ id: "msg-b", sessionId, role: "assistant", content: "some other text without the term", createdAt: "2026-07-29T10:01:00.000Z" });
    
    const results = database.searchRuntimeMessages("specialterm");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("msg-a");
    database.close();
  });
});

describe("analytics queries", () => {
  it("aggregates tool execution stats correctly", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const sessionId = "session-stats";
    database.saveRuntimeSession({ id: sessionId, title: "Test", allowedTools: [], status: "active", checkpoints: [], createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" });
    const createExecution = (id: string, tool: string, status: "verified" | "blocked" | "failed" | "running") => {
      database.saveToolExecution({ id, sessionId, toolName: tool, status, riskLevel: "low", input: {}, output: {}, startedAt: "2026-07-29T10:00:00.000Z", completedAt: "2026-07-29T10:00:01.000Z" });
    };
    createExecution("t1", "fs.read", "verified");
    createExecution("t2", "fs.read", "verified");
    createExecution("t3", "fs.write", "blocked");
    createExecution("t4", "fs.write", "failed");
    createExecution("t5", "shell.run", "running");

    const stats = database.aggregateToolExecutionStats();
    expect(stats).toEqual(expect.arrayContaining([
      { tool: "fs.read", outcome: "success", count: 2 },
      { tool: "fs.write", outcome: "blocked", count: 1 },
      { tool: "fs.write", outcome: "error", count: 1 },
      { tool: "shell.run", outcome: "pending", count: 1 },
    ]));
    database.close();
  });

  it("calculates spending and model call stats correctly", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const sessionId = "session-spend";
    const runId = "run-spend";
    database.saveRuntimeSession({ id: sessionId, title: "Test", allowedTools: [], status: "active", checkpoints: [], createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" });
    database.saveAgentRun({ id: runId, sessionId, model: "gpt-4", providerIds: ["test"], status: "completed", turn: 1, createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" });
    
    database.saveModelCallAudit({
      id: "call-1", runId, sessionId, status: "completed", startedAt: "2026-07-29T10:00:00.000Z", completedAt: "2026-07-29T10:00:01.000Z",
      providerId: "openai", model: "gpt-4", inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.004, durationMs: 1000
    });
    database.saveModelCallAudit({
      id: "call-2", runId, sessionId, status: "failed", startedAt: "2026-07-29T10:00:02.000Z", completedAt: "2026-07-29T10:00:03.000Z",
      providerId: "openai", model: "gpt-4", inputTokens: 10, outputTokens: 0, estimatedCostUsd: 0.0004, durationMs: 1000
    });

    const spend = database.calculateSpending("2026-07-29T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect(spend.dailyUsd).toBeCloseTo(0.0044);
    expect(spend.monthlyUsd).toBeCloseTo(0.0044);

    const stats = database.aggregateModelCallStats();
    expect(stats).toEqual(expect.arrayContaining([
      { provider: "openai", model: "gpt-4", outcome: "success", calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.004, durations: [1] },
      { provider: "openai", model: "gpt-4", outcome: "error", calls: 1, inputTokens: 10, outputTokens: 0, costUsd: 0.0004, durations: [1] }
    ]));
    database.close();
  });
});

describe("tool execution history queries", () => {
  it("filters tool executions at the database boundary", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const sessionId = "session-tool-history";
    const common = {
      sessionId,
      toolName: "fixture.tool",
      status: "verified" as const,
      riskLevel: "low" as const,
      input: {},
      output: { ok: true },
    };
    database.saveRuntimeSession({
      id: sessionId,
      title: "Tool history",
      allowedTools: ["fixture.tool"],
      status: "active",
      checkpoints: [],
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
    });
    database.saveToolExecution({
      ...common,
      id: "tool-old",
      startedAt: "2026-07-29T10:00:00.000Z",
      completedAt: "2026-07-29T10:00:01.000Z",
    });
    database.saveToolExecution({
      ...common,
      id: "tool-recent",
      startedAt: "2026-07-29T11:00:00.000Z",
      completedAt: "2026-07-29T11:00:01.000Z",
    });

    expect(database.listAllToolExecutions("2026-07-29T11:00:00.000Z").map((item) => item.id)).toEqual(["tool-recent"]);
    database.close();
  });
});

describe("runtime history retirement", () => {
  it("atomically retires active runs and their approval executions without releasing an in-flight idempotency claim", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const sessionId = "session-rollback";
    const runId = "run-rollback";
    const startedAt = "2026-07-22T18:00:00.000Z";
    const completedAt = "2026-07-22T18:01:00.000Z";
    const reason = "Approval invalidated because history was rolled back.";
    try {
      database.saveRuntimeSession({
        id: sessionId,
        title: "Rollback fixture",
        allowedTools: ["test.mutation"],
        status: "active",
        checkpoints: [],
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      database.saveAgentRun({
        id: runId,
        sessionId,
        model: "fixture",
        providerIds: ["fixture"],
        status: "waiting_approval",
        turn: 1,
        pendingToolExecutionId: "tool-blocked",
        pendingProviderToolCallId: "call-blocked",
        pendingToolName: "test.mutation",
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      database.saveToolExecution({
        id: "tool-blocked",
        sessionId,
        toolName: "test.mutation",
        status: "blocked",
        riskLevel: "sensitive",
        input: { target: "pending" },
        output: { approvalRequired: true, preview: "Pending mutation" },
        error: "Approval required.",
        idempotencyKey: `${runId}:call-blocked`,
        startedAt,
        completedAt: startedAt,
      });
      const runningStartedAt = "2026-07-22T18:00:30.000Z";
      const runningExecution = {
        id: "tool-running",
        sessionId,
        toolName: "test.mutation",
        status: "running" as const,
        riskLevel: "sensitive" as const,
        input: { target: "in-flight" },
        idempotencyKey: `${runId}:call-running`,
        startedAt: runningStartedAt,
      };
      database.saveToolExecution(runningExecution);
      const claimKey =
        `runtime-tool:${sessionId}:test.mutation:${runId}:call-running`;
      expect(
        database.claimIdempotentResult(
          claimKey,
          "runtime-owner",
          process.pid,
          runningExecution,
        ).state,
      ).toBe("claimed");

      database.db.exec(`
        CREATE TRIGGER fail_history_retirement
        BEFORE UPDATE OF status ON tool_executions
        WHEN OLD.id = 'tool-blocked'
        BEGIN
          SELECT RAISE(ABORT, 'fixture retirement failure');
        END;
      `);
      expect(() =>
        database.retireActiveAgentHistory(sessionId, completedAt, reason),
      ).toThrow("fixture retirement failure");
      expect(database.getAgentRun(runId)).toMatchObject({
        status: "waiting_approval",
        pendingToolExecutionId: "tool-blocked",
      });
      expect(database.getToolExecution("tool-blocked")).toMatchObject({
        status: "blocked",
        output: { approvalRequired: true },
      });
      expect(database.getToolExecution("tool-running")).toMatchObject({
        status: "running",
      });
      database.db.exec("DROP TRIGGER fail_history_retirement");

      expect(
        database.retireActiveAgentHistory(sessionId, completedAt, reason),
      ).toMatchObject({
        runs: [
          {
            id: runId,
            status: "cancelled",
            error: reason,
          },
        ],
        toolExecutions: [
          {
            id: "tool-blocked",
            status: "cancelled",
            output: { approvalRequired: false },
          },
          {
            id: "tool-running",
            status: "failed",
            error: expect.stringContaining(
              "outcome is uncertain and it will not be retried automatically",
            ),
          },
        ],
      });
      expect(database.getAgentRun(runId)).not.toHaveProperty(
        "pendingToolExecutionId",
      );
      expect(database.getIdempotentClaim(claimKey)).toMatchObject({
        ownerToken: "runtime-owner",
        pendingResult: { id: "tool-running", status: "running" },
      });
    } finally {
      database.close();
    }
  });
});
