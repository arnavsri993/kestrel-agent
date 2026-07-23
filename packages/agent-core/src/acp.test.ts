import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, client } from "@agentclientprotocol/sdk";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentLoop } from "./agent-loop";
import { createKestrelAcpAgent } from "./acp";
import { ProviderPool, type ModelProvider } from "./providers";
import { AgentRuntime } from "./runtime";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("stable ACP v1 editor bridge", () => {
  it("negotiates the official SDK, creates/lists sessions, streams prompts, and closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-acp-"));
    directories.push(root);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database, [root]);
    const provider: ModelProvider = { id: "fake", capabilities: { streaming: true, tools: true, images: true, audio: true, documents: false, local: true }, complete: async (request, call) => { call?.onEvent?.({ type: "text_delta", delta: "Editor result" }); return { providerId: "fake", model: request.model, text: "Editor result", toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "stop" }; } };
    const app = createKestrelAcpAgent({ runtime, loop: new AgentLoop(database, runtime, new ProviderPool([provider])), model: "fake", providerIds: ["fake"] });
    const updates: string[] = [];
    const editor = client({ name: "Test editor" }).onNotification("session/update", ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") updates.push(params.update.content.text);
    });
    await editor.connectWith(app, async (acp) => {
      const initialized = await acp.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "Test editor", version: "1" } });
      expect(initialized).toMatchObject({ protocolVersion: 1, agentInfo: { name: "Workstrand" }, agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } } });
      const session = await acp.request("session/new", { cwd: root, mcpServers: [] });
      expect(await acp.request("session/list", { cwd: root })).toMatchObject({ sessions: [{ sessionId: session.sessionId, cwd: realpathSync(root) }] });
      expect(await acp.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Inspect this project" }] })).toMatchObject({ stopReason: "end_turn" });
      expect(updates).toEqual(["Editor result"]);
      await acp.request("session/close", { sessionId: session.sessionId });
      expect(runtime.getSession(session.sessionId).status).toBe("cancelled");
    });
    database.close();
  });

  it("requests native ACP permission and resumes the same run after approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-acp-permission-"));
    directories.push(root);
    writeFileSync(join(root, "remove.txt"), "remove me\n");
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database, [root]);
    let calls = 0;
    const provider: ModelProvider = {
      id: "fake",
      capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true },
      complete: async (request) => ++calls === 1 ? {
        providerId: "fake", model: request.model, text: "", toolCalls: [{ id: "delete-call", name: "workspace.delete", arguments: { path: "remove.txt" } }],
        usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "tool_calls"
      } : {
        providerId: "fake", model: request.model, text: "Removed with permission.", toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 3 }, finishReason: "stop"
      }
    };
    const app = createKestrelAcpAgent({ runtime, loop: new AgentLoop(database, runtime, new ProviderPool([provider])), model: "fake", providerIds: ["fake"] });
    const permissionRequests: unknown[] = [];
    const updates: string[] = [];
    const editor = client({ name: "Permission editor" })
      .onRequest("session/request_permission", ({ params }) => { permissionRequests.push(params); return { outcome: { outcome: "selected", optionId: "allow-once" } }; })
      .onNotification("session/update", ({ params }) => { updates.push(params.update.sessionUpdate); });
    await editor.connectWith(app, async (acp) => {
      await acp.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "Permission editor", version: "1" } });
      const session = await acp.request("session/new", { cwd: root, mcpServers: [] });
      expect(await acp.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Delete remove.txt" }] })).toMatchObject({ stopReason: "end_turn" });
    });
    expect(permissionRequests).toMatchObject([{ toolCall: { toolCallId: "delete-call", name: "workspace.delete", rawInput: { path: "remove.txt" } }, options: [{ kind: "allow_once" }, { kind: "reject_once" }] }]);
    expect(updates).toContain("tool_call");
    expect(updates).toContain("tool_call_update");
    expect(existsSync(join(root, "remove.txt"))).toBe(false);
    database.close();
  });

  it("delegates contained filesystem and terminal operations to the connected editor", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-acp-delegation-")); directories.push(root); const path = join(root, "editor.txt"); writeFileSync(path, "editor-owned content\n");
    const database = new KestrelDatabase(":memory:", createEncryptionKey()); const runtime = new AgentRuntime(database, [root]);
    const provider: ModelProvider = { id: "fake", capabilities: { streaming: false, tools: false, images: false, audio: false, documents: false, local: true }, complete: async (request) => ({ providerId: "fake", model: request.model, text: "unused", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };
    const app = createKestrelAcpAgent({ runtime, loop: new AgentLoop(database, runtime, new ProviderPool([provider])), model: "fake", providerIds: ["fake"] });
    const written: string[] = []; const terminalRequests: string[] = [];
    const editor = client({ name: "Delegating editor" })
      .onRequest("fs/read_text_file", ({ params }) => ({ content: readFileSync(params.path, "utf8") }))
      .onRequest("fs/write_text_file", ({ params }) => { written.push(`${params.path}:${params.content}`); return {}; })
      .onRequest("terminal/create", ({ params }) => { terminalRequests.push(`${params.command} ${(params.args ?? []).join(" ")}`); return { terminalId: "editor-terminal-1" }; })
      .onRequest("terminal/wait_for_exit", () => ({ exitCode: 0 }))
      .onRequest("terminal/output", () => ({ output: "editor terminal output", truncated: false, exitStatus: { exitCode: 0 } }))
      .onRequest("terminal/release", () => ({}));
    await editor.connectWith(app, async (acp) => {
      await acp.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "Delegating editor", version: "1" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
      const session = await acp.request("session/new", { cwd: root, mcpServers: [] });
      expect(await runtime.callTool(session.sessionId, "editor.fs.read_text", { path })).toMatchObject({ status: "verified", output: { content: "editor-owned content\n" } });
      expect(await runtime.callTool(session.sessionId, "editor.fs.write_text", { path, content: "replacement" }, { approvalStatus: "approved", idempotencyKey: "editor-write" })).toMatchObject({ status: "verified", output: { delegated: true } });
      expect(await runtime.callTool(session.sessionId, "editor.terminal.run", { command: "git", args: ["status"], cwd: root }, { approvalStatus: "approved", idempotencyKey: "editor-terminal" })).toMatchObject({ status: "verified", output: { exitCode: 0, output: "editor terminal output", delegated: true } });
      expect(written).toEqual([`${realpathSync(path)}:replacement`]); expect(terminalRequests).toEqual(["git status"]);
      expect(await runtime.callTool(session.sessionId, "editor.fs.read_text", { path: "/etc/hosts" })).toMatchObject({ status: "failed", error: "Editor-delegated path escapes the session workspace." });
      await acp.request("session/close", { sessionId: session.sessionId });
    });
    database.close();
  });

  it("hands ACP-provided stdio MCP servers into the session tool catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-acp-mcp-")); directories.push(root); const serverPath = join(root, "mcp-fixture.mjs");
    writeFileSync(serverPath, "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)return;const line=b.slice(0,i);b=b.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo from editor MCP',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:'mcp:'+m.params.arguments.text}],isError:false};if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}});\n");
    const database = new KestrelDatabase(":memory:", createEncryptionKey()); const runtime = new AgentRuntime(database, [root]);
    const provider: ModelProvider = { id: "fake", capabilities: { streaming: false, tools: false, images: false, audio: false, documents: false, local: true }, complete: async (request) => ({ providerId: "fake", model: request.model, text: "unused", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };
    const app = createKestrelAcpAgent({ runtime, loop: new AgentLoop(database, runtime, new ProviderPool([provider])), model: "fake", providerIds: ["fake"] }); const editor = client({ name: "MCP editor" });
    await editor.connectWith(app, async (acp) => {
      await acp.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "MCP editor", version: "1" } });
      const session = await acp.request("session/new", { cwd: root, mcpServers: [{ name: "fixture", command: process.execPath, args: [serverPath], env: [] }] });
      const tool = runtime.discoverTools(session.sessionId, "echo").find((candidate) => candidate.source === "mcp"); expect(tool?.name).toContain(".echo");
      expect(await runtime.callTool(session.sessionId, tool!.name, { text: "hello" }, { approvalStatus: "approved", idempotencyKey: "mcp-echo" })).toMatchObject({ status: "verified", output: { content: [{ type: "text", text: "mcp:hello" }] } });
      await acp.request("session/close", { sessionId: session.sessionId });
    });
    database.close();
  });
});
