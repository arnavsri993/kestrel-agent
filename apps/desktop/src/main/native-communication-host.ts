import { randomUUID } from "node:crypto";
import {
 CommunicationCodeMatchSchema, CommunicationCodeScanSchema, CommunicationSourceStatusSchema,
 NativeLoginCodeAuthoritySchema, RendererRequestSchema,
 type CommunicationCodeCandidate, type CommunicationCodeMatch, type CommunicationSourceStatus,
 type NativeLoginCodeAuthority, type RendererResponse,
} from "@kestrel/shared-types";
import { NATIVE_COMMUNICATION_REQUEST_TYPES } from "./native-communication-requests";
export { NATIVE_COMMUNICATION_REQUEST_TYPES } from "./native-communication-requests";

const TTL_MS = 120_000, LOOKBACK_MS = 30 * 60_000, MAX_SCANS = 50;
const INVALID = "Invalid communication request.";
const UNAVAILABLE = "The verification page is no longer available. Try again.";
const UNCERTAIN = "Code insertion may have completed. Check the page before trying again.";
const CLOSED = "Communication lookup is unavailable.";
type SourceId = "mac-messages" | "gmail";
type SourceResult = { matches: CommunicationCodeMatch[]; status: CommunicationSourceStatus };
type Scan = { authority: NativeLoginCodeAuthority; issuedAt: number; expiresAt: number; candidates: CommunicationCodeCandidate[]; sources: CommunicationSourceStatus[] };
export interface NativeCommunicationHostOptions {
 localMessages: { status(): CommunicationSourceStatus | Promise<CommunicationSourceStatus>; search(signal: AbortSignal): Promise<SourceResult> };
 gmailStatus(signal: AbortSignal): Promise<CommunicationSourceStatus>;
 searchGmail(input: { domain: string; after: string; maxResults: number }, signal: AbortSignal): Promise<CommunicationCodeMatch[]>;
 inspect(tabId: string, signal: AbortSignal): Promise<NativeLoginCodeAuthority>;
 validate(authority: NativeLoginCodeAuthority, signal: AbortSignal): Promise<boolean>;
 insert(authority: NativeLoginCodeAuthority, code: string, signal: AbortSignal): Promise<boolean>;
 openMessagesSettings(signal: AbortSignal): Promise<void>;
 notify?(input: { domain: string }, signal: AbortSignal): Promise<void>;
 now?: () => Date;
 timeoutMs?: number;
}
function safeStatus(id: SourceId, value: unknown): CommunicationSourceStatus {
 const parsed = CommunicationSourceStatusSchema.safeParse(value);
 const valid = parsed.success && parsed.data.id === id && parsed.data.kind === (id === "gmail" ? "email" : "local");
 const account = valid && id === "gmail" ? parsed.data.account?.toLowerCase() : undefined;
 const state = valid ? (id === "gmail" && parsed.data.state === "connected" && !account ? "needs_reconnect" : parsed.data.state) : "unavailable";
 const details: Record<CommunicationSourceStatus["state"], string> = {
  connected: "Available for a user-requested lookup.", not_connected: "This source is not connected.",
  needs_permission: "This source needs permission.", needs_reconnect: "Reconnect this source to search.", unavailable: "This source is unavailable.",
 };
 return { id, label: id === "gmail" ? "Connected Gmail" : "Messages on this Mac", kind: id === "gmail" ? "email" : "local", state, detail: details[state], ...(account ? { account } : {}) };
}
function unavailable(id: SourceId): CommunicationSourceStatus { return safeStatus(id, undefined); }
function sameSource(a: CommunicationSourceStatus, b: CommunicationSourceStatus): boolean {
 return a.id === b.id && a.state === "connected" && b.state === "connected" && (a.id !== "gmail" || Boolean(a.account && a.account === b.account));
}
function awaitSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
 if (signal.aborted) return Promise.reject(new Error("cancelled"));
 return new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("cancelled")); };
  signal.addEventListener("abort", abort, { once: true });
  promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
 });
}
function call<T>(signal: AbortSignal, callback: () => T | Promise<T>): Promise<T> {
 return awaitSignal(Promise.resolve().then(() => { signal.throwIfAborted(); return callback(); }), signal);
}
export class NativeCommunicationHost {
 private readonly scans = new Map<string, Scan>();
 private readonly now: () => Date;
 private readonly timeoutMs: number;
 private active: AbortController | undefined;
 private activeTabId: string | undefined;
 private closed = false;
 constructor(private readonly options: NativeCommunicationHostOptions) {
  this.now = options.now ?? (() => new Date());
  this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30_000, Math.trunc(options.timeoutMs!))) : 15_000;
 }
 invalidate(): void { this.scans.clear(); this.active?.abort(); }
 close(): Promise<void> { this.closed = true; this.invalidate(); return Promise.resolve(); }
 private clock(): number { const value = this.now().getTime(); if (!Number.isFinite(value)) throw new Error("invalid clock"); return value; }
 private trim(now: number) { for (const [id, scan] of this.scans) if (scan.expiresAt <= now) this.scans.delete(id); }
 private async check(authority: NativeLoginCodeAuthority, signal: AbortSignal): Promise<void> {
  if (!await call(signal, () => this.options.validate(authority, signal))) throw new Error("stale");
 }
 async handle(raw: unknown, externalSignal?: AbortSignal): Promise<RendererResponse> {
  const parsed = RendererRequestSchema.safeParse(raw);
  if (!parsed.success || !NATIVE_COMMUNICATION_REQUEST_TYPES.has(parsed.data.type)) return { ok: false, error: INVALID };
  if (parsed.data.type === "communication-code-search") return { ok: false, error: "Code lookup is available only from an active verification page." };
  if (this.closed || externalSignal?.aborted) return { ok: false, error: CLOSED };
  if (parsed.data.type === "communication-code-cancel") {
   for (const [id, scan] of this.scans) if (scan.authority.tabId === parsed.data.tabId) this.scans.delete(id);
   if (this.activeTabId === parsed.data.tabId) this.active?.abort();
   return { ok: true };
  }
  if (this.active) return { ok: false, error: "Another communication lookup is in progress." };
  const controller = new AbortController(); this.active = controller;
  this.activeTabId = parsed.data.type === "communication-code-scan" || parsed.data.type === "communication-code-notify" ? parsed.data.tabId : undefined;
  if (parsed.data.type === "communication-code-scan") {
   for (const [id, scan] of this.scans) if (scan.authority.tabId === parsed.data.tabId) this.scans.delete(id);
  }
  const abort = () => controller.abort(); externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, this.timeoutMs); timer.unref?.();
  let inserting = false;
  try {
   const signal = controller.signal, request = parsed.data;
   if (request.type === "communication-messages-open-settings") {
    await call(signal, () => this.options.openMessagesSettings(signal)); return { ok: true };
   }
   if (request.type === "communication-sources") return { ok: true, communicationSources: await this.statuses(signal) };
   if (request.type === "communication-code-use") {
    this.trim(this.clock());
    const scan = this.scans.get(request.scanId);
    this.activeTabId = scan?.authority.tabId;
    // A lookup is consumed before any async work, including invalid candidate IDs.
    this.scans.delete(request.scanId);
    const candidate = scan?.candidates.find(value => value.id === request.candidateId);
    if (!scan || !candidate) throw new Error("expired");
    await this.check(scan.authority, signal);
    const previous = scan.sources.find(source => source.id === candidate.sourceId);
    const current = await this.sourceStatus(candidate.sourceId, signal);
    if (!previous || !sameSource(previous, current)) throw new Error("source changed");
    await this.check(scan.authority, signal);
    if (this.clock() >= scan.expiresAt || this.clock() < scan.issuedAt) throw new Error("expired");
    inserting = true;
    const confirmed = await call(signal, () => this.options.insert(scan.authority, candidate.code, signal));
    if (!confirmed) throw new Error("not confirmed");
    return { ok: true, communicationCodeInserted: true };
   }
   if (request.type !== "communication-code-scan" && request.type !== "communication-code-notify") return { ok: false, error: INVALID };
   const authority = NativeLoginCodeAuthoritySchema.parse(await call(signal, () => this.options.inspect(request.tabId, signal)));
   if (authority.tabId !== request.tabId) throw new Error("wrong tab");
   await this.check(authority, signal);
   const domain = new URL(authority.origin).hostname;
   if (request.type === "communication-code-notify") {
    if (this.options.notify) await call(signal, () => this.options.notify!({ domain }, signal));
    return { ok: true };
   }
   const at = this.clock(), statuses = await this.statuses(signal), all: CommunicationCodeMatch[] = [];
   for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i]!; if (status.state !== "connected") continue;
    await this.check(authority, signal);
    try {
     if (status.id === "mac-messages") {
      const result = await call(signal, () => this.options.localMessages.search(signal));
      statuses[i] = safeStatus("mac-messages", result.status);
      if (statuses[i]!.state === "connected") all.push(...this.matches("mac-messages", result.matches, at));
     } else {
      const matches = await call(signal, () => this.options.searchGmail({ domain, after: new Date(at - LOOKBACK_MS).toISOString(), maxResults: 5 }, signal));
      all.push(...this.matches("gmail", matches, at).filter(match => !match.account || match.account.toLowerCase() === status.account));
     }
    } catch (error) { if (signal.aborted) throw error; statuses[i] = unavailable(status.id); }
   }
   const afterStatuses = await this.statuses(signal);
   for (const status of statuses) {
    if (status.state === "connected" && !sameSource(status, afterStatuses.find(value => value.id === status.id)!)) throw new Error("source changed");
   }
   await this.check(authority, signal);
   if (this.clock() - at >= TTL_MS || this.clock() < at) throw new Error("expired");
   const unique = all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).filter((match, index, array) =>
    array.findIndex(value => value.sourceId === match.sourceId && value.code === match.code && value.receivedAt === match.receivedAt) === index).slice(0, 10);
   const candidates = unique.map(value => ({ ...value, id: `candidate-${randomUUID()}` }));
   const scanId = `scan-${randomUUID()}`;
   const communicationScan = CommunicationCodeScanSchema.parse({ scanId, domain, siteLabel: domain, scannedAt: new Date(at).toISOString(), candidates, sources: statuses });
   this.trim(this.clock()); while (this.scans.size >= MAX_SCANS) this.scans.delete(this.scans.keys().next().value!);
   this.scans.set(scanId, { authority, candidates, sources: statuses, issuedAt: at, expiresAt: at + TTL_MS });
   return { ok: true, communicationScan };
  } catch { return { ok: false, error: inserting ? UNCERTAIN : UNAVAILABLE }; }
  finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); if (this.active === controller) { this.active = undefined; this.activeTabId = undefined; } }
 }
 private async sourceStatus(id: SourceId, signal: AbortSignal): Promise<CommunicationSourceStatus> {
  try {
   return safeStatus(id, await call(signal, () => id === "gmail" ? this.options.gmailStatus(signal) : this.options.localMessages.status()));
  } catch (error) { if (signal.aborted) throw error; return unavailable(id); }
 }
 private async statuses(signal: AbortSignal): Promise<CommunicationSourceStatus[]> {
  return Promise.all([this.sourceStatus("mac-messages", signal), this.sourceStatus("gmail", signal)]);
 }
 private matches(id: SourceId, values: unknown, at: number): CommunicationCodeMatch[] {
  if (!Array.isArray(values)) return [];
  const output: CommunicationCodeMatch[] = [];
  for (const value of values.slice(0, 5)) {
   const match = CommunicationCodeMatchSchema.safeParse(value);
   if (!match.success || match.data.sourceId !== id) continue;
   const received = Date.parse(match.data.receivedAt);
   if (!Number.isFinite(received) || received > at || received < at - LOOKBACK_MS) continue;
   output.push(match.data);
  }
  return output;
 }
}
