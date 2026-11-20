import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "vitest";
import { createNativeDesktopCancellation } from "./native-desktop-cancellation.mjs";

async function ownedNode({ stubborn = false } = {}) {
 const child = spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{${stubborn ? "" : "process.exit(0)"}});setInterval(()=>{},1000);console.log('ready');`], { stdio: ["ignore", "pipe", "pipe"] });
 const exited = once(child, "exit");
 await once(child.stdout, "data");
 return { child, exited, async cleanup() {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
 } };
}

describe("native desktop cooperative cancellation", () => {
 it("cancels before launch and rejects later work without an owned child", async () => {
  let notifications = 0;
  const control = createNativeDesktopCancellation({ onCancel: () => notifications++ });
  control.cancel("SIGINT"); control.cancel("SIGTERM");
  assert.equal(notifications, 1); assert.equal(control.error.signal, "SIGINT");
  assert.throws(control.check, /cancelled/);
  await assert.rejects(control.delay(1), /cancelled/);
  assert.deepEqual(await control.stop(), { noChild: true, forced: false });
 });
 it("refuses PID-like values instead of signalling discovered processes", () => {
  const control = createNativeDesktopCancellation();
  assert.throws(() => control.bindChild({ pid: process.pid, kill() { throw Error("must not signal"); } }), /owned ChildProcess/);
 });
 it("stops only the bound child and aborts pending waits once on duplicate signals", async () => {
  const owned = await ownedNode(), unrelated = await ownedNode();
  const control = createNativeDesktopCancellation({ graceMs: 1000 });
  try {
   control.bindChild(owned.child);
   const signals = [], kill = owned.child.kill.bind(owned.child);
   owned.child.kill = signal => { signals.push(signal); return kill(signal); };
   const waiting = assert.rejects(control.delay(60_000), /cancelled by SIGTERM/);
   control.cancel("SIGTERM"); control.cancel("SIGINT");
   await waiting;
   const result = await control.stop();
   assert.equal(result.code, 0); assert.equal(result.forced, false);
   assert.deepEqual(signals, ["SIGTERM"]);
   assert.equal(unrelated.child.exitCode, null); assert.equal(unrelated.child.signalCode, null);
   assert.throws(control.check, /cancelled/);
  } finally { await owned.cleanup(); await unrelated.cleanup(); }
 });
 it("disconnects current and late CDP transports and absorbs close failures", async () => {
  const control = createNativeDesktopCancellation(); let closes = 0;
  const transport = { close: async () => { closes++; throw Error("already disconnected"); } };
  await control.bindTransport(transport);
  control.cancel("SIGINT"); await control.disconnect();
  assert.equal(closes, 1);
  await assert.rejects(control.bindTransport({ close: async () => { closes++; } }), /cancelled/);
  assert.equal(closes, 2);
 });
 it("unwinds a pending connection immediately and closes its eventual transport", async () => {
  const control = createNativeDesktopCancellation(); let connect, closes = 0;
  const pending = new Promise(resolve => { connect = resolve; }).then(value => control.bindTransport(value));
  const cancelled = assert.rejects(control.wait(pending), /cancelled/);
  control.cancel("SIGINT"); await cancelled;
  connect({ close: async () => { closes++; } });
  await assert.rejects(pending, /cancelled/); assert.equal(closes, 1);
 });
 it("handles a child which already exited without sending another signal", async () => {
  const owned = await ownedNode(), control = createNativeDesktopCancellation();
  try {
   owned.child.kill("SIGTERM"); await owned.exited;
   control.bindChild(owned.child);
   owned.child.kill = () => { throw Error("must not signal an exited child"); };
   control.cancel("SIGTERM");
   const result = await control.stop(); assert.equal(result.code, 0); assert.equal(result.forced, false);
  } finally { await owned.cleanup(); }
 });
 it("forces only after a graceful deadline and never calls forced cleanup confirmed", async () => {
  const owned = await ownedNode({ stubborn: true }), control = createNativeDesktopCancellation({ graceMs: 60, forceMs: 1000 });
  try {
   control.bindChild(owned.child);
   const signals = [], kill = owned.child.kill.bind(owned.child);
   owned.child.kill = signal => { signals.push({ signal, at: Date.now() }); return kill(signal); };
   control.cancel("SIGTERM"); const result = await control.stop();
   assert.deepEqual(signals.map(item => item.signal), ["SIGTERM", "SIGKILL"]);
   assert(signals[1].at - signals[0].at >= 50);
   assert.equal(result.forced, true); assert.equal(result.cleanupUnconfirmed, true); assert.equal(result.signal, "SIGKILL");
  } finally { await owned.cleanup(); }
 });
});
