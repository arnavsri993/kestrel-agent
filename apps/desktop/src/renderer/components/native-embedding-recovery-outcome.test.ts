import { describe, expect, it, vi } from "vitest";
import { createRepairOutcomeStore } from "./native-embedding-recovery-outcome";

function storage() {
 const data = new Map<string, string>();
 return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
describe("memory repair outcome lifetime", () => {
 it("retains a deferred committed restart result after the view unsubscribes", async () => {
  const saved = storage(), store = createRepairOutcomeStore(saved), listener = vi.fn();
  let finish!: (value: "restart-required") => void;
  const off = store.subscribe(listener);
  const operation = store.apply(() => new Promise(resolve => { finish = resolve; }));
  expect(store.get()).toBe("in-progress"); off(); finish("restart-required"); await operation;
  expect(listener).toHaveBeenCalledTimes(1);
  expect(createRepairOutcomeStore(saved).get()).toBe("restart-required");
 });
 it("retains an unconfirmed result on rejection and a pending reload", async () => {
  const saved = storage(), store = createRepairOutcomeStore(saved);
  let reject!: (error: Error) => void;
  const operation = store.apply(() => new Promise((_resolve, fail) => { reject = fail; }));
  expect(createRepairOutcomeStore(saved).get()).toBe("unconfirmed");
  reject(new Error("timeout")); await operation;
  expect(store.get()).toBe("unconfirmed");
  store.reconcile("idle"); expect(store.get()).toBe("idle");
  store.reconcile("applied"); expect(createRepairOutcomeStore(saved).get()).toBe("applied");
 });
});
