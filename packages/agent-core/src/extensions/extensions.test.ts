import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptionKey } from "@kestrel/encryption";
import { KestrelDatabase } from "@kestrel/database";
import { AgentRuntime } from "../runtime";
import {
  MCP_PROTOCOL_VERSION,
  McpClient,
  McpRuntimeServer,
  StdioMcpTransport,
  StreamableHttpMcpTransport,
  bridgeMcpTools,
  type JsonRpcMessage,
  type McpTransport,
} from "./mcp";
import { SkillRegistry, installSkillTools } from "./skills";
import { SkillLearningManager } from "./skill-learning";
import { PluginRegistry } from "./plugins";
import { PluginMcpManager } from "./plugin-mcp";
import { AgentCore } from "../index";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class LoopbackTransport implements McpTransport {
  private listeners = new Set<(message: JsonRpcMessage) => void>();
  constructor(private readonly server: McpRuntimeServer) {}
  async send(message: JsonRpcMessage): Promise<void> {
    const response = await this.server.handle(message);
    if (response) queueMicrotask(() => this.listeners.forEach((listener) => listener(response)));
  }
  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onError(): () => void { return () => undefined; }
  close(): void { this.listeners.clear(); }
}

class ControlledTransport implements McpTransport {
  readonly sent: JsonRpcMessage[] = [];
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
    if ("method" in message && "id" in message && message.method === "initialize") {
      queueMicrotask(() => this.emit({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: MCP_PROTOCOL_VERSION },
      }));
    }
  }

  emit(message: JsonRpcMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(): () => void { return () => undefined; }
  close(): void { this.listeners.clear(); }
}

function runtimeFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `kestrel-${label}-`));
  directories.push(root);
  writeFileSync(join(root, "README.md"), `# ${label}\n`);
  const database = new KestrelDatabase(":memory:", createEncryptionKey());
  const runtime = new AgentRuntime(database, [root], () => "2026-07-22T19:00:00.000Z");
  const session = runtime.createSession({ title: label, workspaceRoot: root });
  return { root, database, runtime, session };
}

describe("MCP extensions", () => {
  it("uses Streamable HTTP sessions and exposes resources and prompts", async () => {
    let sessionHeader = "";
    let deleted = false;
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
      sessionHeader = new Headers(init?.headers).get("mcp-session-id") ?? sessionHeader;
      if (!request.id) return new Response(null, { status: 202, headers: { "mcp-session-id": "session-http" } });
      const result = request.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } }
        : request.method === "resources/list" ? { resources: [{ uri: "file:///guide", name: "Guide" }] }
          : request.method === "resources/read" ? { contents: [{ uri: "file:///guide", text: "safe" }] }
            : request.method === "prompts/list" ? { prompts: [{ name: "review" }] }
              : { description: "Review", messages: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "session-http" } });
    };
    const transport = new StreamableHttpMcpTransport("https://mcp.example.test/rpc", { fetcher, authorization: "Bearer protected" });
    const client = new McpClient(transport);
    await client.initialize();
    expect(await client.listResources()).toMatchObject([{ uri: "file:///guide" }]);
    expect(await client.readResource("file:///guide")).toMatchObject({ contents: [{ text: "safe" }] });
    expect(await client.listPrompts()).toMatchObject([{ name: "review" }]);
    expect(await client.getPrompt("review")).toMatchObject({ description: "Review" });
    expect(sessionHeader).toBe("session-http");
    await client.close();
    expect(deleted).toBe(true);
  });

  it("negotiates the current lifecycle, lists tools, and calls a runtime tool", async () => {
    const fixture = runtimeFixture("mcp-server");
    const client = new McpClient(new LoopbackTransport(new McpRuntimeServer(fixture.runtime, fixture.session.id)));
    const initialized = await client.initialize();
    expect(initialized.protocolVersion).toBe("2025-11-25");
    const tools = await client.listTools();
    expect(tools.some((tool) => tool.name === "workspace.read")).toBe(true);
    const result = await client.callTool("workspace.read", { path: "README.md" });
    expect(result).toMatchObject({ isError: false, structuredContent: { content: expect.stringContaining("mcp-server") } });
    await client.close();
    fixture.database.close();
  });

  it("does not send a tool request for an already-aborted signal", async () => {
    const transport = new ControlledTransport();
    const client = new McpClient(transport);
    await client.initialize();
    const sentBeforeCall = transport.sent.length;
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));

    await expect(client.callTool("workspace.read", {}, controller.signal))
      .rejects.toThrow("cancelled before dispatch");
    expect(transport.sent).toHaveLength(sentBeforeCall);
    await client.close();
  });

  it("rejects an aborted tool request locally and cancels its exact request id", async () => {
    const transport = new ControlledTransport();
    const client = new McpClient(transport);
    await client.initialize();
    const controller = new AbortController();
    const call = client.callTool("workspace.read", { path: "README.md" }, controller.signal);
    const request = transport.sent.find(
      (message) => "method" in message && message.method === "tools/call" && "id" in message,
    );
    if (!request || !("method" in request) || !("id" in request)) {
      throw new Error("Expected an in-flight MCP tool request.");
    }
    const rejected = expect(call).rejects.toThrow("cancelled in flight");

    controller.abort(new Error("cancelled in flight"));

    await rejected;
    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId: request.id,
        reason: "Cancelled by Kestrel",
      },
    });
    transport.emit({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "too late" }] },
    });
    await client.close();
  });

  it("filters and rejects tool calls when a runtime server has read-only access", async () => {
    const fixture = runtimeFixture("mcp-read-only");
    const server = new McpRuntimeServer(fixture.runtime, fixture.session.id);
    const access = { allowMutatingTools: false };
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, access);
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, access);
    const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, access) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.some((tool) => tool.name === "workspace.read")).toBe(true);
    expect(listed.result.tools.some((tool) => tool.name === "workspace.write")).toBe(false);
    const read = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workspace.read", arguments: { path: "README.md" } }
    }, access);
    expect(read).toMatchObject({ result: { isError: false } });
    const called = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace.write", arguments: { path: "blocked.txt", content: "must not be written" } }
    }, access);
    expect(called).toMatchObject({ error: { message: expect.stringContaining("task authorization") } });
    expect(existsSync(join(fixture.root, "blocked.txt"))).toBe(false);
    fixture.database.close();
  });

  it("rejects failed async sends immediately without leaking an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const transport: McpTransport = {
      send: async () => { throw new Error("wire down"); },
      onMessage: () => () => undefined,
      onError: () => () => undefined,
      close: () => undefined
    };
    const client = new McpClient(transport, 10_000);
    try {
      await expect(client.initialize()).rejects.toThrow("wire down");
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await client.close();
    }
  });

  it("contains a rejected timeout-cancellation send", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let sends = 0;
    const transport: McpTransport = {
      send: () => {
        sends += 1;
        return sends === 1 ? undefined : Promise.reject(new Error("cancellation wire down"));
      },
      onMessage: () => () => undefined,
      onError: () => () => undefined,
      close: () => undefined
    };
    const client = new McpClient(transport, 5);
    try {
      await expect(client.initialize()).rejects.toThrow("timed out");
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await client.close();
    }
  });

  it("rejects all pending work on a transport error and closes idempotently", async () => {
    let reportError: ((error: Error) => void) | undefined;
    let closes = 0;
    const transport: McpTransport = {
      send: () => undefined,
      onMessage: () => () => undefined,
      onError: (listener) => { reportError = listener; return () => { reportError = undefined; }; },
      close: () => { closes += 1; }
    };
    const client = new McpClient(transport, 10_000);
    const initializing = client.initialize();
    reportError?.(new Error("stdio framing failed"));
    await expect(initializing).rejects.toThrow("stdio framing failed");
    const firstClose = client.close();
    expect(client.close()).toBe(firstClose);
    await firstClose;
    expect(closes).toBe(1);
  });

  it.each([
    ["malformed stdout", "process.stdout.write('not-json\\n');setTimeout(()=>{},10000)", "invalid JSON"],
    ["oversized stderr record", "process.stderr.write('x'.repeat(1000001));setTimeout(()=>{},10000)", "stderr record exceeded 1 MB"],
    ["abusive stderr burst", "process.stderr.write(('x'.repeat(999) + '\\n').repeat(2100));setTimeout(()=>{},10000)", "stderr burst exceeded 1 MB"]
  ])("turns %s from a stdio server into a bounded client error", async (_label, source, expected) => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-mcp-stdio-"));
    directories.push(root);
    const client = new McpClient(new StdioMcpTransport({ command: process.execPath, args: ["-e", source], cwd: root }), 5_000);
    await expect(client.initialize()).rejects.toThrow(expected);
    await client.close();
  });

  it("allows bounded diagnostic lines to exceed 1 MB over a long-lived stdio session", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-mcp-stderr-"));
    directories.push(root);
    const source = [
      "let count = 0;",
      "const timer = setInterval(() => {",
      "  process.stderr.write('x'.repeat(99999) + '\\n');",
      "  count += 1;",
      "  if (count === 12) clearInterval(timer);",
      "}, 125);",
      "setTimeout(() => {}, 10000);",
    ].join("\n");
    const transport = new StdioMcpTransport({
      command: process.execPath,
      args: ["-e", source],
      cwd: root,
    });
    let failure: Error | undefined;
    transport.onError((error) => {
      failure = error;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_700));
    expect(failure).toBeUndefined();
    await transport.close();
  });

  it("rejects oversized outbound stdio messages before writing them", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-mcp-stdio-outbound-"));
    directories.push(root);
    const transport = new StdioMcpTransport({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: root,
    });

    await expect(transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { payload: "x".repeat(1_000_000) }
    })).rejects.toThrow("MCP stdio message exceeds 1 MB");
    await transport.close();
  });

  it("bridges remote MCP tools into a session as sensitive untrusted tools", async () => {
    const source = runtimeFixture("source");
    const target = runtimeFixture("target");
    const client = new McpClient(new LoopbackTransport(new McpRuntimeServer(source.runtime, source.session.id)));
    const names = await bridgeMcpTools(client, target.runtime, target.session.id, "source");
    expect(names).toContain("mcp.source.workspace.read");
    const execution = await target.runtime.callTool(
      target.session.id,
      "mcp.source.workspace.read",
      { path: "README.md" },
      { approvalStatus: "approved", idempotencyKey: "mcp-read" }
    );
    expect(execution).toMatchObject({ status: "verified", output: { structuredContent: { content: expect.stringContaining("source") } } });
    await client.close();
    source.database.close();
    target.database.close();
  });
});

describe("Agent Skills extensions", () => {
  it("uses metadata-first discovery, full activation, and contained resource reads", async () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-skills-"));
    directories.push(container);
    const skillRoot = join(container, "code-review");
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), [
      "---",
      "name: code-review",
      "description: Review code for correctness and explain actionable findings.",
      "license: MIT",
      "metadata:",
      "  author: kestrel-test",
      "---",
      "",
      "Inspect the diff before making claims."
    ].join("\n"));
    writeFileSync(join(skillRoot, "references", "CHECKLIST.md"), "Check correctness, safety, and tests.\n");
    writeFileSync(join(container, "secret.txt"), "outside skill\n");
    const registry = new SkillRegistry([container]);
    const discovered = registry.discover();
    expect(discovered).toMatchObject([{ name: "code-review", description: expect.stringContaining("Review code"), metadata: { author: "kestrel-test" } }]);
    expect(discovered[0]).not.toHaveProperty("instructions");
    expect(registry.activate("code-review").instructions).toContain("Inspect the diff");
    expect(registry.readResource("code-review", "references/CHECKLIST.md").content).toContain("correctness");
    expect(() => registry.readResource("code-review", "../secret.txt")).toThrow("escapes its skill root");

    const fixture = runtimeFixture("skills");
    installSkillTools(fixture.runtime, registry, fixture.session.id);
    const listed = await fixture.runtime.callTool(fixture.session.id, "skills.list", {});
    expect(listed).toMatchObject({ status: "verified", output: { skills: [{ name: "code-review" }] } });
    expect(await fixture.runtime.callTool(fixture.session.id, "skills.list", { query: "correctness review" })).toMatchObject({ output: { skills: [{ name: "code-review", relevance: expect.any(Number) }] } });
    expect(await fixture.runtime.callTool(fixture.session.id, "skills.list", { query: "calendar travel" })).toMatchObject({ output: { skills: [] } });
    const activated = await fixture.runtime.callTool(fixture.session.id, "skills.activate", { name: "code-review" });
    expect(activated.output?.instructions).toContain("Inspect the diff");
    fixture.database.close();
  });

  it("turns provenance-backed experience into reviewable, validated, feedback-informed learned skills", () => {
    const learnedRoot = mkdtempSync(join(tmpdir(), "kestrel-learned-skills-"));
    directories.push(learnedRoot);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const source = runtime.createSession({ title: "Learning source" });
    const firstSource = runtime.appendMessage({ sessionId: source.id, role: "user", content: "Remember the release verification steps." });
    const secondSource = runtime.appendMessage({ sessionId: source.id, role: "assistant", content: "The packaged executable also needs verification." });
    const registry = new SkillRegistry([learnedRoot]);
    const manager = new SkillLearningManager(database, learnedRoot, registry, () => new Date("2026-07-22T23:00:00.000Z"));
    const proposal = manager.propose({ name: "release-check", description: "Verify a release before publishing.", instructions: "Run the build and verify its checksums before publishing.", sourceSessionId: source.id, sourceMessageIds: [firstSource.id, secondSource.id] });
    expect(proposal).toMatchObject({ status: "proposed", evaluation: { valid: true, checks: expect.arrayContaining(["isolated Agent Skills parse passed"]) } });
    expect(registry.list()).toEqual([]);
    expect(manager.review(proposal.id, "install").status).toBe("installed");
    expect(registry.activate("release-check").instructions).toContain("verify its checksums");
    const feedback = manager.feedback({ skillName: "release-check", succeeded: false, feedback: "Also verify the packaged executable.", sourceIds: ["run-1"] });
    expect(feedback.succeeded).toBe(false);
    const revision = manager.propose({ name: "release-check", description: "Verify a release before publishing.", instructions: "Run the build, packaged executable, and checksum verification before publishing.", sourceSessionId: source.id, sourceMessageIds: [secondSource.id] });
    expect(revision.evaluation.checks).toContain("1 prior feedback records available");
    manager.review(revision.id, "install");
    expect(registry.activate("release-check").instructions).toContain("packaged executable");
    const encrypted = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("skills.learning.proposals") as { value_ciphertext: string };
    expect(encrypted.value_ciphertext).not.toContain("packaged executable");
    expect(() => manager.propose({ name: "unsafe", description: "Unsafe", instructions: "Use sk-example0123456789012345", sourceSessionId: source.id, sourceMessageIds: [firstSource.id] })).toThrow("credential");
    database.close();
  });

  it("turns a completed session into a reviewable workflow proposal without copying tool output", () => {
    const learnedRoot = mkdtempSync(join(tmpdir(), "kestrel-learned-skill-suggestion-"));
    directories.push(learnedRoot);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database, [], () => "2026-07-22T23:00:00.000Z");
    const source = runtime.createSession({ title: "Weekly release notes" });
    const user = runtime.appendMessage({ sessionId: source.id, role: "user", content: "Prepare the weekly release notes." });
    runtime.appendMessage({ sessionId: source.id, role: "tool", toolName: "workspace.read", content: "PRIVATE_TOOL_OUTPUT_SHOULD_NOT_BE_COPIED" });
    const assistant = runtime.appendMessage({ sessionId: source.id, role: "assistant", content: "The release notes are ready." });
    database.saveAgentRun({ id: "run-suggest", sessionId: source.id, model: "test-model", providerIds: ["test"], status: "completed", turn: 1, createdAt: "2026-07-22T22:59:00.000Z", updatedAt: "2026-07-22T23:00:00.000Z" });
    const manager = new SkillLearningManager(database, learnedRoot, new SkillRegistry([learnedRoot]), () => new Date("2026-07-22T23:00:00.000Z"));
    const proposal = manager.suggestForSession(source.id);
    expect(proposal).toMatchObject({ name: "prepare-the-weekly-release-notes", status: "proposed", sourceSessionId: source.id, sourceMessageIds: [user.id, expect.any(String), assistant.id] });
    expect(proposal.instructions).toContain("workspace.read");
    expect(proposal.instructions).not.toContain("PRIVATE_TOOL_OUTPUT_SHOULD_NOT_BE_COPIED");
    database.close();
  });
});

describe("Codex-compatible plugin manifests", () => {
  it("discovers Camarade-shaped manifests, persists enablement, and exposes enabled skill roots", () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-plugins-"));
    directories.push(container);
    const pluginRoot = join(container, "camarade", "0.1.0-test");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, "skills", "improve-coding-prompt"), { recursive: true });
    writeFileSync(join(pluginRoot, "skills", "improve-coding-prompt", "SKILL.md"), "---\nname: improve-coding-prompt\ndescription: Improve rough coding prompts with repository context.\n---\n\nInspect the repository first.\n");
    writeFileSync(join(pluginRoot, ".mcp.json"), "{}\n");
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "camarade",
      version: "0.1.0-test",
      description: "Turn rough coding requests into repository-aware tasks.",
      author: { name: "Camarade contributors", url: "https://example.test" },
      license: "MIT",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: { displayName: "Camarade", capabilities: ["Read"], defaultPrompt: ["Improve this request."] }
    }));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const registry = new PluginRegistry([container], database);
    expect(registry.discover()).toMatchObject([{ name: "camarade", version: "0.1.0-test", enabled: false, interface: { displayName: "Camarade" } }]);
    expect(registry.summary()).toMatchObject([{ name: "camarade", hasSkills: true, hasMcpServers: true }]);
    expect(registry.skillRoots()).toEqual([]);
    registry.setEnabled("camarade", true);
    expect(registry.skillRoots()).toEqual([realpathSync(join(pluginRoot, "skills"))]);
    expect(new PluginRegistry([container], database).discover()[0]?.enabled).toBe(true);
    database.close();
  });

  it("enforces declared plugin dependency versions and enable order", () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-plugin-dependencies-"));
    directories.push(container);
    for (const [name, manifest] of Object.entries({ base: { name: "base", version: "1.2.0", description: "Base plugin" }, dependent: { name: "dependent", version: "1.0.0", description: "Dependent plugin", dependencies: { base: "1.2.0" } } })) {
      const root = join(container, name);
      mkdirSync(join(root, ".codex-plugin"), { recursive: true });
      writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
    }
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const registry = new PluginRegistry([container], database);
    registry.discover();
    expect(() => registry.setEnabled("dependent", true)).toThrow("Enable dependency base");
    registry.setEnabled("base", true);
    expect(registry.setEnabled("dependent", true).enabled).toBe(true);
    expect(() => registry.setEnabled("base", false)).toThrow("Disable dependent plugin dependent");
    registry.setEnabled("dependent", false);
    expect(registry.setEnabled("base", false).enabled).toBe(false);
    database.close();
  });

  it("loads strict declarative dashboard panels without executable renderer code", () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-plugin-dashboard-"));
    directories.push(container);
    const pluginRoot = join(container, "release-ops");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "dashboard.json"),
      JSON.stringify({
        version: 1,
        title: "Release operations",
        description: "A bounded view of release readiness.",
        navigationLabel: "Release ops",
        panels: [
          {
            id: "delivery",
            title: "Delivery",
            description: "Check the live release boundary.",
            tone: "accent",
            metrics: [
              { label: "Agent", source: "agent-state" },
              { label: "Sessions", source: "runtime-sessions" },
              { label: "Version", source: "plugin-version" },
            ],
            items: ["Verify the package before publishing."],
            actions: [
              { label: "Open readiness", page: "readiness" },
              { label: "Review artifacts", page: "artifacts" },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "release-ops",
        version: "1.0.0",
        description: "Release operations.",
        dashboard: "./dashboard.json",
      }),
    );
    const registry = new PluginRegistry([container]);
    expect(registry.discover()[0]).toMatchObject({
      name: "release-ops",
      dashboard: {
        title: "Release operations",
        panels: [
          expect.objectContaining({
            id: "delivery",
            metrics: expect.arrayContaining([
              expect.objectContaining({ source: "agent-state" }),
            ]),
            actions: expect.arrayContaining([
              expect.objectContaining({ page: "readiness" }),
            ]),
          }),
        ],
      },
    });
    expect(registry.summary()).toMatchObject([
      { name: "release-ops", hasDashboard: true },
    ]);
  });

  it("rejects dashboard contributions with unknown fields or unsafe navigation", () => {
    const container = mkdtempSync(
      join(tmpdir(), "kestrel-plugin-dashboard-invalid-"),
    );
    directories.push(container);
    const pluginRoot = join(container, "unsafe-dashboard");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "dashboard.json"),
      JSON.stringify({
        version: 1,
        title: "Unsafe",
        description: "Attempts executable behavior.",
        script: "fetch('https://example.test')",
        panels: [
          {
            id: "unsafe",
            title: "Unsafe",
            actions: [{ label: "Run", page: "https://example.test" }],
          },
        ],
      }),
    );
    writeFileSync(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "unsafe-dashboard",
        version: "1.0.0",
        description: "Unsafe dashboard fixture.",
        dashboard: "./dashboard.json",
      }),
    );
    expect(() => new PluginRegistry([container]).discover()).toThrow();
  });

  it("connects explicitly approved plugin MCP servers and removes their tools on disconnect", async () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-plugin-mcp-"));
    directories.push(container);
    const pluginRoot = join(container, "example", "1.0.0");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, "mcp"), { recursive: true });
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "example", version: "1.0.0", description: "Example MCP plugin.", mcpServers: "./.mcp.json" }));
    writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { example: { command: "node", args: ["./mcp/server.mjs"], cwd: "." } } }));
    writeFileSync(join(pluginRoot, "mcp", "server.mjs"), [
      "import readline from 'node:readline';",
      "const lines = readline.createInterface({ input: process.stdin });",
      "lines.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}})+'\\n');",
      "  else if (message.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}})+'\\n');",
      "  else if (message.method === 'tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:String(message.params.arguments.text)}],structuredContent:{text:String(message.params.arguments.text)}}})+'\\n');",
      "});"
    ].join("\n"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const registry = new PluginRegistry([container], database);
    registry.discover();
    registry.setEnabled("example", true);
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Plugin MCP" });
    const manager = new PluginMcpManager(registry, runtime);
    expect(await manager.connect("example", session.id)).toMatchObject([{ pluginName: "example", serverName: "example", toolNames: ["mcp.example.example.echo"] }]);
    const blocked = await runtime.callTool(session.id, "mcp.example.example.echo", { text: "hello" }, { idempotencyKey: "echo" });
    expect(blocked.status).toBe("blocked");
    const called = await runtime.callTool(session.id, "mcp.example.example.echo", { text: "hello" }, { approvalStatus: "approved", idempotencyKey: "echo" });
    expect(called).toMatchObject({ status: "verified", output: { structuredContent: { text: "hello" } } });
    const secondSession = runtime.createSession({ title: "Second plugin session" });
    manager.attachSession(secondSession.id);
    expect(runtime.discoverTools(secondSession.id).some((tool) => tool.name === "mcp.example.example.echo")).toBe(true);
    expect(await manager.connect("example", secondSession.id)).toMatchObject([{ toolNames: ["mcp.example.example.echo"] }]);
    await manager.disconnect("example");
    expect(runtime.discoverTools(session.id).some((tool) => tool.name === "mcp.example.example.echo")).toBe(false);
    expect(runtime.discoverTools(secondSession.id).some((tool) => tool.name === "mcp.example.example.echo")).toBe(false);
    database.close();
  });

  it("rejects plugin-controlled process loader environment variables", async () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-plugin-mcp-env-"));
    directories.push(container);
    const pluginRoot = join(container, "unsafe", "1.0.0");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, "mcp"), { recursive: true });
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "unsafe", version: "1.0.0", description: "Unsafe MCP environment fixture.", mcpServers: "./.mcp.json" }));
    writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { unsafe: { command: "node", args: ["./mcp/server.mjs"], env: { NODE_OPTIONS: "--import ./mcp/server.mjs" } } } }));
    writeFileSync(join(pluginRoot, "mcp", "server.mjs"), "process.stdin.resume();\n");
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const registry = new PluginRegistry([container], database);
    registry.discover();
    registry.setEnabled("unsafe", true);
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Unsafe plugin MCP" });
    const manager = new PluginMcpManager(registry, runtime);
    await expect(manager.connect("unsafe", session.id)).rejects.toThrow("NODE_OPTIONS is not allowed");
    database.close();
  });

  it("enables a discovered Camarade bundle through the core and refreshes skills without restart", async () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-plugin-core-"));
    directories.push(container);
    const pluginRoot = join(container, "camarade", "0.1.0+codex.test");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, "skills", "improve-coding-prompt"), { recursive: true });
    writeFileSync(join(pluginRoot, "skills", "improve-coding-prompt", "SKILL.md"), "---\nname: improve-coding-prompt\ndescription: Improve rough coding prompts with repository context.\n---\n\nInspect the repository first.\n");
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "camarade", version: "0.1.0+codex.test", description: "Repository-aware prompt improvement.", skills: "./skills/", interface: { displayName: "Camarade", capabilities: ["Read"], defaultPrompt: [] } }));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const core = new AgentCore({ database, pluginRoots: [container] });
    expect(await core.handle({ type: "plugin-list" })).toMatchObject({ ok: true, plugins: [{ name: "camarade", enabled: false, version: "0.1.0+codex.test" }] });
    expect(core.skillRegistry?.list()).toEqual([]);
    expect(await core.handle({ type: "plugin-set-enabled", name: "camarade", enabled: true })).toMatchObject({ ok: true, plugins: [{ name: "camarade", enabled: true }] });
    expect(core.skillRegistry?.list()).toMatchObject([{ name: "improve-coding-prompt" }]);
    const main = core.runtime.ensureMainSession();
    expect(await core.runtime.callTool(main.id, "skills.list", {})).toMatchObject({ status: "verified", output: { skills: [{ name: "improve-coding-prompt" }] } });
    core.close();
  });
});
