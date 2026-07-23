import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentLoop } from "./agent-loop";
import { AutomationDaemon, TaskOrchestrator, nextCronOccurrence, parseScheduleExpression } from "./orchestration";
import { ProviderPool, type ModelProvider } from "./providers";
import { AgentRuntime } from "./runtime";
import { teacherOpportunity } from "./fixtures";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(provider: ModelProvider, now = () => new Date("2026-07-22T20:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "kestrel-orchestration-"));
  directories.push(root);
  const database = new KestrelDatabase(":memory:", createEncryptionKey());
  const runtime = new AgentRuntime(database, [root], () => now().toISOString());
  const parent = runtime.createSession({ title: "Parent", workspaceRoot: root });
  const loop = new AgentLoop(database, runtime, new ProviderPool([provider]), now);
  return { root, database, runtime, parent, orchestrator: new TaskOrchestrator(database, runtime, loop, now, 3) };
}

function finalProvider(onCall?: () => Promise<void>): ModelProvider {
  return {
    id: "fake",
    capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true },
    complete: async (request) => {
      await onCall?.();
      return { providerId: "fake", model: request.model, text: "Done.", toolCalls: [], usage: { inputTokens: 3, outputTokens: 1 }, finishReason: "stop" };
    }
  };
}

describe("task orchestration", () => {
  it("parses bounded natural-language, ISO, and cron schedules", () => {
    const now = new Date("2026-07-22T20:07:30.000Z");
    expect(parseScheduleExpression("every 15 minutes", now)).toEqual({ kind: "interval", intervalMs: 900_000, nextRunAt: "2026-07-22T20:22:30.000Z" });
    expect(parseScheduleExpression("tomorrow at 9:30 am", now)).toEqual({ kind: "once", nextRunAt: "2026-07-23T09:30:00.000Z" });
    expect(parseScheduleExpression("*/15 * * * *", now)).toEqual({ kind: "cron", expression: "*/15 * * * *", nextRunAt: "2026-07-22T20:15:00.000Z" });
    expect(nextCronOccurrence("0 9 * * 1", now).toISOString()).toBe("2026-07-27T09:00:00.000Z");
    expect(() => parseScheduleExpression("whenever convenient", now)).toThrow("not a future time");
  });

  it("delegates into isolated child sessions with scoped tools", async () => {
    const item = fixture(finalProvider());
    const delegated = await item.orchestrator.delegate({
      parentSessionId: item.parent.id, title: "Inspect", prompt: "Inspect only.", model: "fake", providerIds: ["fake"], allowedTools: ["workspace.read"]
    });
    expect(delegated.result.run.status).toBe("completed");
    expect(item.runtime.getSession(delegated.sessionId)).toMatchObject({ parentSessionId: item.parent.id, allowedTools: ["workspace.read"] });
    expect(delegated.sessionId).not.toBe(item.parent.id);
    item.database.close();
  });

  it("delegates into an approved Git worktree and hands evidence back to the parent", async () => {
    const item = fixture(finalProvider());
    writeFileSync(join(item.root, "README.md"), "# Isolated\n");
    execFileSync("git", ["init"], { cwd: item.root });
    execFileSync("git", ["add", "README.md"], { cwd: item.root });
    execFileSync("git", ["-c", "user.name=Kestrel Test", "-c", "user.email=kestrel@example.test", "commit", "-m", "Initial"], { cwd: item.root });
    const delegated = await item.orchestrator.delegate({ parentSessionId: item.parent.id, title: "Isolated", prompt: "Inspect in isolation.", model: "fake", providerIds: ["fake"], isolateWorktree: true });
    expect(item.runtime.getSession(delegated.sessionId).workspaceRoot).toContain(join(".kestrel", "worktrees", "kestrel--"));
    const handoff = item.orchestrator.handoff(delegated.sessionId, "Isolation review is complete.");
    expect(handoff).toMatchObject({ sessionId: item.parent.id, role: "system", content: expect.stringContaining("Isolation review is complete") });
    expect(handoff.content).toContain("evidence");
    item.database.close();
  });

  it("runs bounded teams without exceeding configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const item = fixture(finalProvider(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    }));
    const result = await item.orchestrator.runTeam(Array.from({ length: 5 }, (_, index) => ({
      parentSessionId: item.parent.id, title: `Worker ${index}`, prompt: "Work.", model: "fake", providerIds: ["fake"]
    })), 2);
    expect(result).toHaveLength(5);
    expect(peak).toBe(2);
    expect(new Set(result.map((entry) => entry instanceof Error ? "error" : entry.sessionId)).size).toBe(5);
    item.database.close();
  });

  it("persists goals, shared teams, and provenance-backed peer messages", async () => {
    const item = fixture(finalProvider());
    const first = item.runtime.createSession({ title: "First", parentSessionId: item.parent.id, workspaceRoot: item.root });
    const second = item.runtime.createSession({ title: "Second", parentSessionId: item.parent.id, workspaceRoot: item.root });
    const goal = item.orchestrator.createGoal(item.parent.id, "Ship", "Finish the release", ["Test", "Package"]);
    expect(item.orchestrator.updateGoal(goal.id, { taskId: goal.tasks[0]!.id, taskStatus: "completed" }).tasks[0]?.status).toBe("completed");
    expect(item.orchestrator.updateGoal(goal.id, { taskId: goal.tasks[1]!.id, assigneeSessionId: first.id }).tasks[1]?.assigneeSessionId).toBe(first.id);
    expect(item.orchestrator.updateGoal(goal.id, { taskId: goal.tasks[1]!.id, assigneeSessionId: null }).tasks[1]?.assigneeSessionId).toBeUndefined();
    const unrelated = item.runtime.createSession({ title: "Unrelated", workspaceRoot: item.root });
    expect(() => item.orchestrator.updateGoal(goal.id, { taskId: goal.tasks[1]!.id, assigneeSessionId: unrelated.id })).toThrow("child session");
    const opportunityGoal = item.orchestrator.goalFromOpportunity(item.parent.id, teacherOpportunity);
    expect(opportunityGoal).toMatchObject({ sourceOpportunityId: teacherOpportunity.id, title: teacherOpportunity.title });
    expect(opportunityGoal.tasks[0]?.title).toContain(teacherOpportunity.expectedOutputs[0]!.type);
    expect(item.orchestrator.goalFromOpportunity(item.parent.id, teacherOpportunity).id).toBe(opportunityGoal.id);
    const team = item.orchestrator.createTeam(item.parent.id, "Release team", [first.id, second.id], ["Inspect", "Verify"]);
    const third = item.runtime.createSession({ title: "Third", parentSessionId: item.parent.id, workspaceRoot: item.root });
    expect(item.orchestrator.updateTeam(team.id, { memberSessionIds: [first.id, third.id], sharedPlan: ["Inspect", "Package"] })).toMatchObject({ memberSessionIds: [first.id, third.id], sharedPlan: ["Inspect", "Package"] });
    item.orchestrator.updateTeam(team.id, { memberSessionIds: [first.id, second.id, third.id] });
    const peer = item.orchestrator.sendPeerMessage(team.id, first.id, second.id, "Tests are green.");
    expect(item.runtime.listMessages(second.id)).toMatchObject([{ role: "system", content: expect.stringContaining(peer.id) }]);
    expect(item.orchestrator.listTeams()[0]).toMatchObject({ sharedPlan: ["Inspect", "Package"], messages: [{ text: "Tests are green." }] });
    item.database.close();
  });

  it("persists encrypted schedules and advances recurring jobs", async () => {
    let instant = new Date("2026-07-22T20:00:00.000Z");
    const item = fixture(finalProvider(), () => instant);
    const job = item.orchestrator.schedule({
      title: "Private schedule", sessionId: item.parent.id, model: "fake", providerIds: ["fake"], prompt: "private scheduled prompt",
      schedule: { kind: "interval", nextRunAt: instant.toISOString(), intervalMs: 60_000 }
    });
    const ciphertext = item.database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("orchestrator.scheduled-jobs") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain("private scheduled prompt");
    const [completed] = await item.orchestrator.runDue(instant);
    expect(completed).toMatchObject({ id: job.id, status: "pending", lastRunId: expect.any(String), schedule: { nextRunAt: "2026-07-22T20:01:00.000Z" } });
    instant = new Date("2026-07-22T20:01:00.000Z");
    expect(await item.orchestrator.runDue(instant)).toHaveLength(1);
    item.database.close();
  });

  it("advances cron jobs to the next matching occurrence", async () => {
    const instant = new Date("2026-07-22T20:15:00.000Z");
    const item = fixture(finalProvider(), () => instant);
    const job = item.orchestrator.schedule({ title: "Quarter hour", sessionId: item.parent.id, model: "fake", providerIds: ["fake"], prompt: "Run cron", schedule: { kind: "cron", expression: "*/15 * * * *", nextRunAt: instant.toISOString() } });
    const [completed] = await item.orchestrator.runDue(instant);
    expect(completed).toMatchObject({ id: job.id, status: "pending", schedule: { kind: "cron", expression: "*/15 * * * *", nextRunAt: "2026-07-22T20:30:00.000Z" } });
    item.database.close();
  });

  it("runs due work through a signal-aware serialized automation daemon", async () => {
    const item = fixture(finalProvider());
    item.orchestrator.schedule({ title: "Daemon", sessionId: item.parent.id, model: "fake", providerIds: ["fake"], prompt: "Run", schedule: { kind: "once", nextRunAt: "2026-07-22T20:00:00.000Z" } });
    const controller = new AbortController();
    const cycles: number[] = [];
    await new AutomationDaemon(item.orchestrator, 250, () => new Date("2026-07-22T20:00:00.000Z")).run(controller.signal, ({ jobs }) => { cycles.push(jobs.length); controller.abort(); });
    expect(cycles).toEqual([1]);
    expect(item.orchestrator.listJobs()[0]?.status).toBe("completed");
    item.database.close();
  });

  it("keeps scheduled runs in a review queue and resumes the same run after approval", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "fake",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true },
      complete: async (request) => ++calls === 1
        ? { providerId: "fake", model: request.model, text: "", toolCalls: [{ id: "delete-call", name: "workspace.delete", arguments: { path: "review.txt" } }], usage: { inputTokens: 3, outputTokens: 1 }, finishReason: "tool_calls" }
        : { providerId: "fake", model: request.model, text: "Approved and deleted.", toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 }, finishReason: "stop" }
    };
    const item = fixture(provider);
    writeFileSync(join(item.root, "review.txt"), "review first\n");
    const job = item.orchestrator.schedule({
      title: "Review boundary", sessionId: item.parent.id, model: "fake", providerIds: ["fake"], prompt: "Delete review.txt",
      schedule: { kind: "once", nextRunAt: "2026-07-22T20:00:00.000Z" }
    });
    const [waiting] = await item.orchestrator.runDue();
    expect(waiting).toMatchObject({ id: job.id, status: "waiting_approval", lastRunId: expect.any(String) });
    expect(existsSync(join(item.root, "review.txt"))).toBe(true);
    const resumed = await item.orchestrator.resumeJob(job.id);
    expect(resumed.status).toBe("completed");
    expect(existsSync(join(item.root, "review.txt"))).toBe(false);
    item.database.close();
  });

  it("composes tool outputs and resumes workflows across approval boundaries", async () => {
    const item = fixture(finalProvider());
    const completed = await item.orchestrator.startWorkflow(item.parent.id, "Write then read", [
      { id: "write", toolName: "workspace.write", input: { path: "generated.txt", content: "workflow result\n" } },
      { id: "read", toolName: "workspace.read", input: { path: "$write.path" } }
    ]);
    expect(completed.status).toBe("completed");
    expect(completed.results.read?.output).toMatchObject({ content: "workflow result\n" });
    const waiting = await item.orchestrator.startWorkflow(item.parent.id, "Delete after review", [
      { id: "delete", toolName: "workspace.delete", input: { path: "generated.txt" } }
    ]);
    expect(waiting.status).toBe("waiting_approval");
    expect(existsSync(join(item.root, "generated.txt"))).toBe(true);
    const resumed = await item.orchestrator.resumeWorkflow(waiting.id, ["delete"]);
    expect(resumed.status).toBe("completed");
    expect(existsSync(join(item.root, "generated.txt"))).toBe(false);
    item.database.close();
  });

  it("runs bounded data loops and result-based branches in durable workflows", async () => {
    const item = fixture(finalProvider());
    const completed = await item.orchestrator.startWorkflow(item.parent.id, "Generate files", [
      { id: "write", toolName: "workspace.write", input: { path: "$item.path", content: "$item.content" }, forEach: [{ path: "first.txt", content: "one\n" }, { path: "second.txt", content: "two\n" }] },
      { id: "matching", toolName: "workspace.write", input: { path: "matched.txt", content: "matched\n" }, when: { reference: "$write[0].path", equals: "first.txt" } },
      { id: "skipped", toolName: "workspace.write", input: { path: "skipped.txt", content: "no\n" }, when: { reference: "$write[1].path", equals: "missing.txt" } }
    ]);
    expect(completed.status).toBe("completed");
    expect(Object.keys(completed.results)).toEqual(["write[0]", "write[1]", "matching"]);
    expect(existsSync(join(item.root, "first.txt"))).toBe(true);
    expect(existsSync(join(item.root, "second.txt"))).toBe(true);
    expect(existsSync(join(item.root, "matched.txt"))).toBe(true);
    expect(existsSync(join(item.root, "skipped.txt"))).toBe(false);
    item.database.close();
  });
});
