import { describe, expect, it } from "vitest";
import type { Honcho } from "@honcho-ai/sdk";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import {
  HonchoMemoryProvider,
  installHonchoMemoryTools,
} from "./honcho-memory";

function fixture() {
  const calls = {
    metadata: 0,
    chats: [] as string[],
    messages: [] as Array<{ content: string; peerId: string }>,
  };
  const user = {
    id: "user",
    message: (content: string) => ({ content, peerId: "user" }),
    search: async (query: string) => [
      {
        id: "message-remote",
        content: `Result for ${query}`,
        createdAt: "2026-07-23T12:00:00.000Z",
      },
    ],
  };
  const agent = {
    id: "workstrand",
    message: (content: string) => ({ content, peerId: "workstrand" }),
    chat: async (query: string) => {
      calls.chats.push(query);
      return "The user prefers concise release evidence.";
    },
    getCard: async () => ["Prefers concise release evidence"],
    setCard: async (card: string[]) => card,
    conclusionsOf: () => ({
      create: async ({ content }: { content: string }) => [
        { id: "conclusion-1", content, level: "explicit" },
      ],
      delete: async () => undefined,
    }),
  };
  const session = {
    context: async () => ({
      summary: { content: "This session is about release readiness." },
      peerRepresentation: "The user validates packaged artifacts.",
      peerCard: ["Prefers direct evidence"],
    }),
    addMessages: async (
      messages: Array<{ content: string; peerId: string }>,
    ) => {
      calls.messages.push(...messages);
      return [];
    },
  };
  const client = {
    getMetadata: async () => {
      calls.metadata += 1;
      return { source: "fixture" };
    },
    peer: async (id: string) => (id === "user" ? user : agent),
    session: async () => session,
  } as unknown as Honcho;
  return { calls, client };
}

function enabledConfiguration() {
  return {
    enabled: true,
    baseUrl: "http://127.0.0.1:8000",
    workspaceId: "workstrand-test",
    userPeerId: "user",
    agentPeerId: "workstrand",
    recallMode: "hybrid" as const,
    sessionStrategy: "per-session" as const,
    observationMode: "directional" as const,
    saveMessages: true,
    contextTokens: 1_200,
    contextCadence: 1,
    dialecticCadence: 1,
    dialecticDepth: 2 as const,
    dialecticReasoningLevel: "low" as const,
    reasoningHeuristic: true,
    dialecticMaxChars: 600,
  };
}

describe("opt-in Honcho memory provider", () => {
  it("keeps local memory default, requires a protected cloud key, and permits explicit loopback self-hosting", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const provider = new HonchoMemoryProvider(database);
    expect(provider.status()).toMatchObject({
      state: "disabled",
      credentialConfigured: false,
      syncedMessages: 0,
    });
    expect(() =>
      provider.configure({
        ...enabledConfiguration(),
        baseUrl: "https://api.honcho.dev",
      }),
    ).toThrow("protected Honcho API key");
    expect(() =>
      provider.configure({
        ...enabledConfiguration(),
        baseUrl: "http://192.168.1.2:8000",
      }),
    ).toThrow("HTTPS");
    expect(provider.configure(enabledConfiguration())).toMatchObject({
      state: "ready",
    });
    database.close();
  });

  it("verifies, assembles bounded two-layer context, and syncs attributed messages once", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const { calls, client } = fixture();
    const provider = new HonchoMemoryProvider(
      database,
      undefined,
      () => new Date("2026-07-23T12:00:00.000Z"),
      () => client,
    );
    provider.configure(enabledConfiguration());
    await expect(provider.verify()).resolves.toMatchObject({
      state: "verified",
      lastVerifiedAt: "2026-07-23T12:00:00.000Z",
    });
    const context = await provider.contextFor({
      sessionId: "session-1",
      workspaceRoot: "/private/project",
      query:
        "Please verify the universal package and give me direct release evidence.",
    });
    expect(context).toContain("This session is about release readiness.");
    expect(context).toContain("The user prefers concise release evidence.");
    expect(calls.chats).toHaveLength(2);
    provider.captureMessage({
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "Ship only after the package smoke passes.",
      createdAt: "2026-07-23T12:00:00.000Z",
    });
    provider.captureMessage({
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "Ship only after the package smoke passes.",
      createdAt: "2026-07-23T12:00:00.000Z",
    });
    await provider.flush();
    expect(calls.messages).toEqual([
      {
        content: "Ship only after the package smoke passes.",
        peerId: "user",
      },
    ]);
    expect(provider.status()).toMatchObject({
      syncedMessages: 1,
      lastSyncedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(calls.metadata).toBe(1);
    database.close();
  });

  it("recovers when persisted synced-message state is malformed", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const { calls, client } = fixture();
    const provider = new HonchoMemoryProvider(
      database,
      undefined,
      undefined,
      () => client,
    );
    provider.configure(enabledConfiguration());
    database.setPrivateState("memory.honcho.synced-message-ids", {
      corrupted: true,
    });

    provider.captureMessage({
      id: "message-recovery",
      sessionId: "session-1",
      role: "user",
      content: "Recover this message after malformed local state.",
      createdAt: "2026-07-23T12:00:00.000Z",
    });
    await provider.flush();

    expect(calls.messages).toEqual([
      {
        content: "Recover this message after malformed local state.",
        peerId: "user",
      },
    ]);
    expect(provider.status()).toMatchObject({ syncedMessages: 1 });
    database.close();
  });

  it("registers five remote-memory tools and keeps mutating reasoning behind approval", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const { client } = fixture();
    const provider = new HonchoMemoryProvider(
      database,
      undefined,
      undefined,
      () => client,
    );
    provider.configure({
      ...enabledConfiguration(),
      recallMode: "tools",
    });
    const runtime = new AgentRuntime(database);
    const session = runtime.ensureMainSession();
    installHonchoMemoryTools(runtime, provider, [session.id]);
    expect(
      runtime
        .discoverTools(session.id, "honcho")
        .map((tool) => tool.name),
    ).toEqual([
      "honcho.conclude",
      "honcho.context",
      "honcho.profile",
      "honcho.reasoning",
      "honcho.search",
    ]);
    expect(
      await runtime.callTool(session.id, "honcho.reasoning", {
        query: "What matters?",
      }, { idempotencyKey: "honcho-reason-blocked" }),
    ).toMatchObject({ status: "blocked" });
    expect(
      await runtime.callTool(
        session.id,
        "honcho.reasoning",
        { query: "What matters?" },
        { approvalStatus: "approved", idempotencyKey: "honcho-reason" },
      ),
    ).toMatchObject({
      status: "verified",
      output: {
        answer: "The user prefers concise release evidence.",
        trust: "untrusted_external",
      },
    });
    runtime.close();
    database.close();
  });
});
