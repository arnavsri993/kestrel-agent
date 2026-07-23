import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentLoop } from "./agent-loop";
import { TaskOrchestrator } from "./orchestration";
import { ProviderPool, type ModelProvider } from "./providers";
import { RemoteControl } from "./remote";
import { RemoteHttpServer } from "./remote-http";
import { AgentRuntime } from "./runtime";
import { ChannelGateway, signChannelEnvelope, type ChannelEnvelope } from "./channels";

const servers: RemoteHttpServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });

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
  it("pairs a device, enforces bearer scopes, redacts jobs, and streams runtime events", async () => {
    const { database, runtime, session, remote } = fixture();
    const pairing = remote.beginPairing("Browser client", ["read", "tasks"]);
    const server = new RemoteHttpServer({ remote, runtime, host: "127.0.0.1", allowedOrigins: ["https://control.example"] });
    servers.push(server);
    const { origin } = await server.start();
    const application = await fetch(`${origin}/app/`);
    expect(application.status).toBe(200);
    expect(application.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await application.text()).toContain("Pair this device");
    expect(await (await fetch(`${origin}/app/manifest.webmanifest`)).json()).toMatchObject({ name: "Workstrand Remote", display: "standalone", start_url: "/app/" });
    expect(await (await fetch(`${origin}/app/app.js`)).text()).toContain("sessionStorage.getItem('kestrel-token')");
    expect(await fetch(`${origin}/v1/sessions`)).toMatchObject({ status: 401 });
    const paired = await fetch(`${origin}/v1/pairings/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingId: pairing.pairingId, code: pairing.code }) });
    expect(paired.status).toBe(200);
    const device = await paired.json() as { token: string };
    const headers = { authorization: `Bearer ${device.token}` };
    const sessions = await fetch(`${origin}/v1/sessions`, { headers });
    expect(await sessions.json()).toMatchObject({ sessions: [{ id: session.id, title: "Remote HTTP" }] });
    expect(JSON.stringify(await (await fetch(`${origin}/v1/sessions`, { headers })).json())).not.toContain("workspaceRoot");

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
