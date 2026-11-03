import { describe, expect, it, vi } from "vitest";
import { NativeCommunicationHost, type NativeCommunicationHostOptions } from "./native-communication-host";

const tabId = "tab-ad7d9896-b7ad-47ca-8fd4-e082b3dd653b";
const authority = { tabId, chromeTabId: 5, windowId: 6, documentId: "generated-document", origin: "https://example.test", fieldId: "ad7d9896-b7ad-47ca-8fd4-e082b3dd653b" };
const localStatus = { id: "mac-messages" as const, kind: "local" as const, label: "Messages", state: "connected" as const, detail: "ready" };
const gmailStatus = { id: "gmail" as const, kind: "email" as const, label: "Gmail", state: "connected" as const, detail: "ready" };
const match = { sourceId: "mac-messages" as const, sourceLabel: "Messages", code: "481902", receivedAt: "2026-11-03T12:00:00.000Z" };
function fixture(overrides: Partial<NativeCommunicationHostOptions> = {}) {
 let time = Date.parse("2026-11-03T12:00:30.000Z");
 const options: NativeCommunicationHostOptions = { localMessages: { status: vi.fn(() => localStatus), search: vi.fn(async () => ({ status: localStatus, matches: [match] })) },
  gmailStatus: vi.fn(async () => gmailStatus), searchGmail: vi.fn(async () => []), inspect: vi.fn(async () => authority), validate: vi.fn(async () => true),
  insert: vi.fn(async () => true), openMessagesSettings: vi.fn(async () => {}), now: () => new Date(time), ...overrides };
 return { host: new NativeCommunicationHost(options), options, advance(ms: number) { time += ms; } };
}
async function scan(host: NativeCommunicationHost) {
 const result = await host.handle({ type: "communication-code-scan", tabId });
 if (!result.ok || !("communicationScan" in result)) throw new Error("fixture scan failed");
 return result.communicationScan;
}
describe("native communication host", () => {
 it("inspects before source queries, binds domain and returns only bounded validated recent candidates", async () => {
  const f = fixture(); const s = await scan(f.host);
  expect(s.domain).toBe("example.test"); expect(s.candidates).toHaveLength(1);
  expect(vi.mocked(f.options.inspect).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.options.localMessages.search).mock.invocationCallOrder[0]!);
  expect(f.options.searchGmail).toHaveBeenCalledWith({ domain: "example.test", after: "2026-11-03T11:30:30.000Z", maxResults: 5 }, expect.any(AbortSignal));
  await f.host.close();
 });
 it("denies raw lookup and does not search on invalid or stale authority", async () => {
  const f = fixture({ validate: vi.fn(async () => false) });
  expect(await f.host.handle({ type: "communication-code-search", domain: "example.test", after: "2026-11-03T12:00:00.000Z", maxResults: 1 })).toMatchObject({ ok: false });
  expect(await f.host.handle({ type: "communication-code-scan", tabId })).toMatchObject({ ok: false });
  expect(f.options.localMessages.search).not.toHaveBeenCalled(); expect(f.options.searchGmail).not.toHaveBeenCalled(); await f.host.close();
 });
 it("consumes a scan before using a candidate and refuses replay, wrong IDs, expiry or navigation", async () => {
  for (const mode of ["replay", "wrong", "expired", "navigation"]) {
   let valid = true;
   const f = fixture({ validate: vi.fn(async () => valid) }); const s = await scan(f.host);
   const input = { type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id };
   if (mode === "wrong") input.candidateId = "candidate-ad7d9896-b7ad-47ca-8fd4-e082b3dd653b";
   if (mode === "expired") f.advance(120_000);
   if (mode === "navigation") valid = false;
   const first = await f.host.handle(input);
   expect(first.ok).toBe(mode === "replay");
   expect((await f.host.handle({ ...input, candidateId: s.candidates[0]!.id })).ok).toBe(false);
   expect(f.options.insert).toHaveBeenCalledTimes(mode === "replay" ? 1 : 0); await f.host.close();
  }
 });
 it("does not expose results or search another source when authority changes mid-scan", async () => {
  let valid = true;
  const search = vi.fn(async () => { valid = false; return { status: localStatus, matches: [match] }; });
  const f = fixture({ localMessages: { status: () => localStatus, search }, validate: async () => valid });
  expect(await f.host.handle({ type: "communication-code-scan", tabId })).toMatchObject({ ok: false });
  expect(f.options.searchGmail).not.toHaveBeenCalled(); await f.host.close();
 });
 it("isolates source failures, validates matches and never returns upstream errors", async () => {
  const f = fixture({ localMessages: { status: () => localStatus, search: async () => { throw Error("secret 481902"); } },
   searchGmail: async () => [ { ...match, sourceId: "gmail", sourceLabel: "Gmail", code: "999999", receivedAt: "2026-11-03T12:01:00.000Z" },
    { ...match, sourceId: "gmail", sourceLabel: "Gmail", code: "123456" } ] });
  const s = await scan(f.host); expect(s.candidates.map(value => value.code)).toEqual(["123456"]);
  expect(s.sources.find(value => value.id === "mac-messages")?.state).toBe("unavailable");
  expect(JSON.stringify(s)).not.toContain("481902"); await f.host.close();
 });
 it("bounds concurrent work and close does not wait for an uncooperative source", async () => {
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ localMessages: { status: () => localStatus, search: async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { status: localStatus, matches: [match] }; } } });
  const pending = f.host.handle({ type: "communication-code-scan", tabId }); await entered;
  expect(await f.host.handle({ type: "communication-sources" })).toMatchObject({ ok: false });
  await f.host.close(); expect(await pending).toMatchObject({ ok: false }); release();
  expect(await f.host.handle({ type: "communication-code-scan", tabId })).toMatchObject({ ok: false });
 });
 it("reports uncertain insertion on abort, consumes the scan and drops a late result", async () => {
  let release!: (value: boolean) => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ insert: async () => { started(); return new Promise<boolean>(resolve => { release = resolve; }); } });
  const s = await scan(f.host), controller = new AbortController();
  const input = { type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id };
  const pending = f.host.handle(input, controller.signal); await entered; controller.abort();
  expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/may have completed/i) });
  release(true); expect(await f.host.handle(input)).toMatchObject({ ok: false }); await f.host.close();
 });
 it("returns a confirmed insertion even if the caller aborts immediately after confirmation", async () => {
  const controller = new AbortController();
  const f = fixture({ insert: async () => { setTimeout(() => controller.abort(), 0); return true; } });
  const s = await scan(f.host);
  expect(await f.host.handle({ type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id }, controller.signal)).toMatchObject({ ok: true, communicationCodeInserted: true });
  await f.host.close();
 });
 it("cancels only the matching active tab and clears its retained candidates", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ localMessages: { status: () => localStatus, search: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { status: localStatus, matches: [match] }; } } });
  const pending = f.host.handle({ type: "communication-code-scan", tabId }); await started;
  const other = "tab-bd7d9896-b7ad-47ca-8fd4-e082b3dd653b";
  expect(await f.host.handle({ type: "communication-code-cancel", tabId: other })).toMatchObject({ ok: true });
  expect(await f.host.handle({ type: "communication-code-cancel", tabId })).toMatchObject({ ok: true });
  expect(await pending).toMatchObject({ ok: false }); release(); await f.host.close();
  const next = fixture(), s = await scan(next.host);
  await next.host.handle({ type: "communication-code-cancel", tabId });
  expect(await next.host.handle({ type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id })).toMatchObject({ ok: false });
  await next.host.close();
 });
 it("expires earlier scans after the bounded registry fills", async () => {
  const f = fixture(); const first = await scan(f.host);
  for (let i = 0; i < 50; i++) await scan(f.host);
  expect(await f.host.handle({ type: "communication-code-use", scanId: first.scanId, candidateId: first.candidates[0]!.id })).toMatchObject({ ok: false });
  expect(f.options.insert).not.toHaveBeenCalled(); await f.host.close();
 });
 it("rejects a backwards clock and returns a static error on an expired deadline", async () => {
  const f = fixture(); const s = await scan(f.host); f.advance(-1);
  expect(await f.host.handle({ type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id })).toMatchObject({ ok: false });
  await f.host.close();
  const waiting = fixture({ timeoutMs: 5, inspect: () => new Promise(() => {}) });
  const keepAlive = setTimeout(() => {}, 100);
  try { expect(await waiting.host.handle({ type: "communication-code-scan", tabId })).toMatchObject({ ok: false }); }
  finally { clearTimeout(keepAlive); await waiting.host.close(); }
 });

 it("reports statuses without reading messages and skips ineligible sources", async () => {
  const f = fixture({ localMessages: { status: () => ({ ...localStatus, state: "needs_permission", detail: "secret 481902" }), search: vi.fn() },
   gmailStatus: async () => ({ ...gmailStatus, state: "not_connected" }) });
  const status = await f.host.handle({ type: "communication-sources" });
  expect(status.ok).toBe(true); expect(JSON.stringify(status)).not.toContain("481902");
  const result = await scan(f.host); expect(result.candidates).toEqual([]);
  expect(f.options.localMessages.search).not.toHaveBeenCalled(); expect(f.options.searchGmail).not.toHaveBeenCalled(); await f.host.close();
 });
 it("rejects wrong-tab inspection and uses static uncertainty for failed insertion", async () => {
  const bad = fixture({ inspect: async () => ({ ...authority, tabId: "tab-bd7d9896-b7ad-47ca-8fd4-e082b3dd653b" }) });
  expect(await bad.host.handle({ type: "communication-code-scan", tabId })).toMatchObject({ ok: false });
  expect(bad.options.localMessages.search).not.toHaveBeenCalled(); await bad.host.close();
  const f = fixture({ insert: async () => { throw Error("private 481902"); } }); const s = await scan(f.host);
  const result = await f.host.handle({ type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/may have completed/i) });
  expect(JSON.stringify(result)).not.toContain("481902"); await f.host.close();
 });

 it.each(["windowId", "documentId", "fieldId"] as const)("refuses a changed %s without retargeting", async field => {
  let live = { ...authority };
  const f = fixture({ validate: async captured => JSON.stringify(captured) === JSON.stringify(live) });
  const s = await scan(f.host);
  if (field === "windowId") live = { ...live, windowId: 99 };
  else if (field === "documentId") live = { ...live, documentId: "new-document" };
  else live = { ...live, fieldId: "bd7d9896-b7ad-47ca-8fd4-e082b3dd653b" };
  expect(await f.host.handle({ type: "communication-code-use", scanId: s.scanId, candidateId: s.candidates[0]!.id })).toMatchObject({ ok: false });
  expect(f.options.insert).not.toHaveBeenCalled(); expect(f.options.inspect).toHaveBeenCalledTimes(1); await f.host.close();
 });

});
