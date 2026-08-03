import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import { ChannelInteractionConfigurationSchema, type ChannelInteractionConfiguration } from "@kestrel/shared-types";
import type { AgentRuntime } from "./runtime";
import { isPrivateNetworkAddress } from "./web-tools";
import { readBoundedResponseBytes } from "./bounded-http";

export interface ChannelEnvelope {
  channelId: string;
  externalId: string;
  conversationId: string;
  senderId: string;
  text: string;
  receivedAt: string;
}

export interface ChannelAttachment { filename: string; mediaType: string; data: Uint8Array; }

export interface ChannelAdapter {
  id: string;
  kind?: "webhook" | "slack" | "discord" | "teams" | "gmail";
  send(input: { conversationId: string; text: string; attachments?: ChannelAttachment[]; idempotencyKey: string; signal: AbortSignal }): Promise<{ externalId: string; deliveredAt: string }>;
  edit?(input: { conversationId: string; externalId: string; text: string; signal: AbortSignal }): Promise<{ externalId: string; deliveredAt: string }>;
  typing?(input: { conversationId: string; signal: AbortSignal }): Promise<void>;
  react?(input: { conversationId: string; externalId: string; emoji: string; remove: boolean; signal: AbortSignal }): Promise<void>;
}

export interface WebhookChannelAdapterOptions {
  id: string;
  url: string;
  authorizationHeader?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
}

export interface ChannelRuntimeConfiguration {
  adapters: ChannelAdapter[];
  signingSecrets: Record<string, Buffer>;
  sessionRoutes: Record<string, string>;
}

export interface NativeChannelAdapterOptions { id: string; kind: "slack" | "discord" | "teams" | "gmail"; token?: string; tokenProvider?: () => Promise<string>; fetcher?: typeof fetch; now?: () => Date; }

export class NativeChannelAdapter implements ChannelAdapter {
  readonly id: string; readonly kind: NativeChannelAdapterOptions["kind"];
  private readonly fetcher: typeof fetch; private readonly now: () => Date;
  constructor(private readonly options: NativeChannelAdapterOptions) { this.id = options.id; this.kind = options.kind; this.fetcher = options.fetcher ?? fetch; this.now = options.now ?? (() => new Date()); if (Boolean(options.token) === Boolean(options.tokenProvider) || (options.token?.length ?? 0) > 20_000) throw new Error("Native channel token source is invalid."); }
  async send(input: { conversationId: string; text: string; attachments?: ChannelAttachment[]; idempotencyKey: string; signal: AbortSignal }): Promise<{ externalId: string; deliveredAt: string }> {
    const attachments = input.attachments ?? []; if (attachments.length > 10 || attachments.some((file) => file.data.byteLength > 25_000_000)) throw new Error("Channel attachments exceed provider limits.");
    if (this.kind === "slack") return this.slack(input, attachments);
    if (this.kind === "discord") return this.discord(input, attachments);
    if (this.kind === "gmail") return this.gmail(input, attachments);
    if (attachments.length) throw new Error("Teams channel attachments require a hosted-content provider and are not accepted by this adapter.");
    return this.json(`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(input.conversationId)}/messages`, { body: { contentType: "text", content: input.text } }, input, "id");
  }
  async edit(input: { conversationId: string; externalId: string; text: string; signal: AbortSignal }): Promise<{ externalId: string; deliveredAt: string }> {
    if (this.kind === "gmail") throw new Error("Gmail does not support editable progress messages.");
    if (this.kind === "slack") return this.json("https://slack.com/api/chat.update", { channel: input.conversationId, ts: input.externalId, text: input.text }, { idempotencyKey: `edit-${input.externalId}`, signal: input.signal }, "ts", true);
    const url = this.kind === "discord"
      ? `https://discord.com/api/v10/channels/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.externalId)}`
      : `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.externalId)}`;
    const body = this.kind === "discord" ? { content: input.text } : { body: { content: input.text } };
    const response = await this.fetcher(url, { method: "PATCH", signal: input.signal, headers: { authorization: `${this.kind === "discord" ? "Bot " : "Bearer "}${await this.accessToken()}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return this.response(response, "id");
  }
  async typing(input: { conversationId: string; signal: AbortSignal }): Promise<void> {
    if (this.kind !== "discord") throw new Error(`${this.kind} does not expose a supported typing signal.`);
    const response = await this.fetcher(`https://discord.com/api/v10/channels/${encodeURIComponent(input.conversationId)}/typing`, { method: "POST", signal: input.signal, headers: { authorization: `Bot ${await this.accessToken()}` } });
    if (!response.ok) throw new Error(`Discord typing signal failed with status ${response.status}.`);
  }
  async react(input: { conversationId: string; externalId: string; emoji: string; remove: boolean; signal: AbortSignal }): Promise<void> {
    if (this.kind === "gmail") throw new Error("Gmail does not support message reactions.");
    if (!input.conversationId || input.conversationId.length > 500 || !input.externalId || input.externalId.length > 500 || !input.emoji || Buffer.byteLength(input.emoji) > 100 || /[\0\r\n]/.test(input.emoji)) throw new Error("Channel reaction input is invalid.");
    const token = await this.accessToken();
    let response: Response;
    if (this.kind === "slack") {
      response = await this.fetcher(`https://slack.com/api/reactions.${input.remove ? "remove" : "add"}`, {
        method: "POST",
        signal: input.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: input.conversationId, timestamp: input.externalId, name: input.emoji })
      });
      const body = await this.boundedBody(response);
      if (!response.ok || body.ok !== true) throw new Error(`Slack reaction failed (${response.status}: ${String(body.error ?? response.statusText).slice(0, 500)}).`);
      return;
    }
    if (this.kind === "discord") {
      response = await this.fetcher(`https://discord.com/api/v10/channels/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.externalId)}/reactions/${encodeURIComponent(input.emoji)}/@me`, {
        method: input.remove ? "DELETE" : "PUT",
        signal: input.signal,
        headers: { authorization: `Bot ${token}` }
      });
    } else {
      response = await this.fetcher(`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.externalId)}/${input.remove ? "unsetReaction" : "setReaction"}`, {
        method: "POST",
        signal: input.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reactionType: input.emoji })
      });
    }
    if (!response.ok) throw new Error(`${this.kind === "discord" ? "Discord" : "Teams"} reaction failed with status ${response.status}.`);
    await readBoundedResponseBytes(response, 1_000_000, "Channel provider response exceeds 1 MB.");
  }
  private async slack(input: { conversationId: string; text: string; idempotencyKey: string; signal: AbortSignal }, attachments: ChannelAttachment[]) {
    if (!attachments.length) return this.json("https://slack.com/api/chat.postMessage", { channel: input.conversationId, text: input.text, client_msg_id: input.idempotencyKey }, input, "ts", true);
    const files: Array<{ id: string; title: string }> = [];
    for (const attachment of attachments) {
      const allocation = await this.jsonBody("https://slack.com/api/files.getUploadURLExternal", new URLSearchParams({ filename: attachment.filename, length: String(attachment.data.byteLength) }), input.signal, { "content-type": "application/x-www-form-urlencoded" }) as { ok?: boolean; upload_url?: string; file_id?: string; error?: string };
      if (!allocation.ok || !allocation.upload_url || !allocation.file_id) throw new Error(`Slack upload allocation failed: ${allocation.error ?? "invalid response"}.`);
      const uploadBytes = Uint8Array.from(attachment.data); const upload = await this.fetcher(allocation.upload_url, { method: "POST", signal: input.signal, body: uploadBytes.buffer }); if (!upload.ok) throw new Error(`Slack attachment upload failed with status ${upload.status}.`);
      files.push({ id: allocation.file_id, title: attachment.filename });
    }
    return this.json("https://slack.com/api/files.completeUploadExternal", { files, channel_id: input.conversationId, initial_comment: input.text }, input, "ts", true);
  }
  private async discord(input: { conversationId: string; text: string; idempotencyKey: string; signal: AbortSignal }, attachments: ChannelAttachment[]) {
    const form = new FormData(); form.append("payload_json", JSON.stringify({ content: input.text, nonce: input.idempotencyKey, enforce_nonce: true })); attachments.forEach((attachment, index) => form.append(`files[${index}]`, new Blob([Uint8Array.from(attachment.data).buffer], { type: attachment.mediaType }), attachment.filename));
    const response = await this.fetcher(`https://discord.com/api/v10/channels/${encodeURIComponent(input.conversationId)}/messages`, { method: "POST", signal: input.signal, headers: { authorization: `Bot ${await this.accessToken()}` }, body: form });
    return this.response(response, "id");
  }
  private async gmail(input: { conversationId: string; text: string; idempotencyKey: string; signal: AbortSignal }, attachments: ChannelAttachment[]) {
    const boundary = `kestrel-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`; const lines = [`To: ${input.conversationId.replace(/[\r\n]/g, "")}`, "Subject: Kestrel message", `Message-ID: <${input.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, "")}@kestrel.local>`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary=${boundary}`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", input.text];
    for (const attachment of attachments) lines.push(`--${boundary}`, `Content-Type: ${attachment.mediaType}`, `Content-Disposition: attachment; filename="${attachment.filename.replace(/["\r\n]/g, "-")}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(attachment.data).toString("base64")); lines.push(`--${boundary}--`, "");
    const raw = Buffer.from(lines.join("\r\n")).toString("base64url"); return this.json("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw }, input, "id");
  }
  private async json(url: string, body: unknown, input: { idempotencyKey: string; signal: AbortSignal }, idField: string, slack = false) { const response = await this.fetcher(url, { method: "POST", signal: input.signal, headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", "idempotency-key": input.idempotencyKey }, body: JSON.stringify(body) }); const result = await this.response(response, idField, slack); return result; }
  private async jsonBody(url: string, body: BodyInit, signal: AbortSignal, headers: Record<string, string>) { const response = await this.fetcher(url, { method: "POST", signal, headers: { authorization: `Bearer ${await this.accessToken()}`, ...headers }, body }); if (!response.ok) throw new Error(`Channel provider failed with status ${response.status}.`); const bytes = await readBoundedResponseBytes(response, 1_000_000, "Channel provider response exceeds 1 MB."); return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  private async accessToken(): Promise<string> { const token = this.options.token ?? await this.options.tokenProvider?.(); if (!token || token.length > 20_000 || /[\r\n\0]/.test(token)) throw new Error("Native channel token is unavailable."); return token; }
  private async boundedBody(response: Response): Promise<Record<string, unknown>> { const bytes = await readBoundedResponseBytes(response, 1_000_000, "Channel provider response exceeds 1 MB."); try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>; } catch { return {}; } }
  private async response(response: Response, idField: string, slack = false) { const bytes = await readBoundedResponseBytes(response, 1_000_000, "Channel provider response exceeds 1 MB."); let body: Record<string, unknown> = {}; try { body = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>; } catch {} if (!response.ok || (slack && body.ok !== true)) throw new Error(`Channel provider delivery failed (${response.status}: ${String(body.error ?? response.statusText).slice(0, 500)}).`); const externalId = String(body[idField] ?? body.id ?? body.ts ?? response.headers.get("x-request-id") ?? ""); if (!externalId) throw new Error("Channel provider did not return a delivery ID."); return { externalId: externalId.slice(0, 500), deliveredAt: this.now().toISOString() }; }
}

export function environmentChannelConfiguration(environment: NodeJS.ProcessEnv = process.env): ChannelRuntimeConfiguration | undefined {
  const configuredPath = environment.KESTREL_CHANNEL_CONFIG;
  if (!configuredPath) return undefined;
  const sourceMetadata = lstatSync(configuredPath);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.size > 1_000_000 || (sourceMetadata.mode & 0o077) !== 0) throw new Error("KESTREL_CHANNEL_CONFIG must be an owner-only regular file no larger than 1 MB.");
  const resolved = realpathSync(configuredPath);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as { version?: unknown; channels?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.channels) || parsed.channels.length > 50) throw new Error("Channel configuration must use version 1 with at most 50 channels.");
  const adapters: ChannelAdapter[] = [];
  const signingSecrets: Record<string, Buffer> = {};
  const sessionRoutes: Record<string, string> = {};
  const ids = new Set<string>();
  for (const raw of parsed.channels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Channel configuration entry is invalid.");
    const entry = raw as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || ids.has(id)) throw new Error("Channel configuration IDs must be valid and unique.");
    ids.add(id);
    if (entry.outbound !== undefined) {
      if (!entry.outbound || typeof entry.outbound !== "object" || Array.isArray(entry.outbound)) throw new Error(`Channel ${id} outbound configuration is invalid.`);
      const outbound = entry.outbound as Record<string, unknown>;
      const kind = typeof outbound.kind === "string" ? outbound.kind : "webhook";
      if (["slack", "discord", "teams", "gmail"].includes(kind)) {
        if (typeof outbound.token !== "string") throw new Error(`Channel ${id} native provider token is required.`);
        adapters.push(new NativeChannelAdapter({ id, kind: kind as NativeChannelAdapterOptions["kind"], token: outbound.token }));
      } else {
      if (typeof outbound.url !== "string") throw new Error(`Channel ${id} outbound URL is required.`);
      const authorizationHeader = typeof outbound.authorizationHeader === "string" ? outbound.authorizationHeader : undefined;
      let headers: Record<string, string> | undefined;
      if (outbound.headers !== undefined) {
        if (!outbound.headers || typeof outbound.headers !== "object" || Array.isArray(outbound.headers) || Object.values(outbound.headers).some((value) => typeof value !== "string")) throw new Error(`Channel ${id} outbound headers are invalid.`);
        headers = outbound.headers as Record<string, string>;
      }
      adapters.push(new WebhookChannelAdapter({ id, url: outbound.url, ...(authorizationHeader ? { authorizationHeader } : {}), ...(headers ? { headers } : {}) }));
      }
    }
    if (entry.inboundSecretBase64 !== undefined || entry.sessionId !== undefined) {
      if (typeof entry.inboundSecretBase64 !== "string" || typeof entry.sessionId !== "string" || !entry.sessionId || entry.sessionId.length > 200) throw new Error(`Channel ${id} inbound secret and sessionId are required together.`);
      const secret = Buffer.from(entry.inboundSecretBase64, "base64");
      if (secret.byteLength < 32 || secret.byteLength > 64 || secret.toString("base64") !== entry.inboundSecretBase64) throw new Error(`Channel ${id} inbound secret must be canonical base64 encoding of 32 to 64 bytes.`);
      signingSecrets[id] = secret;
      sessionRoutes[id] = entry.sessionId;
    }
    if (entry.outbound === undefined && entry.inboundSecretBase64 === undefined) throw new Error(`Channel ${id} must configure inbound or outbound access.`);
  }
  return { adapters, signingSecrets, sessionRoutes };
}

export class WebhookChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly kind = "webhook" as const;
  private readonly url: URL;
  private readonly fetcher: typeof fetch;
  private readonly resolver: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: WebhookChannelAdapterOptions) {
    this.id = options.id;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(this.id)) throw new Error("Webhook channel ID is invalid.");
    this.url = new URL(options.url);
    if (this.url.protocol !== "https:" || this.url.username || this.url.password || this.url.hash) throw new Error("Webhook channel URL must be credential-free HTTPS.");
    if (options.authorizationHeader && options.authorizationHeader.length > 8_000) throw new Error("Webhook authorization header is too large.");
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || /^(authorization|host|content-length)$/i.test(name) || value.length > 8_000 || /[\r\n]/.test(value)) throw new Error("Webhook channel header is invalid.");
    }
    this.fetcher = options.fetcher ?? fetch;
    this.resolver = options.resolveHost ?? (async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address));
    const configuredTimeout = options.timeoutMs ?? 15_000;
    this.timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.max(1_000, Math.min(60_000, Math.trunc(configuredTimeout)))
      : 15_000;
    this.now = options.now ?? (() => new Date());
  }

  async send(input: { conversationId: string; text: string; idempotencyKey: string; signal: AbortSignal }): Promise<{ externalId: string; deliveredAt: string }> {
    input.signal.throwIfAborted();
    const addresses = await this.resolver(this.url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateNetworkAddress)) throw new Error("Webhook channel resolved to a private or unsafe address.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Webhook channel request timed out.")), this.timeoutMs);
    const abort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(this.url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json,text/plain;q=0.8",
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          ...(this.options.authorizationHeader ? { authorization: this.options.authorizationHeader } : {}),
          ...(this.options.headers ?? {})
        },
        body: JSON.stringify({ conversationId: input.conversationId, text: input.text })
      });
      await readBoundedResponseBytes(response, 64_000, "Webhook channel response exceeds 64 KB.");
      if (!response.ok) throw new Error(`Webhook channel delivery failed with status ${response.status}.`);
      const requestId = response.headers.get("x-request-id")?.slice(0, 200);
      const fallback = createHash("sha256").update(`${this.id}\0${input.conversationId}\0${input.idempotencyKey}`).digest("hex").slice(0, 24);
      return { externalId: requestId || `webhook-${fallback}`, deliveredAt: this.now().toISOString() };
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    }
  }
}

export class ChannelGateway {
  private readonly adapters = new Map<string, ChannelAdapter>();
  constructor(private readonly database: KestrelDatabase, private readonly runtime: AgentRuntime, adapters: ChannelAdapter[], private readonly signingSecrets: Record<string, Buffer>) {
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }

  list(): Array<{ id: string; kind: NonNullable<ChannelAdapter["kind"]>; inbound: boolean; editableProgress: boolean; typingSignals: boolean; reactions: boolean }> { return [...new Set([...this.adapters.keys(), ...Object.keys(this.signingSecrets)])].map((id) => { const adapter = this.adapters.get(id); return { id, kind: adapter?.kind ?? "webhook", inbound: Boolean(this.signingSecrets[id]), editableProgress: Boolean(adapter?.edit && adapter.kind !== "gmail"), typingSignals: Boolean(adapter?.typing && adapter.kind === "discord"), reactions: Boolean(adapter?.react && adapter.kind !== "gmail") }; }); }

  interactionConfiguration(): ChannelInteractionConfiguration {
    return ChannelInteractionConfigurationSchema.parse(this.database.getPrivateState("channels.interaction") ?? { progressMode: "progress", typingMode: "thinking", typingIntervalSeconds: 6, reactionLevel: "minimal" });
  }

  configureInteraction(configuration: ChannelInteractionConfiguration): ChannelInteractionConfiguration {
    const parsed = ChannelInteractionConfigurationSchema.parse(configuration);
    this.database.setPrivateState("channels.interaction", parsed);
    return parsed;
  }

  receive(sessionId: string, payload: ChannelEnvelope, signatureHex: string): { accepted: boolean; duplicate: boolean } {
    const secret = this.signingSecrets[payload.channelId];
    if (!secret) throw new Error("Inbound channel is not configured.");
    const canonical = JSON.stringify(payload);
    const expected = createHmac("sha256", secret).update(canonical).digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(signatureHex, "hex"); } catch { throw new Error("Invalid channel signature."); }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new Error("Invalid channel signature.");
    const key = `channel-inbound:${payload.channelId}:${payload.externalId}`;
    if (this.database.getIdempotentResult(key)) return { accepted: true, duplicate: true };
    if (payload.text.length > 100_000) throw new Error("Inbound channel message exceeds the size limit.");
    this.runtime.appendMessage({ sessionId, role: "user", content: `[Untrusted ${payload.channelId} message from ${payload.senderId}]\n${payload.text}` });
    this.database.saveIdempotentResult(key, { acceptedAt: new Date().toISOString() });
    return { accepted: true, duplicate: false };
  }

  async send(channelId: string, conversationId: string, text: string, idempotencyKey: string, signal: AbortSignal, attachments: ChannelAttachment[] = []): Promise<Record<string, unknown>> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`Channel ${channelId} is not configured.`);
    if (!conversationId || !text || text.length > 100_000) throw new Error("Outbound channel message is invalid.");
    return { channelId, conversationId, ...await adapter.send({ conversationId, text, ...(attachments.length ? { attachments } : {}), idempotencyKey, signal }) };
  }

  async beginProgress(channelId: string, conversationId: string, idempotencyKey: string, signal: AbortSignal): Promise<ChannelProgressSession> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`Channel ${channelId} is not configured.`);
    const session = new ChannelProgressSession(adapter, conversationId, idempotencyKey, signal, this.interactionConfiguration());
    await session.begin();
    return session;
  }

  async react(channelId: string, conversationId: string, externalId: string, action: "add" | "remove" | "clear", emoji: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    const adapter = this.adapters.get(channelId);
    if (!adapter?.react || adapter.kind === "gmail") throw new Error(`Channel ${channelId} does not support reactions.`);
    if (!conversationId || conversationId.length > 500 || !externalId || externalId.length > 500) throw new Error("Channel reaction target is invalid.");
    if (action !== "clear" && (!emoji || Buffer.byteLength(emoji) > 100 || /[\0\r\n]/.test(emoji))) throw new Error("A bounded emoji is required to add or remove a reaction.");
    const level = this.interactionConfiguration().reactionLevel;
    if (level === "off") throw new Error("Channel reactions are disabled by interaction policy.");
    const stateKey = `channel-reactions:${createHash("sha256").update(`${channelId}\0${conversationId}\0${externalId}`).digest("hex")}`;
    let tracked = this.database.getPrivateState<string[]>(stateKey) ?? [];
    if (action === "clear") {
      for (const current of [...tracked]) {
        await adapter.react({ conversationId, externalId, emoji: current, remove: true, signal });
        tracked = tracked.filter((value) => value !== current);
        this.database.setPrivateState(stateKey, tracked);
      }
      return { channelId, conversationId, externalId, action, removed: true, trackedReactionCount: 0 };
    }
    const value = emoji!;
    if (action === "add") {
      const maximum = level === "ack" ? 1 : level === "minimal" ? 2 : 8;
      if (!tracked.includes(value) && tracked.length >= maximum) throw new Error(`Channel ${level} reaction policy allows at most ${maximum} tracked reaction${maximum === 1 ? "" : "s"} per message.`);
      await adapter.react({ conversationId, externalId, emoji: value, remove: false, signal });
      tracked = [...new Set([...tracked, value])];
    } else {
      await adapter.react({ conversationId, externalId, emoji: value, remove: true, signal });
      tracked = tracked.filter((current) => current !== value);
    }
    this.database.setPrivateState(stateKey, tracked);
    return { channelId, conversationId, externalId, action, emoji: value, trackedReactionCount: tracked.length };
  }
}

export type ChannelProgressPhase = "thinking" | "tool" | "waiting" | "verifying";

export class ChannelProgressSession {
  private externalId: string | undefined;
  private lastTypingAt = 0;
  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly conversationId: string,
    private readonly idempotencyKey: string,
    private readonly signal: AbortSignal,
    private readonly configuration: ChannelInteractionConfiguration
  ) {}

  async begin(): Promise<void> {
    if (this.configuration.typingMode === "instant") await this.pulseTyping();
  }

  async update(input: { phase: ChannelProgressPhase; completed?: number; total?: number }): Promise<void> {
    if (this.signal.aborted) throw this.signal.reason;
    if (this.shouldType(input.phase)) await this.pulseTyping();
    if (!this.adapter.edit || this.adapter.kind === "gmail" || !this.shouldDraft(input.phase)) return;
    const progress = input.completed !== undefined && input.total !== undefined && input.total > 0
      ? ` · ${Math.max(0, Math.min(input.total, Math.trunc(input.completed)))}/${Math.trunc(input.total)}`
      : "";
    const label = input.phase === "thinking" ? "Thinking" : input.phase === "tool" ? "Using approved tools" : input.phase === "waiting" ? "Waiting at a safe boundary" : "Verifying the result";
    const text = `${label}${progress}…`;
    if (!this.externalId) {
      const sent = await this.adapter.send({ conversationId: this.conversationId, text, idempotencyKey: `${this.idempotencyKey}:progress`, signal: this.signal });
      this.externalId = sent.externalId;
    } else {
      await this.adapter.edit({ conversationId: this.conversationId, externalId: this.externalId, text, signal: this.signal });
    }
  }

  async finish(text: string, attachments: ChannelAttachment[] = []): Promise<{ externalId?: string; deliveredAt?: string }> {
    if (!text.trim()) return {};
    if (this.externalId && this.adapter.edit && this.adapter.kind !== "gmail" && attachments.length === 0) return this.adapter.edit({ conversationId: this.conversationId, externalId: this.externalId, text, signal: this.signal });
    return this.adapter.send({ conversationId: this.conversationId, text, ...(attachments.length ? { attachments } : {}), idempotencyKey: this.idempotencyKey, signal: this.signal });
  }

  private shouldDraft(phase: ChannelProgressPhase): boolean {
    if (this.configuration.progressMode === "off") return false;
    if (this.configuration.progressMode === "block") return phase === "waiting";
    if (this.configuration.progressMode === "partial") return phase === "thinking" || phase === "verifying";
    return true;
  }

  private shouldType(phase: ChannelProgressPhase): boolean {
    return this.configuration.typingMode === "thinking" ? phase === "thinking"
      : this.configuration.typingMode === "message" ? true
        : false;
  }

  private async pulseTyping(): Promise<void> {
    if (!this.adapter.typing || (this.adapter.kind && this.adapter.kind !== "discord")) return;
    const now = Date.now();
    if (now - this.lastTypingAt < this.configuration.typingIntervalSeconds * 1_000) return;
    await this.adapter.typing({ conversationId: this.conversationId, signal: this.signal });
    this.lastTypingAt = now;
  }
}

export function signChannelEnvelope(payload: ChannelEnvelope, secret: Buffer): string {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

export function installChannelTools(runtime: AgentRuntime, gateway: ChannelGateway, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: { name: "channel.send", title: "Send channel message", description: "Send an idempotent message through a configured chat or email adapter after explicit approval.", category: "connector", riskLevel: "external", readOnly: false, requiresWorkspace: false, source: "connector", tags: ["chat", "email", "channel", "send"] },
    inputSchema: { type: "object", properties: { channelId: { type: "string" }, conversationId: { type: "string" }, text: { type: "string" }, attachmentPaths: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 4_000 } } }, required: ["channelId", "conversationId", "text"] },
    execute: ({ signal, workspaceRoot }, input) => {
      const paths = Array.isArray(input.attachmentPaths) ? input.attachmentPaths.map(String) : []; const attachments: ChannelAttachment[] = [];
      if (paths.length) {
        if (!workspaceRoot) throw new Error("Channel attachments require a granted workspace."); const root = realpathSync(workspaceRoot); let total = 0;
        for (const requested of paths) { const path = realpathSync(resolve(root, requested)); if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Channel attachment escapes the granted workspace."); const metadata = statSync(path); total += metadata.size; if (!metadata.isFile() || metadata.size > 25_000_000 || total > 50_000_000) throw new Error("Channel attachments exceed file or total size limits."); attachments.push({ filename: basename(path), mediaType: "application/octet-stream", data: readFileSync(path) }); }
      }
      return gateway.send(String(input.channelId), String(input.conversationId), String(input.text), String(input.idempotencyKey ?? "runtime"), signal, attachments);
    }
  });
  runtime.allowTool(sessionId, "channel.send");
  runtime.registerExternalTool({
    descriptor: { name: "channel.react", title: "React to channel message", description: "Add, remove, or clear Kestrel's tracked emoji reactions on a configured native chat message after explicit approval.", category: "connector", riskLevel: "external", readOnly: false, requiresWorkspace: false, source: "connector", tags: ["chat", "channel", "reaction", "emoji"] },
    inputSchema: { type: "object", properties: { channelId: { type: "string" }, conversationId: { type: "string" }, messageId: { type: "string" }, action: { type: "string", enum: ["add", "remove", "clear"] }, emoji: { type: "string", maxLength: 100 } }, required: ["channelId", "conversationId", "messageId", "action"] },
    execute: ({ signal }, input) => gateway.react(String(input.channelId), String(input.conversationId), String(input.messageId), String(input.action) as "add" | "remove" | "clear", typeof input.emoji === "string" ? input.emoji : undefined, signal)
  });
  runtime.allowTool(sessionId, "channel.react");
}
