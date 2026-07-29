import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncryptionKey } from "@kestrel/encryption";
import { KestrelDatabase } from "@kestrel/database";
import { AgentCore, DevelopmentCalendarConnector, DevelopmentEmailConnector, OpportunityEngine, teacherOpportunity, type ModelProvider } from "./index";

function createCore() {
  const database = new KestrelDatabase(":memory:", createEncryptionKey());
  const email = new DevelopmentEmailConnector();
  const calendar = new DevelopmentCalendarConnector();
  const core = new AgentCore({ database, email, calendar, now: () => "2026-07-22T15:00:00.000Z" });
  return { core, email, calendar };
}

describe("teacher scheduling vertical slice", () => {
  it("uses calendar evidence to recommend Monday and waits for approval", () => {
    const { core, email, calendar } = createCore();
    const snapshot = core.snapshot();
    expect(snapshot.approvals[0]?.recommendation).toBe("Monday looks better.");
    expect(snapshot.approvals[0]?.evidence.some((item) => item.value.includes("Swim"))).toBe(true);
    expect(snapshot.approvals[0]?.status).toBe("pending");
    expect(snapshot.modelRouting).toMatchObject({ model: "auto", reasoningEffort: "auto", fastMode: "auto" });
    expect(snapshot.modelRouting.currentDecision).toMatchObject({ model: "local-rules", reasoningEffort: "none", fastMode: false, execution: "local" });
    expect(email.sent.size).toBe(0);
    expect(calendar.events.size).toBe(0);
    core.close();
  });

  it("executes once after approval, verifies providers, and records memory", () => {
    const { core, email, calendar } = createCore();
    const first = core.approve("approval-teacher-monday");
    const second = core.approve("approval-teacher-monday");
    expect(email.sent.size).toBe(1);
    expect(calendar.events.size).toBe(1);
    expect(first.approvals[0]?.status).toBe("executed");
    expect(second.memories.some((item) => item.id === "memory-test-date-decision")).toBe(true);
    expect(second.activity.filter((item) => item.id === "activity-email-sent")).toHaveLength(1);
    core.close();
  });

  it("retrieves prior DJI context and does not repeat failed basics", () => {
    const { core } = createCore();
    const response = core.troubleshoot("RC not connected to mobile device.");
    expect(response).toContain("iOS developer beta");
    expect(response).toContain("another cable already failed");
    expect(response).not.toContain("Try another cable");
    expect(response).not.toContain("restart your phone");
    core.close();
  });
});


describe("core agent request path", () => {
  it("turns model and provider auto-selection into an audited routed run", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let received: { model: string; reasoningEffort?: string; serviceTier?: string } | undefined;
    const provider: ModelProvider = {
      id: "routed-provider", defaultModel: "routed-model",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false },
      complete: async (request) => {
        received = request;
        return { providerId: "routed-provider", model: request.model, text: "Routed", toolCalls: [], usage: { inputTokens: 2, outputTokens: 1 }, finishReason: "stop" };
      }
    };
    const core = new AgentCore({ database, modelProviders: [provider], now: () => "2026-07-22T15:00:00.000Z" });
    const session = core.runtime.ensureMainSession();
    const response = await core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Review this repository architecture", model: "auto", providerIds: ["auto"] });
    expect(response).toMatchObject({ ok: true, routing: { reasoningEffort: "medium" }, run: { model: "auto", providerIds: ["auto"], reasoningEffort: "medium", status: "completed" } });
    expect(received).toMatchObject({ model: "routed-model", reasoningEffort: "medium" });
    await core.close();
  });

  it("creates natural-language schedules through the public request contract", async () => {
    const { core } = createCore();
    const session = core.runtime.ensureMainSession();
    expect(await core.handle({ type: "orchestration-schedule", sessionId: session.id, title: "Morning review", prompt: "Review pending work", model: "local", providerIds: ["ollama"], expression: "tomorrow at 9 am" })).toMatchObject({
      ok: true,
      jobs: [{ title: "Morning review", status: "pending", schedule: { kind: "once", nextRunAt: "2026-07-23T09:00:00.000Z" } }]
    });
    expect(await core.handle({ type: "orchestration-list" })).toMatchObject({ ok: true, jobs: [{ title: "Morning review" }] });
    await core.close();
  });

  it("exposes explicit desktop memory correction and user-model review controls", async () => {
    const { core } = createCore();
    const remembered = await core.handle({ type: "memory-remember", memoryType: "project", content: "Deploy from ops.md", sensitivity: "personal", sourceId: "desktop-user" });
    expect(remembered).toMatchObject({ ok: true, memories: [{ content: "Deploy from ops.md", userConfirmed: true }] });
    if (!remembered.ok || !remembered.memories?.[0]) throw new Error("Memory was not returned.");
    expect(await core.handle({ type: "memory-correct", id: remembered.memories[0].id, content: "Deploy from RELEASE.md", memoryType: "project", sensitivity: "sensitive" }))
      .toMatchObject({ ok: true, memories: [{ content: "Deploy from RELEASE.md", sourceType: "user-correction" }] });
    const proposed = core.userModel.propose({ kind: "boundary", key: "external-messages", value: "Always ask first", sourceIds: ["desktop-user"], confidence: 1, sensitivity: "normal" });
    expect(await core.handle({ type: "memory-user-model-list" })).toMatchObject({ ok: true, userModelFacts: [{ id: proposed.id, status: "proposed" }] });
    expect(await core.handle({ type: "memory-user-model-review", id: proposed.id, decision: "confirm" })).toMatchObject({ ok: true, userModelFacts: [{ status: "confirmed" }] });
    expect(core.userModel.promptContext()).toContain("Always ask first");
    await core.close();
  });

  it("runs a configured provider through the durable agent loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-core-loop-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const provider: ModelProvider = {
      id: "test-provider",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true },
      complete: async (request) => ({
        providerId: "test-provider",
        model: request.model,
        text: "The configured provider path is working.",
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 7 },
        finishReason: "stop"
      })
    };
    const core = new AgentCore({ database, workspaceRoots: [root], modelProviders: [provider], now: () => "2026-07-22T15:00:00.000Z" });
    const sessions = await core.handle({ type: "runtime-list-sessions" });
    if (!sessions.ok || !sessions.sessions?.[0]) throw new Error("Main session missing");
    const response = await core.handle({
      type: "runtime-run-agent",
      sessionId: sessions.sessions[0].id,
      message: "Prove the model path.",
      model: "test-model",
      providerIds: ["test-provider"]
    });
    expect(response).toMatchObject({ ok: true, run: { status: "completed" }, messages: [{ role: "assistant", content: "The configured provider path is working." }] });
    expect(await core.handle({ type: "runtime-session-usage", sessionId: sessions.sessions[0].id })).toMatchObject({ ok: true, usage: { runs: 1, modelCalls: 1, inputTokens: 4, outputTokens: 7, estimatedCostUsd: 0.000039, compactedMessages: 0 } });
    const policyResponse = await core.handle({ type: "runtime-get-usage-policy" });
    expect(policyResponse).toMatchObject({ ok: true, usagePolicy: { dailyBudgetUsd: 25, maximumConcurrentCalls: 4 } });
    if (!policyResponse.ok || !policyResponse.usagePolicy) throw new Error("Usage policy missing");
    expect(await core.handle({ type: "runtime-set-usage-policy", policy: { ...policyResponse.usagePolicy, dailyBudgetUsd: 12 } })).toMatchObject({ ok: true, usagePolicy: { dailyBudgetUsd: 12 } });
    core.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists a user-selected communication personality without changing safety policy", async () => {
    const { core } = createCore();
    const response = await core.handle({ type: "set-personality", personalityId: "concise" });
    expect(response).toMatchObject({ ok: true, snapshot: { personality: { selectedId: "concise" } } });
    expect(core.snapshot().personality.available.map((item) => item.id)).toEqual(["pragmatic", "friendly", "concise"]);
    core.close();
  });

  it("persists custom agents and enforces their model, provider, tool, and memory scopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-custom-agent-"));
    writeFileSync(join(root, "README.md"), "custom agent fixture\n");
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let inspected = false;
    const provider: ModelProvider = {
      id: "scoped-provider",
      capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: true },
      complete: async (request) => {
        expect(request.model).toBe("scoped-model");
        expect(request.tools?.map((tool) => tool.name)).toEqual(["workspace.read"]);
        expect(JSON.stringify(request.messages)).not.toContain("private shared preference");
        inspected = true;
        return { providerId: "scoped-provider", model: request.model, text: "Scoped agent complete.", toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "stop" };
      }
    };
    const core = new AgentCore({ database, workspaceRoots: [root], modelProviders: [provider] });
    const fact = core.userModel.propose({ kind: "preference", key: "private", value: "private shared preference", sourceIds: ["user"], confidence: 1, sensitivity: "normal" });
    core.userModel.review(fact.id, "confirm");
    const created = await core.handle({ type: "create-personality", personality: { id: "reader", name: "Reader", description: "Read-only isolated agent", instructions: "Inspect precisely.", preferredModel: "scoped-model", providerIds: ["scoped-provider"], toolNames: ["workspace.read"], memoryScope: "isolated" } });
    expect(created.ok && created.snapshot?.personality.available.find((item) => item.id === "reader")).toMatchObject({ id: "reader", builtin: false, memoryScope: "isolated" });
    await core.handle({ type: "set-personality", personalityId: "reader" });
    const session = core.runtime.ensureMainSession();
    expect(await core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Inspect", model: "ignored", providerIds: ["ignored"] })).toMatchObject({ ok: true, run: { model: "scoped-model", providerIds: ["scoped-provider"], toolScope: ["workspace.read"] } });
    expect(inspected).toBe(true);
    const encrypted = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("runtime.custom-personalities") as { value_ciphertext: string };
    expect(encrypted.value_ciphertext).not.toContain("Inspect precisely");
    expect(await core.handle({ type: "remove-personality", personalityId: "reader" })).toMatchObject({ ok: true, snapshot: { personality: { selectedId: "pragmatic" } } });
    core.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("streams a configured provider and contains selected attachments to the task workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-core-attachment-"));
    writeFileSync(join(root, "context.txt"), "bounded attachment context\n");
    writeFileSync(join(root, "clip.mp4"), Buffer.from("0000002066747970", "hex"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const deltas: string[] = [];
    let received = "";
    const provider: ModelProvider = {
      id: "attachment-provider",
      capabilities: { streaming: true, tools: true, images: true, audio: true, documents: true, video: true, local: true },
      complete: async (request, call) => {
        received = JSON.stringify(request.messages);
        call?.onEvent?.({ type: "text_delta", delta: "streamed" });
        return { providerId: "attachment-provider", model: request.model, text: "streamed", toolCalls: [], usage: { inputTokens: 3, outputTokens: 1 }, finishReason: "stop" };
      }
    };
    const core = new AgentCore({ database, workspaceRoots: [root], modelProviders: [provider], onAgentTextDelta: (event) => deltas.push(`${event.streamId}:${event.delta}`) });
    const session = core.runtime.ensureMainSession();
    expect(await core.handle({ type: "runtime-list-providers" })).toMatchObject({ ok: true, providers: [{ id: "attachment-provider", capabilities: { documents: true, video: true } }, { id: "auto", capabilities: { documents: true, video: true } }] });
    expect(await core.handle({
      type: "runtime-run-agent", sessionId: session.id, message: "Use the attachment", model: "fixture", providerIds: ["attachment-provider"], streamId: "desktop-stream",
      attachments: [{ path: join(root, "context.txt"), name: "context.txt", mediaType: "text/plain", size: 27 }]
    })).toMatchObject({ ok: true, run: { status: "completed" } });
    expect(received).toContain("bounded attachment context");
    expect(await core.handle({
      type: "runtime-run-agent", sessionId: session.id, message: "Inspect the clip", model: "fixture", providerIds: ["attachment-provider"],
      attachments: [{ path: join(root, "clip.mp4"), name: "clip.mp4", mediaType: "video/mp4", size: 8 }]
    })).toMatchObject({ ok: true, run: { status: "completed" } });
    expect(received).toContain('"type":"video"');
    expect(received).toContain('"mediaType":"video/mp4"');
    expect(deltas).toEqual(["desktop-stream:streamed"]);
    expect(await core.handle({
      type: "runtime-run-agent", sessionId: session.id, message: "Read outside", model: "fixture", providerIds: ["attachment-provider"],
      attachments: [{ path: "/etc/hosts", name: "hosts", mediaType: "text/plain", size: 1 }]
    })).toMatchObject({ ok: false, error: "Attachment escapes the task workspace." });
    await core.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("cancels an active desktop model stream by its stream ID", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const provider: ModelProvider = {
      id: "slow-provider",
      capabilities: { streaming: true, tools: false, images: false, audio: false, documents: false, local: true },
      complete: async (_request, call) => new Promise((_resolve, reject) => {
        started();
        call?.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
      })
    };
    const core = new AgentCore({ database, modelProviders: [provider] });
    const session = core.runtime.ensureMainSession();
    const running = core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Wait", model: "fixture", providerIds: ["slow-provider"], streamId: "cancel-me" });
    await began;
    expect(await core.handle({ type: "runtime-cancel-stream", streamId: "cancel-me" })).toMatchObject({ ok: true, answer: "Cancellation requested." });
    expect(await running).toMatchObject({ ok: false, error: "Cancelled by the user." });
    expect(database.listAgentRuns(session.id)).toMatchObject([{ status: "cancelled" }]);
    await core.close();
  });

  it("cancels an active desktop stream before restoring its session history", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let reportStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      reportStarted = resolvePromise;
    });
    const provider: ModelProvider = {
      id: "rollback-provider",
      capabilities: {
        streaming: true,
        tools: false,
        images: false,
        audio: false,
        documents: false,
        local: true,
      },
      complete: async (_request, call) =>
        new Promise((_resolve, reject) => {
          reportStarted();
          call?.signal?.addEventListener(
            "abort",
            () => reject(call.signal?.reason),
            { once: true },
          );
        }),
    };
    const core = new AgentCore({ database, modelProviders: [provider] });
    const session = core.runtime.ensureMainSession();
    const checkpoint = core.runtime.checkpoint(
      session.id,
      "Before the active request",
    ).checkpoints[0]!;
    const running = core.handle({
      type: "runtime-run-agent",
      sessionId: session.id,
      message: "Wait for the provider",
      model: "fixture",
      providerIds: ["rollback-provider"],
      streamId: "rollback-stream",
    });
    await started;

    expect(
      await core.handle({
        type: "runtime-restore-checkpoint",
        sessionId: session.id,
        checkpointId: checkpoint.id,
      }),
    ).toMatchObject({
      ok: true,
      session: { checkpoints: [checkpoint] },
    });
    expect(await running).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "session history was rolled back",
      ),
    });
    expect(database.listAgentRuns(session.id)).toMatchObject([
      {
        status: "cancelled",
        error:
          "Agent run and any pending approval were invalidated because the session was restored to an earlier checkpoint.",
      },
    ]);
    expect(core.runtime.listMessages(session.id)).toEqual([]);
    expect(
      await core.handle({
        type: "runtime-cancel-stream",
        streamId: "rollback-stream",
      }),
    ).toMatchObject({ ok: true, answer: "Agent stream is not active." });
    await core.close();
  });

  it("transcribes bounded voice data without exposing provider credentials to the request surface", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const core = new AgentCore({ database, transcriptionProvider: { id: "voice-test", transcribe: async ({ data, mediaType }) => ({ text: `${mediaType}:${data.byteLength}`, model: "voice-model", providerRequestId: "voice-1" }) } });
    const encoded = Buffer.from([1, 2, 3, 4]).toString("base64");
    expect(await core.handle({ type: "media-transcribe", dataBase64: encoded, mediaType: "audio/webm" })).toEqual({ ok: true, transcription: { text: "audio/webm:4", model: "voice-model", providerRequestId: "voice-1" } });
    expect(await core.handle({ type: "media-transcribe", dataBase64: "not base64", mediaType: "audio/webm" })).toMatchObject({ ok: false, error: "Voice recording contains invalid base64 data." });
    await core.close();
  });

  it("queues session-owned steering into an active run at the next model boundary", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let began!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const continueFirst = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: ModelProvider = {
      id: "steering-provider",
      capabilities: { streaming: true, tools: false, images: false, audio: false, documents: false, local: true },
      complete: async (request) => {
        calls += 1;
        if (calls === 1) { began(); await continueFirst; return { providerId: "steering-provider", model: request.model, text: "Initial answer", toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "stop" }; }
        expect(request.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Focus on the release path." }] });
        return { providerId: "steering-provider", model: request.model, text: "Updated answer", toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 }, finishReason: "stop" };
      }
    };
    const core = new AgentCore({ database, modelProviders: [provider] });
    const session = core.runtime.ensureMainSession();
    const other = core.runtime.createSession({ title: "Other" });
    const running = core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Start", model: "fixture", providerIds: ["steering-provider"], streamId: "steer-me" });
    await started;
    expect(await core.handle({ type: "runtime-steer-agent", streamId: "steer-me", sessionId: other.id, message: "Hijack" })).toMatchObject({ ok: false, error: "Agent stream is not active for this session." });
    expect(await core.handle({ type: "runtime-steer-agent", streamId: "steer-me", sessionId: session.id, message: "Focus on the release path." })).toMatchObject({ ok: true, answer: "Steering message queued." });
    release();
    expect(await running).toMatchObject({ ok: true, run: { status: "completed", turn: 2 }, messages: [{ content: "Updated answer" }] });
    expect(core.runtime.listMessages(session.id).filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Start", "Focus on the release path."]);
    await core.close();
  });

  it("retries the exact last agent turn from its transcript and mutation baseline", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let calls = 0;
    const provider: ModelProvider = {
      id: "retry-provider",
      capabilities: { streaming: true, tools: false, images: false, audio: false, documents: false, local: true },
      complete: async (request) => {
        calls += 1;
        return {
          providerId: "retry-provider",
          model: request.model,
          text: calls === 1 ? "First answer" : "Retried answer",
          toolCalls: [],
          usage: { inputTokens: 2, outputTokens: 2 },
          finishReason: "stop"
        };
      }
    };
    const core = new AgentCore({ database, modelProviders: [provider], now: () => "2026-07-22T15:00:00.000Z" });
    const session = core.runtime.ensureMainSession();
    expect(await core.handle({ type: "runtime-run-agent", sessionId: session.id, message: "Try this once", model: "fixture", providerIds: ["retry-provider"] }))
      .toMatchObject({ ok: true, messages: [{ content: "First answer" }] });
    expect(await core.handle({ type: "runtime-retry-agent", sessionId: session.id, model: "fixture", providerIds: ["retry-provider"] }))
      .toMatchObject({ ok: true, messages: [{ content: "Retried answer" }] });
    expect(core.runtime.listMessages(session.id).filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Try this once"]);
    expect(core.runtime.listMessages(session.id).filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["Retried answer"]);
    await core.close();
  });

  it("rejects retry before rewinding an active turn in the same session", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let calls = 0;
    let reportActiveStarted: () => void = () => undefined;
    let releaseActive: () => void = () => undefined;
    const activeStarted = new Promise<void>((resolvePromise) => {
      reportActiveStarted = resolvePromise;
    });
    const activeGate = new Promise<void>((resolvePromise) => {
      releaseActive = resolvePromise;
    });
    const provider: ModelProvider = {
      id: "retry-race-provider",
      capabilities: {
        streaming: true,
        tools: false,
        images: false,
        audio: false,
        documents: false,
        local: true,
      },
      complete: async (request) => {
        calls += 1;
        if (calls === 2) {
          reportActiveStarted();
          await activeGate;
        }
        return {
          providerId: "retry-race-provider",
          model: request.model,
          text: calls === 1 ? "Initial answer" : "Active answer",
          toolCalls: [],
          usage: { inputTokens: 2, outputTokens: 2 },
          finishReason: "stop",
        };
      },
    };
    const core = new AgentCore({
      database,
      modelProviders: [provider],
      now: () => "2026-07-22T15:00:00.000Z",
    });
    const session = core.runtime.ensureMainSession();
    await expect(
      core.handle({
        type: "runtime-run-agent",
        sessionId: session.id,
        message: "Initial request",
        model: "fixture",
        providerIds: ["retry-race-provider"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      messages: [{ content: "Initial answer" }],
    });

    const active = core.handle({
      type: "runtime-run-agent",
      sessionId: session.id,
      message: "Active request",
      model: "fixture",
      providerIds: ["retry-race-provider"],
    });
    await activeStarted;
    await expect(
      core.handle({
        type: "runtime-retry-agent",
        sessionId: session.id,
        model: "fixture",
        providerIds: ["retry-race-provider"],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "This session already has an active agent run. Wait for it to finish or stop it before starting another.",
    });
    expect(calls).toBe(2);
    expect(
      core.runtime
        .listMessages(session.id)
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Initial request", "Active request"]);
    expect(
      database
        .listAgentRuns(session.id)
        .map((run) => run.status)
        .sort(),
    ).toEqual(["completed", "running"]);

    releaseActive();
    await expect(active).resolves.toMatchObject({
      ok: true,
      messages: [{ content: "Active answer" }],
    });
    expect(
      core.runtime
        .listMessages(session.id)
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Initial request", "Active request"]);
    await core.close();
  });
});

describe("opportunity governance", () => {
  it("stops work at the configured autonomous depth", () => {
    const engine = new OpportunityEngine();
    const scored = { ...teacherOpportunity, priority: engine.score(teacherOpportunity) };
    expect(engine.canLaunch(scored, { dailyModelCostRemaining: 2, maximumAutonomousDepth: 2, activeTasks: 0, maximumConcurrentTasks: 2 }, 2).allowed).toBe(false);
  });
});
