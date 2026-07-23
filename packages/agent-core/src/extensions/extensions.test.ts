import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptionKey } from "@kestrel/encryption";
import { KestrelDatabase } from "@kestrel/database";
import { AgentRuntime } from "../runtime";
import { McpClient, McpRuntimeServer, StreamableHttpMcpTransport, bridgeMcpTools, type JsonRpcMessage, type McpTransport } from "./mcp";
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
