import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptionKey } from "@kestrel/encryption";
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
