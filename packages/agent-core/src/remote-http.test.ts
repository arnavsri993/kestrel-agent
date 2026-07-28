import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentLoop } from "./agent-loop";
import { TaskOrchestrator } from "./orchestration";
import { ProviderPool, type ModelProvider } from "./providers";
import { RemoteControl } from "./remote";
import { RemoteHttpServer } from "./remote-http";
import { AgentRuntime } from "./runtime";
import type { JsonRpcMessage } from "./extensions/mcp";
import { ChannelGateway, signChannelEnvelope, type ChannelEnvelope } from "./channels";
import { PresenceManager } from "./presence";
import { TrustedProxyAuthorizer } from "./gateway-networking";
import { NativeNodeManager } from "./native-nodes";

const servers: RemoteHttpServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const provider: ModelProvider = { id: "fake", capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true }, complete: async (request) => ({ providerId: "fake", model: request.model, text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };

function fixture() {
  const database = new KestrelDatabase(":memory:", createEncryptionKey());
  const runtime = new AgentRuntime(database);
  const session = runtime.createSession({ title: "Remote HTTP" });
  const orchestrator = new TaskOrchestrator(database, runtime, new AgentLoop(database, runtime, new ProviderPool([provider])));
  const remote = new RemoteControl(database, runtime, orchestrator);
  return { database, runtime, session, remote };
}

describe("authenticated remote HTTP transport", () => {
  it("keeps read-only MCP sessions non-mutating and rechecks task scope after initialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-remote-mcp-"));
    directories.push(root);
    writeFileSync(join(root, "README.md"), "read scope fixture\n");
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database, [root]);
    const session = runtime.createSession({ title: "Scoped remote MCP", workspaceRoot: root });
    const orchestrator = new TaskOrchestrator(database, runtime, new AgentLoop(database, runtime, new ProviderPool([provider])));
    const remote = new RemoteControl(database, runtime, orchestrator);
    const server = new RemoteHttpServer({ remote, runtime, host: "127.0.0.1" });
    servers.push(server);
    const { origin } = await server.start();

    const pair = async (label: string, scopes: Array<"read" | "tasks" | "approve">) => {
      const pairing = remote.beginPairing(label, scopes);
      const response = await fetch(`${origin}/v1/pairings/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingId: pairing.pairingId, code: pairing.code })
      });
      expect(response.status).toBe(200);
      return await response.json() as { deviceId: string; token: string };
    };
    const mcp = (token: string, message: JsonRpcMessage) => fetch(`${origin}/v1/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-kestrel-session-id": session.id },
      body: JSON.stringify(message)
    });
    const initialize = async (token: string) => {
      expect((await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(200);
      expect((await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    };

    const readOnly = await pair("Read-only browser", ["read"]);
    await initialize(readOnly.token);
    const readToolsResponse = await mcp(readOnly.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const readTools = await readToolsResponse.json() as { result: { tools: Array<{ name: string }> } };
    expect(readTools.result.tools.some((tool) => tool.name === "workspace.read")).toBe(true);
    expect(readTools.result.tools.some((tool) => tool.name === "workspace.write")).toBe(false);
    const read = await mcp(readOnly.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workspace.read", arguments: { path: "README.md" } }
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ result: { isError: false } });
    const blocked = await mcp(readOnly.token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace.write", arguments: { path: "blocked.txt", content: "scope bypass" } }
    });
    expect(blocked.status).toBe(401);
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);

    const taskDevice = await pair("Task browser", ["read", "tasks"]);
    await initialize(taskDevice.token);
    const taskTools = await (await mcp(taskDevice.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
    expect(taskTools.result.tools.some((tool) => tool.name === "workspace.write")).toBe(true);
    const written = await mcp(taskDevice.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workspace.write", arguments: { path: "allowed.txt", content: "task scope" } }
    });
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ result: { isError: false } });
    expect(readFileSync(join(root, "allowed.txt"), "utf8")).toBe("task scope");

    remote.revoke(taskDevice.deviceId);
    const revoked = await mcp(taskDevice.token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace.write", arguments: { path: "revoked.txt", content: "must not run" } }
    });
    expect(revoked.status).toBe(401);
    expect(existsSync(join(root, "revoked.txt"))).toBe(false);
    database.close();
  });

  it("pairs a device, enforces bearer scopes, redacts jobs, and streams runtime events", async () => {
    const { database, runtime, session, remote } = fixture();
    const pairing = remote.beginPairing("Browser client", ["read", "tasks"]);
    const presence = new PresenceManager(() => new Date("2026-07-23T10:00:00.000Z"));
    const nativeNodes = new NativeNodeManager(() => new Date("2026-07-23T10:00:00.000Z"));
    const server = new RemoteHttpServer({ remote, runtime, presence, nativeNodes, host: "127.0.0.1", allowedOrigins: ["https://control.example"], prometheusMetrics: () => "# TYPE workstrand_sessions_total counter\nworkstrand_sessions_total 1\n" });
    servers.push(server);
    const { origin } = await server.start();
    const application = await fetch(`${origin}/app/`);
    expect(application.status).toBe(200);
    expect(application.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await application.text()).toContain("Pair this device");
    expect(await (await fetch(`${origin}/app/manifest.webmanifest`)).json()).toMatchObject({ name: "Kestrel Remote", display: "standalone", start_url: "/app/" });
    expect(await (await fetch(`${origin}/app/app.js`)).text()).toContain("sessionStorage.getItem('kestrel-token')");
    expect(await fetch(`${origin}/v1/sessions`)).toMatchObject({ status: 401 });
    const paired = await fetch(`${origin}/v1/pairings/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingId: pairing.pairingId, code: pairing.code }) });
    expect(paired.status).toBe(200);
    const device = await paired.json() as { token: string };
    const headers = { authorization: `Bearer ${device.token}` };
    expect((await fetch(`${origin}/v1/diagnostics/prometheus`)).status).toBe(401);
    const metrics = await fetch(`${origin}/v1/diagnostics/prometheus`, { headers });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await metrics.text()).toContain("workstrand_sessions_total 1");
    const sessions = await fetch(`${origin}/v1/sessions`, { headers });
    expect(await sessions.json()).toMatchObject({ sessions: [{ id: session.id, title: "Remote HTTP" }] });
    expect(JSON.stringify(await (await fetch(`${origin}/v1/sessions`, { headers })).json())).not.toContain("workspaceRoot");
    expect((await fetch(`${origin}/v1/presence`)).status).toBe(401);
    const presenceWrite = await fetch(`${origin}/v1/presence`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ instanceId: "webchat-stable", mode: "webchat", reason: "paired remote" }) });
    expect(await presenceWrite.json()).toMatchObject({ presence: { instanceId: "webchat-stable", status: "active" } });
    const presenceRead = await fetch(`${origin}/v1/presence`, { headers });
    expect(await presenceRead.json()).toMatchObject({ presence: [{ instanceId: "webchat-stable", mode: "webchat" }] });
    expect(JSON.stringify(await (await fetch(`${origin}/v1/presence`, { headers })).json())).not.toMatch(/remoteAddress|hostname|clientIp/i);
    const readOnlyPairing = remote.beginPairing("Read-only browser", ["read"]);
    const readOnlyPaired = await fetch(`${origin}/v1/pairings/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingId: readOnlyPairing.pairingId, code: readOnlyPairing.code }) });
    const readOnlyDevice = await readOnlyPaired.json() as { token: string };
    const readOnlyHeaders = { authorization: `Bearer ${readOnlyDevice.token}`, "content-type": "application/json" };
    expect((await fetch(`${origin}/v1/nodes/beacon`, { method: "POST", headers: readOnlyHeaders, body: JSON.stringify({ nodeId: "imposter", label: "Imposter", platform: "ios", capabilities: ["location"] }) })).status).toBe(401);
    expect((await fetch(`${origin}/v1/nodes/phone-1/poll`, { method: "POST", headers: readOnlyHeaders })).status).toBe(401);
    expect((await fetch(`${origin}/v1/nodes/phone-1/results`, { method: "POST", headers: readOnlyHeaders, body: JSON.stringify({ commandId: "node-command-imposter", ok: true, output: {} }) })).status).toBe(401);
    const nodeBeacon = await fetch(`${origin}/v1/nodes/beacon`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ nodeId: "phone-1", label: "Phone", platform: "ios", capabilities: ["location", "talk", "voiceWake"], idleSeconds: 4 }) });
    expect(await nodeBeacon.json()).toMatchObject({ node: { nodeId: "phone-1", platform: "ios", status: "active" } });
    const locationCommand = nativeNodes.enqueueLocation("phone-1", { desiredAccuracy: "balanced" });
    expect(await (await fetch(`${origin}/v1/nodes/phone-1/poll`, { method: "POST", headers })).json()).toMatchObject({ commands: [{ id: locationCommand.id, kind: "location.get" }], voiceWake: ["openclaw", "claude", "computer"] });
    const nodeResult = await fetch(`${origin}/v1/nodes/phone-1/results`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ commandId: locationCommand.id, ok: true, output: { accuracy: "balanced" } }) });
    expect(nodeResult.status).toBe(202);
    expect(await nodeResult.json()).toEqual({ accepted: true });
    expect(nativeNodes.result(locationCommand.id)).toMatchObject({ ok: true, output: { accuracy: "balanced" } });
    const talkServer = new RemoteHttpServer({ remote, runtime, nativeNodes, host: "127.0.0.1", onNodeTalk: async ({ text }) => ({ text: `Reply: ${text}`, sessionId: session.id }) });
    servers.push(talkServer);
    const talkOrigin = (await talkServer.start()).origin;
    const talk = await fetch(`${talkOrigin}/v1/nodes/phone-1/talk`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: "Hello" }) });
    expect(await talk.json()).toMatchObject({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativeNodes.poll("phone-1").commands).toMatchObject([{ kind: "talk.speak", input: { text: "Reply: Hello" } }]);
    expect((await fetch(`${origin}/v1/nodes/voice-wake`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ triggers: ["hey kestrel"] }) })).status).toBe(401);

    const mcpHeaders = { ...headers, "content-type": "application/json", "x-kestrel-session-id": session.id };
    const initialized = await fetch(`${origin}/v1/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) });
    expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-11-25", serverInfo: { name: "kestrel-runtime" } } });
    expect((await fetch(`${origin}/v1/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status).toBe(202);
    const mcpTools = await fetch(`${origin}/v1/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    const mcpToolsBody = await mcpTools.json() as { result: { tools: Array<{ name: string }> } };
    expect(mcpToolsBody.result.tools.some((tool) => tool.name === "tools.search")).toBe(true);

    const submitted = await fetch(`${origin}/v1/jobs`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "Remote task", sessionId: session.id, model: "fake", providerIds: ["fake"], prompt: "private prompt", schedule: { kind: "once", nextRunAt: "2099-01-01T00:00:00.000Z" } })
    });
    expect(submitted.status).toBe(202);
    expect(JSON.stringify(await submitted.json())).not.toContain("private prompt");

    const eventResponse = await fetch(`${origin}/v1/events`, { headers });
    expect(eventResponse.status).toBe(200);
    const reader = eventResponse.body!.getReader();
    await reader.read();
    runtime.createSession({ title: "SSE-created" });
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain("session.created");
    await reader.cancel();
    database.close();
  });

  it("rejects browser origins not on the allowlist and non-loopback plaintext binding", async () => {
    const { database, runtime, remote } = fixture();
    const server = new RemoteHttpServer({ remote, runtime, host: "127.0.0.1", allowedOrigins: ["https://allowed.example"] });
    servers.push(server);
    const { origin } = await server.start();
    expect((await fetch(`${origin}/health`, { headers: { origin: "https://blocked.example" } })).status).toBe(403);
    await expect(new RemoteHttpServer({ remote, runtime, host: "0.0.0.0" }).start()).rejects.toThrow("requires TLS");
    database.close();
  });

  it("accepts a scope-capped identity only from a configured trusted loopback proxy", async () => {
    const { database, runtime, session, remote } = fixture();
    const trustedProxy = new TrustedProxyAuthorizer({
      trustedSources: ["127.0.0.1"],
      userHeader: "x-auth-user",
      requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
      allowUsers: ["operator@example.test"],
      allowLoopback: true,
      maximumScopes: ["read", "tasks"]
    });
    const server = new RemoteHttpServer({ remote, runtime, host: "127.0.0.1", trustedProxy });
    servers.push(server);
    const { origin } = await server.start();
    const headers = { "x-auth-user": "operator@example.test", "x-forwarded-proto": "https", "x-forwarded-host": "control.example" };
    const sessions = await fetch(`${origin}/v1/sessions`, { headers });
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({ sessions: [{ id: session.id }] });
    expect((await fetch(`${origin}/v1/sessions`, { headers: { ...headers, "x-auth-user": "blocked@example.test" } })).status).toBe(401);
    const resume = await fetch(`${origin}/v1/jobs/missing/resume`, { method: "POST", headers });
    expect(resume.status).toBe(401);
    database.close();
  });

  it("accepts HMAC-authenticated channel ingress through server-side session routing", async () => {
    const { database, runtime, session, remote } = fixture();
    const secret = Buffer.alloc(32, 4);
    const gateway = new ChannelGateway(database, runtime, [], { chat: secret });
    const server = new RemoteHttpServer({ remote, runtime, host: "127.0.0.1", channelGateway: gateway, resolveChannelSession: () => session.id });
    servers.push(server);
    const { origin } = await server.start();
    const envelope: ChannelEnvelope = { channelId: "chat", externalId: "message-1", conversationId: "room-1", senderId: "person-1", text: "Treat this as untrusted", receivedAt: "2026-07-23T01:00:00.000Z" };
    const response = await fetch(`${origin}/v1/channels/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-kestrel-signature": signChannelEnvelope(envelope, secret) }, body: JSON.stringify({ envelope }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });
    expect(runtime.listMessages(session.id)).toMatchObject([{ role: "user", content: expect.stringContaining("[Untrusted chat message") }]);
    database.close();
  });
});
