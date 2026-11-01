import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeDocumentTabResolver } from "./native-document-tab";

const id = "tab-12345678-1234-1234-1234-123456789abc";
const map = { "17": id };
function harness(getCurrent: () => Promise<{ id?: number } | undefined> = vi.fn(async () => ({ id: 17 })), readMapping: () => Promise<unknown> = vi.fn(async () => map)) {
 let change: (value: unknown) => void = () => {};
 const unsubscribe = vi.fn();
 const resolver = createNativeDocumentTabResolver({ getCurrent, readMapping, subscribeMapping(callback) { change = callback; return unsubscribe; } });
 return { resolver, change: (value: unknown) => change(value), unsubscribe };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("native document identity", () => {
 it("retries an initially unavailable tab", async () => {
  const get = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ id: 17 });
  const { resolver } = harness(get); await vi.advanceTimersByTimeAsync(100);
  expect(resolver.getSnapshot()).toEqual({ state: "ready", id }); resolver.close();
 });
 it("retries failed storage reads", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(map);
  const { resolver } = harness(undefined, read); await vi.advanceTimersByTimeAsync(100);
  expect(resolver.getSnapshot()).toEqual({ state: "ready", id }); resolver.close();
 });
 it("uses a mapping received before getCurrent completes without waiting for a hung storage read", async () => {
  let release!: (value: { id: number }) => void;
  const get = vi.fn(() => new Promise<{ id: number }>(resolve => { release = resolve; }));
  const read = vi.fn(() => new Promise<unknown>(() => {}));
  const { resolver, change } = harness(get, read);
  change(map); release({ id: 17 }); await vi.advanceTimersByTimeAsync(0);
  expect(resolver.getSnapshot()).toEqual({ state: "ready", id });
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000); expect(resolver.getSnapshot()).toEqual({ state: "ready", id }); resolver.close();
 });
 it("keeps a newer change over an older in-flight read and clears deleted mappings", async () => {
  let release!: (value: unknown) => void;
  const read = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const { resolver, change } = harness(undefined, read); await Promise.resolve(); await Promise.resolve();
  change(map); release({}); await vi.advanceTimersByTimeAsync(0);
  expect(resolver.getSnapshot()).toEqual({ state: "ready", id });
  change({}); expect(resolver.getSnapshot()).toEqual({ state: "loading" }); resolver.close();
 });
 it("reports a timeout, then recovers on explicit retry", async () => {
  let succeeds = false;
  const get = vi.fn(async () => succeeds ? { id: 17 } : undefined);
  const { resolver } = harness(get); await vi.advanceTimersByTimeAsync(10_000);
  expect(resolver.getSnapshot()).toEqual({ state: "error" });
  succeeds = true; resolver.retry(); await vi.advanceTimersByTimeAsync(0);
  expect(resolver.getSnapshot()).toEqual({ state: "ready", id }); resolver.close();
 });
 it("times out a hung API and ignores stale responses after retry and close", async () => {
  let release!: (value: { id: number }) => void;
  const get = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({ id: 17 });
  const { resolver, unsubscribe } = harness(get); const listener = vi.fn(); resolver.subscribe(listener);
  await vi.advanceTimersByTimeAsync(10_000); expect(resolver.getSnapshot()).toEqual({ state: "error" });
  resolver.retry(); await vi.advanceTimersByTimeAsync(0); expect(resolver.getSnapshot()).toEqual({ state: "ready", id });
  resolver.close(); const count = listener.mock.calls.length; release({ id: 99 }); await vi.advanceTimersByTimeAsync(20_000);
  expect(listener).toHaveBeenCalledTimes(count); expect(unsubscribe).toHaveBeenCalledOnce();
 });
});
