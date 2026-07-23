import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import type { ScheduledAgentJob } from "./orchestration";
import type { ChannelEnvelope, ChannelGateway } from "./channels";
import type { RemoteControl, RemoteScope } from "./remote";
import type { AgentRuntime } from "./runtime";
import { McpRuntimeServer, type JsonRpcMessage } from "./extensions/mcp";
import { remoteWebAsset } from "./remote-web";

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
}

interface RateRecord { count: number; resetAt: number; }

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length > 600) throw new Error("Remote bearer token is required.");
  return authorization.slice(7);
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

  constructor(private readonly options: RemoteHttpServerOptions) {}

  async start(): Promise<{ origin: string }> {
    if (this.server) throw new Error("Remote HTTP server is already running.");
    const host = this.options.host ?? "127.0.0.1";
    if (!isLoopback(host) && !this.options.tls) throw new Error("Non-loopback remote transport requires TLS.");
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
      const token = bearer(request);
      if (request.method === "POST" && url.pathname === "/v1/mcp") {
        this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
        const sessionHeader = request.headers["x-kestrel-session-id"];
        if (typeof sessionHeader !== "string" || sessionHeader.length > 200) throw new Error("MCP session header is required.");
        this.options.runtime.getSession(sessionHeader);
        const body = await readJson(request);
        if (body.jsonrpc !== "2.0" || (typeof body.method !== "string" && !("result" in body) && !("error" in body))) throw new Error("MCP JSON-RPC message is invalid.");
        const key = `${token}:${sessionHeader}`;
        const server = this.mcpSessions.get(key) ?? new McpRuntimeServer(this.options.runtime, sessionHeader);
        this.mcpSessions.set(key, server);
        const result = await server.handle(body as JsonRpcMessage);
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
      const status = /token|bearer|scope/i.test(message) ? 401 : /rate limit/i.test(message) ? 429 : /invalid|requires|exceeds|must|field|schedule/i.test(message) ? 400 : 500;
      json(response, status, { error: status === 500 ? "Remote request failed." : message });
    }
  }

  private openEvents(token: string, request: IncomingMessage, response: ServerResponse): void {
    this.options.remote.assertAuthorized(token, "read" satisfies RemoteScope);
    if (this.sse.size >= (this.options.maximumSseClients ?? 8)) throw new Error("Remote event client limit exceeded.");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(": connected\n\n");
    this.sse.add(response);
    const listener = (event: unknown) => response.write(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`);
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
