import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Owns only ChildProcess objects handed over immediately after spawn. Never
// discovers or signals PIDs. Candidate/helper absence is checked by the caller.
export function createNativeDesktopCancellation({ graceMs = 12_000, forceMs = 3_000, onCancel = () => {} } = {}) {
 const controller = new AbortController();
 let cancellation, current, transport;
 const closedTransports = new WeakMap();
 const live = child => child.exitCode === null && child.signalCode === null;
 async function bounded(promise, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]); }
  finally { clearTimeout(timer); }
 }
 function check() { if (cancellation) throw cancellation; }
 function disconnect(value = transport) {
  if (!value) return Promise.resolve();
  if (!closedTransports.has(value)) closedTransports.set(value, Promise.resolve().then(() => value.close()).catch(() => {}));
  return bounded(closedTransports.get(value), forceMs);
 }
 function stop() {
  const state = current;
  if (!state) return Promise.resolve({ noChild: true, forced: false });
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
   if (live(state.child)) state.child.kill("SIGTERM");
   let outcome = await bounded(state.exited, graceMs);
   if (outcome) return { ...outcome, pid: state.child.pid, forced: false };
   if (live(state.child)) state.child.kill("SIGKILL");
   outcome = await bounded(state.exited, forceMs);
   return { ...outcome, pid: state.child.pid, forced: true, cleanupUnconfirmed: true,
    reason: "Owned child exceeded graceful shutdown deadline; preserve fixture and verify helpers separately." };
  })();
  // Signals cannot create an unhandled rejection, even if a caller has not yet
  // reached its finally block. The caller still receives the original failure.
  state.stopping.catch(() => {});
  return state.stopping;
 }
 function cancel(signal) {
  if (cancellation) return;
  assert(["SIGINT", "SIGTERM"].includes(signal));
  cancellation = Object.assign(Error(`Native desktop probe cancelled by ${signal}.`), { code: "NATIVE_PROBE_CANCELLED", signal });
  controller.abort(cancellation);
  // onCancel is synchronous bookkeeping supplied by the harness.
  onCancel(cancellation);
  void disconnect(); void stop().catch(() => {});
 }
 return {
  check, cancel, stop, disconnect,
  get cancelled() { return Boolean(cancellation); },
  get error() { return cancellation; },
  bindChild(child) {
   check(); assert(child instanceof ChildProcess, "Only an owned ChildProcess can be bound.");
   assert(!current || !live(current.child), "Previous owned child is still running.");
   const exited = !live(child) ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => resolve({ code: null, signal: null, spawnError: String(error) }));
   });
   current = { child, exited };
  },
  async bindTransport(value) {
   transport = value;
   if (cancellation) { await disconnect(value); check(); }
   return value;
  },
  async wait(promise) {
   // Observe the work even when cancellation already happened. A late CDP
   // connection still runs bindTransport, which closes it before rejecting.
   let abort;
   const stopped = new Promise((_, reject) => {
    abort = () => reject(cancellation);
    if (cancellation) abort(); else controller.signal.addEventListener("abort", abort, { once: true });
   });
   try { return await Promise.race([promise, stopped]); }
   finally { controller.signal.removeEventListener("abort", abort); }
  },
  async delay(ms, value, options = {}) {
   check();
   try { return await delay(ms, value, { ...options, signal: controller.signal }); }
   catch (error) { check(); throw error; }
  },
 };
}
