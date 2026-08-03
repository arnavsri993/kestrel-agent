import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { RuntimeEventSchema, type RuntimeEvent, type RuntimeToolExecution } from "@kestrel/shared-types";
import type { ScheduledAgentJob } from "./orchestration";
import type { ChannelEnvelope, ChannelGateway } from "./channels";
import type { RemoteControl, RemoteCredential, RemoteScope } from "./remote";
import type { AgentRuntime } from "./runtime";
import { McpRuntimeServer, type JsonRpcMessage } from "./extensions/mcp";
import { remoteWebAsset } from "./remote-web";
import type { PresenceManager } from "./presence";
import type { TrustedProxyAuthorizer } from "./gateway-networking";
import type { NativeNodeManager } from "./native-nodes";

export interface RemoteHttpServerOptions {
  remote: RemoteControl;
  runtime: AgentRuntime;
  host?: string;
  port?: number;
  tls?: HttpsServerOptions;
  allowedOrigins?: string[];
  maximumRequestsPerMinute?: number;
  maximumSseClients?: number;
  channelGateway?: ChannelGateway;
  resolveChannelSession?: (envelope: ChannelEnvelope) => string;
  prometheusMetrics?: () => string;
  presence?: PresenceManager;
  trustedProxy?: TrustedProxyAuthorizer;
  allowProxyTerminatedTls?: boolean;
  nativeNodes?: NativeNodeManager;
  onNodeTalk?: (input: { nodeId: string; text: string }) => Promise<{ text: string; sessionId?: string }>;
}

interface RateRecord { count: number; resetAt: number; }

interface RemoteRuntimeEvent {
  type: RuntimeEvent["type"];
  createdAt: string;
  payload: {
    toolName?: string;
    status?: RuntimeToolExecution["status"];
    state?: "running" | "completed" | "failed" | "stopped";
  };
}

const remoteToolStatuses = new Set<RuntimeToolExecution["status"]>(["running", "verified", "blocked", "failed", "cancelled"]);
const remoteProgressStates = new Set<NonNullable<RemoteRuntimeEvent["payload"]["state"]>>(["running", "completed", "failed", "stopped"]);
const remoteToolNamePattern = /^[a-z][a-z0-9_.-]{0,99}$/;

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function bearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  if (!authorization.startsWith("Bearer ") || authorization.length > 600) throw new Error("Remote bearer token is invalid.");
  return authorization.slice(7);
}

function credentialKey(credential: RemoteCredential): string {
  return typeof credential === "string" ? credential : `proxy:${credential.identity}:${credential.scopes.slice().sort().join(",")}`;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  response.end(body);
}

function webAsset(response: ServerResponse, asset: NonNullable<ReturnType<typeof remoteWebAsset>>): void {
  const body = Buffer.from(asset.body);
  response.writeHead(200, {
    "content-type": asset.contentType, "content-length": body.byteLength, "cache-control": asset.cacheControl,
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin"
  });
  response.end(body);
}

function prometheus(response: ServerResponse, body: string): void {
  const payload = Buffer.from(body);
  response.writeHead(200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(payload);
}

// Read-scoped clients need lifecycle updates, never local runtime payloads.
function serializeRemoteRuntimeEvent(rawEvent: unknown): string | undefined {
  const parsed = RuntimeEventSchema.safeParse(rawEvent);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  const payload: RemoteRuntimeEvent["payload"] = {};
  if (event.type === "tool.started" || event.type === "tool.completed") {
    const toolName = event.payload.toolName;
    const status = event.payload.status;
    if (typeof toolName === "string" && remoteToolNamePattern.test(toolName)) payload.toolName = toolName;
    if (typeof status === "string" && remoteToolStatuses.has(status as RuntimeToolExecution["status"]))
      payload.status = status as RuntimeToolExecution["status"];
  } else if (event.type === "tool.progress") {
    const state = event.payload.state;
    if (typeof state === "string" && remoteProgressStates.has(state as NonNullable<RemoteRuntimeEvent["payload"]["state"]>))
      payload.state = state as NonNullable<RemoteRuntimeEvent["payload"]["state"]>;
  }
  return JSON.stringify({ type: event.type, createdAt: event.createdAt, payload } satisfies RemoteRuntimeEvent);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(request.headers["content-type"] ?? "").toString().toLowerCase().startsWith("application/json")) throw new Error("Request content type must be application/json.");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > 1_000_000) throw new Error("Request body exceeds 1 MB.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error("Request body exceeds 1 MB.");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON request body must be an object.");
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string, maximum: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`Field ${name} is invalid.`);
  return value;
}

function jobInput(body: Record<string, unknown>): Omit<ScheduledAgentJob, "id" | "status" | "createdAt" | "updatedAt"> {
  const rawProviders = body.providerIds;
  if (!Array.isArray(rawProviders) || rawProviders.length < 1 || rawProviders.length > 8 || rawProviders.some((value) => typeof value !== "string" || !value || value.length > 100)) throw new Error("Field providerIds is invalid.");
  const rawSchedule = body.schedule;
  if (!rawSchedule || typeof rawSchedule !== "object" || Array.isArray(rawSchedule)) throw new Error("Field schedule is invalid.");
  const scheduleRecord = rawSchedule as Record<string, unknown>;
  const nextRunAt = stringField(scheduleRecord, "nextRunAt", 100);
  if (!Number.isFinite(new Date(nextRunAt).getTime())) throw new Error("Schedule nextRunAt is invalid.");
  const schedule = scheduleRecord.kind === "once"
    ? { kind: "once" as const, nextRunAt }
    : scheduleRecord.kind === "interval" && Number.isInteger(scheduleRecord.intervalMs) && Number(scheduleRecord.intervalMs) >= 60_000 && Number(scheduleRecord.intervalMs) <= 31_536_000_000
      ? { kind: "interval" as const, nextRunAt, intervalMs: Number(scheduleRecord.intervalMs) }
      : scheduleRecord.kind === "cron" && typeof scheduleRecord.expression === "string" && scheduleRecord.expression.length > 0 && scheduleRecord.expression.length <= 200
        ? { kind: "cron" as const, nextRunAt, expression: scheduleRecord.expression }
        : undefined;
  if (!schedule) throw new Error("Schedule kind or interval is invalid.");
  const instructions = typeof body.instructions === "string" && body.instructions.length <= 100_000 ? body.instructions : undefined;
  return {
    title: stringField(body, "title", 200),
    sessionId: stringField(body, "sessionId", 200),
    model: stringField(body, "model", 200),
    providerIds: rawProviders as string[],
    prompt: stringField(body, "prompt", 1_000_000),
    ...(instructions ? { instructions } : {}),
    schedule
  };
}

function channelEnvelope(body: Record<string, unknown>): ChannelEnvelope {
  const raw = body.envelope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Field envelope is invalid.");
  const envelope = raw as Record<string, unknown>;
  const receivedAt = stringField(envelope, "receivedAt", 100);
  if (!Number.isFinite(new Date(receivedAt).getTime())) throw new Error("Channel receivedAt is invalid.");
  return {
    channelId: stringField(envelope, "channelId", 100),
    externalId: stringField(envelope, "externalId", 500),
    conversationId: stringField(envelope, "conversationId", 500),
    senderId: stringField(envelope, "senderId", 500),
    text: stringField(envelope, "text", 100_000),
    receivedAt
  };
}

export class RemoteHttpServer {
  private server: HttpServer | HttpsServer | undefined;
  private readonly rates = new Map<string, RateRecord>();
  private readonly sse = new Set<ServerResponse>();
  private readonly mcpSessions = new Map<string, McpRuntimeServer>();

  constructor(private readonly options: RemoteHttpServerOptions) {
    for (const [name, value] of [["maximumRequestsPerMinute", options.maximumRequestsPerMinute], ["maximumSseClients", options.maximumSseClients]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a finite positive integer.`);
    }
  }

  async start(): Promise<{ origin: string }> {
    if (this.server) throw new Error("Remote HTTP server is already running.");
    const host = this.options.host ?? "127.0.0.1";
    if (!isLoopback(host) && !this.options.tls && !(this.options.trustedProxy && this.options.allowProxyTerminatedTls)) throw new Error("Non-loopback remote transport requires TLS or explicit trusted-proxy TLS termination.");
    if (this.options.allowProxyTerminatedTls && !this.options.trustedProxy) throw new Error("Proxy-terminated TLS requires trusted-proxy authentication.");
    const handler = (request: IncomingMessage, response: ServerResponse) => { void this.handle(request, response); };
    this.server = this.options.tls ? createHttpsServer(this.options.tls, handler) : createHttpServer(handler);
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? 0, host, () => { this.server!.off("error", reject); resolve(); });
    });
    const address = this.server.address() as AddressInfo;
    const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return { origin: `${this.options.tls ? "https" : "http"}://${displayHost}:${address.port}` };
  }

  async stop(): Promise<void> {
    for (const response of this.sse) response.end();
    this.sse.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private checkRate(request: IncomingMessage): void {
    const now = Date.now();
    const key = request.socket.remoteAddress ?? "unknown";
    const record = this.rates.get(key);
    if (!record || record.resetAt <= now) { this.rates.set(key, { count: 1, resetAt: now + 60_000 }); return; }
    record.count += 1;
    if (record.count > (this.options.maximumRequestsPerMinute ?? 120)) throw new Error("Remote request rate limit exceeded.");
  }

  private checkOrigin(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (!(this.options.allowedOrigins ?? []).includes(origin)) { json(response, 403, { error: "Origin is not allowed." }); return false; }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    return true;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.checkRate(request);
      if (!this.checkOrigin(request, response)) return;
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-kestrel-session-id", "access-control-max-age": "600" });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://kestrel.invalid");
      const asset = request.method === "GET" ? remoteWebAsset(url.pathname) : undefined;
      if (asset) { webAsset(response, asset); return; }
      if (request.method === "GET" && url.pathname === "/health") { json(response, 200, { ok: true }); return; }
      if (request.method === "POST" && url.pathname === "/v1/pairings/complete") {
        const body = await readJson(request);
        json(response, 200, this.options.remote.completePairing(stringField(body, "pairingId", 200), stringField(body, "code", 200)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/channels/inbound") {
        if (!this.options.channelGateway || !this.options.resolveChannelSession) throw new Error("Channel ingress is not configured.");
        const signature = request.headers["x-kestrel-signature"];
        if (typeof signature !== "string" || signature.length > 256) throw new Error("Channel signature is required.");
        const envelope = channelEnvelope(await readJson(request));
        const sessionId = this.options.resolveChannelSession(envelope);
        json(response, 202, this.options.channelGateway.receive(sessionId, envelope, signature));
        return;
      }
      const token = bearer(request) ?? this.options.trustedProxy?.authorize({ ...(request.socket.remoteAddress ? { remoteAddress: request.socket.remoteAddress } : {}), headers: request.headers });
      if (!token) throw new Error("Remote bearer token or trusted proxy identity is required.");
      if (request.method === "GET" && url.pathname === "/v1/diagnostics/prometheus") {
        if (!this.options.prometheusMetrics) { json(response, 404, { error: "Prometheus diagnostics are disabled." }); return; }
        this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
        prometheus(response, this.options.prometheusMetrics());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/presence") {
        if (!this.options.presence) { json(response, 404, { error: "Presence is not configured." }); return; }
        this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
        json(response, 200, { presence: this.options.presence.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/presence") {
        if (!this.options.presence) { json(response, 404, { error: "Presence is not configured." }); return; }
        this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
        const body = await readJson(request);
        const mode = stringField(body, "mode", 20);
        if (!["ui", "webchat", "node", "test"].includes(mode)) throw new Error("Field mode is invalid.");
        const version = typeof body.version === "string" && body.version.length <= 100 ? body.version : undefined;
        const reason = typeof body.reason === "string" && body.reason.length <= 200 ? body.reason : undefined;
        json(response, 200, {
          presence: this.options.presence.beacon({
            instanceId: stringField(body, "instanceId", 128),
            mode: mode as "ui" | "webchat" | "node" | "test",
            ...(version ? { version } : {}),
            ...(reason ? { reason } : {})
          })
        });
        return;
      }
      if (url.pathname === "/v1/nodes" && request.method === "GET") {
        if (!this.options.nativeNodes) { json(response, 404, { error: "Native nodes are not configured." }); return; }
        this.options.remote.assertAuthorized(token, "read");
        json(response, 200, { nodes: this.options.nativeNodes.list() });
        return;
      }
      if (url.pathname === "/v1/nodes/beacon" && request.method === "POST") {
        if (!this.options.nativeNodes) { json(response, 404, { error: "Native nodes are not configured." }); return; }
        this.options.remote.assertAuthorized(token, "tasks");
        const body = await readJson(request);
        json(response, 200, { node: this.options.nativeNodes.beacon({
          nodeId: stringField(body, "nodeId", 128),
          label: stringField(body, "label", 100),
          platform: stringField(body, "platform", 20) as "ios" | "android" | "macos",
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) as never : [],
          ...(typeof body.version === "string" ? { version: body.version } : {}),
          ...(Number.isInteger(body.idleSeconds) ? { idleSeconds: Number(body.idleSeconds) } : {})
        }) });
        return;
      }
      const nodePoll = url.pathname.match(/^\/v1\/nodes\/([A-Za-z0-9._-]{1,128})\/poll$/);
      if (request.method === "POST" && nodePoll) {
        if (!this.options.nativeNodes) { json(response, 404, { error: "Native nodes are not configured." }); return; }
        this.options.remote.assertAuthorized(token, "tasks");
        json(response, 200, this.options.nativeNodes.poll(nodePoll[1]!));
        return;
      }
      const nodeResult = url.pathname.match(/^\/v1\/nodes\/([A-Za-z0-9._-]{1,128})\/results$/);
      if (request.method === "POST" && nodeResult) {
        if (!this.options.nativeNodes) { json(response, 404, { error: "Native nodes are not configured." }); return; }
        this.options.remote.assertAuthorized(token, "tasks");
        const body = await readJson(request);
        const output = body.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output as Record<string, unknown> : undefined;
        const rawError = body.error && typeof body.error === "object" && !Array.isArray(body.error) ? body.error as Record<string, unknown> : undefined;
        this.options.nativeNodes.complete(nodeResult[1]!, {
          commandId: stringField(body, "commandId", 200),
          ok: body.ok === true,
          ...(output ? { output } : {}),
          ...(rawError ? { error: { code: stringField(rawError, "code", 100), message: stringField(rawError, "message", 1_000) } } : {})
        });
        json(response, 202, { accepted: true });
        return;
      }
      const nodeTalk = url.pathname.match(/^\/v1\/nodes\/([A-Za-z0-9._-]{1,128})\/talk$/);
      if (request.method === "POST" && nodeTalk) {
        if (!this.options.nativeNodes || !this.options.onNodeTalk) { json(response, 404, { error: "Native Talk is not configured." }); return; }
        this.options.remote.assertAuthorized(token, "tasks");
        const body = await readJson(request);
        const nodeId = nodeTalk[1]!;
        const text = stringField(body, "text", 10_000);
        void this.options.onNodeTalk({ nodeId, text })
          .then((result) => this.options.nativeNodes?.enqueueTalk(nodeId, result.text, result.sessionId))
          .catch((error) => this.options.nativeNodes?.enqueueTalk(nodeId, `Talk failed: ${error instanceof Error ? error.message.slice(0, 500) : "The agent could not respond."}`));
        json(response, 202, { accepted: true });
        return;
      }
      if (url.pathname === "/v1/nodes/voice-wake" && request.method === "GET") {
        if (!this.options.nativeNodes) { json(response, 404, { error: "Native nodes are not configured." }); return; }
        this.options.remote.assertAuthorized(token, "read");
        json(response, 200, { triggers: this.options.nativeNodes.getVoiceWake() });
        return;
      }
      if (url.pathname === "/v1/nodes/voice-wake" && request.method === "POST") {
        if (!this.options.nativeNodes) { json(response, 404, { error: "Native nodes are not configured." }); return; }
        this.options.remote.assertAuthorized(token, "approve");
        const body = await readJson(request);
        json(response, 200, { triggers: this.options.nativeNodes.setVoiceWake(body.triggers) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mcp") {
        this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
        const allowMutatingTools = this.options.remote.hasAuthorizedScope(token, "tasks");
        const sessionHeader = request.headers["x-kestrel-session-id"];
        if (typeof sessionHeader !== "string" || sessionHeader.length > 200) throw new Error("MCP session header is required.");
        this.options.runtime.getSession(sessionHeader);
        const body = await readJson(request);
        if (body.jsonrpc !== "2.0" || (typeof body.method !== "string" && !("result" in body) && !("error" in body))) throw new Error("MCP JSON-RPC message is invalid.");
        if (body.method === "tools/call" && !allowMutatingTools) {
          const name = String((body.params as Record<string, unknown> | undefined)?.name ?? "");
          const tool = this.options.runtime.modelTools(sessionHeader).find((candidate) => candidate.descriptor.name === name);
          if (!tool?.descriptor.readOnly)
            this.options.remote.assertAuthorized(token, "tasks");
        }
        const key = `${credentialKey(token)}:${sessionHeader}`;
        const server = this.mcpSessions.get(key) ?? new McpRuntimeServer(this.options.runtime, sessionHeader);
        this.mcpSessions.set(key, server);
        const result = await server.handle(body as JsonRpcMessage, { allowMutatingTools });
        if (!result) { response.writeHead(202, { "cache-control": "no-store" }); response.end(); }
        else json(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/sessions") { json(response, 200, { sessions: this.options.remote.listSessions(token) }); return; }
      if (request.method === "GET" && url.pathname === "/v1/jobs") { json(response, 200, { jobs: this.options.remote.listJobs(token) }); return; }
      if (request.method === "POST" && url.pathname === "/v1/jobs") { json(response, 202, { job: this.options.remote.submitJob(token, jobInput(await readJson(request))) }); return; }
      const resume = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9._-]{1,200})\/resume$/);
      if (request.method === "POST" && resume) { json(response, 200, { job: await this.options.remote.resumeJob(token, resume[1]!) }); return; }
      if (request.method === "GET" && url.pathname === "/v1/events") { this.openEvents(token, request, response); return; }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const message = error instanceof Error ? error.message : "Remote request failed.";
      const status = /token|bearer|scope|trusted proxy|identity|untrusted source|not allowed/i.test(message) ? 401 : /rate limit/i.test(message) ? 429 : /invalid|requires|exceeds|must|field|schedule/i.test(message) ? 400 : 500;
      json(response, status, { error: status === 500 ? "Remote request failed." : message });
    }
  }

  private openEvents(token: RemoteCredential, request: IncomingMessage, response: ServerResponse): void {
    this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
    if (this.sse.size >= (this.options.maximumSseClients ?? 8)) throw new Error("Remote event client limit exceeded.");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(": connected\n\n");
    this.sse.add(response);
    const listener = (event: unknown) => {
      const serialized = serializeRemoteRuntimeEvent(event);
      if (serialized) response.write(`event: runtime\ndata: ${serialized}\n\n`);
    };
    this.options.runtime.on("event", listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    const close = () => {
      clearInterval(heartbeat);
      this.options.runtime.off("event", listener);
      this.sse.delete(response);
    };
    request.once("close", close);
    response.once("close", close);
  }
}
