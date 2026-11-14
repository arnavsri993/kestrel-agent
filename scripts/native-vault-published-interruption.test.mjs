import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "vitest";
import { captureOwnedTransferProcesses, interruptOwnedPublishedTransfer } from "./native-vault-published-interruption.mjs";

async function fixture(mode) {
 const root = await mkdtemp(join(tmpdir(), "kestrel-owned-published-fixture-"));
 const data = join(root, "data"); await mkdir(data, { mode: 0o700 });
 const workerEntry = join(root, "worker.mjs"), parentEntry = join(root, "parent.mjs");
 const database = join(data, "kestrel.sqlite"), sourceDatabase = join(root, "source.sqlite"), selected = join(root, "selection.json");
 const before = { active: "", previous: "" };
 await writeFile(selected, JSON.stringify(before), { mode: 0o600 });
 await writeFile(workerEntry, 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(0)); setTimeout(()=>process.exit(0),6000).unref();\n', { mode: 0o600 });
 await writeFile(parentEntry, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const [worker,database,source,selected,mode]=process.argv.slice(2);
const child=spawn(process.execPath,['--max-old-space-size=1536',worker,'--protected-host-pipe'],{stdio:['pipe','ignore','ignore']});
child.once('spawn',()=>console.log(JSON.stringify({workerPid:child.pid})));
const stop=()=>{child.stdin.end();setTimeout(()=>process.exit(0),100)};
process.on('SIGTERM',stop);setTimeout(stop,12000).unref();
process.stdin.on('data',()=>{
 if(mode==='activation-won')writeFileSync(selected,JSON.stringify({active:'new',previous:''}),{mode:0o600});
 writeFileSync(database+'.kestrel-transfer-journal',JSON.stringify({format:'kestrel-core-transfer-journal',version:1,ownerPid:mode==='wrong-owner'?process.ppid:child.pid,plan:{source:{path:source},destination:{path:database}}}),{mode:0o600});
 writeFileSync(database,'generated boundary fixture',{mode:0o600});
});\n`, { mode: 0o600 });
 const child = spawn(process.execPath, [parentEntry, workerEntry, database, sourceDatabase, selected, mode], { stdio: ["pipe", "pipe", "inherit"] });
 const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
 let output = ""; child.stdout.on("data", bytes => { output += bytes; });
 for (let index = 0; !output.includes("\n"); index++) { assert(index < 200); await delay(10); }
 const workerPid = JSON.parse(output.trim()).workerPid;
 const ownership = captureOwnedTransferProcesses(child, { executable: process.execPath, workerExecutable: process.execPath, workerEntry });
 const options = { child, ownership, database, sourceDatabase, readSelection: async () => JSON.parse(await readFile(selected, "utf8")), reviewedSelection: before, timeoutMs: 2000 };
 return { child, exited, workerPid, options, async cleanup() {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([exited, delay(3000).then(() => { throw Error("Fixture parent did not stop."); })]);
  for (let index = 0; index < 700; index++) {
   const state = execFileSync("/bin/ps", ["-axo", "pid=,stat="], { encoding: "utf8" }).split("\n").find(row => Number(row.trim().split(/\s+/)[0]) === workerPid);
   if (!state) break;
   assert(index < 699, "Fixture worker remained after its pipe closed."); await delay(10);
  }
  await rm(root, { recursive: true });
 } };
}
async function publish(value, overrides = {}) {
 let ready;
 const armed = new Promise(resolve => { ready = resolve; });
 const result = interruptOwnedPublishedTransfer({ ...value.options, ...overrides, onArmed: ready });
 await Promise.race([armed, result.then(() => { throw Error("Interrupted before arming."); })]);
 value.child.stdin.write("publish\n");
 return result;
}

describe.skipIf(process.platform !== "darwin")("owned published-transfer interruption", () => {
it("signals only the owned parent and its worker exits on pipe closure", async () => {
 const value = await fixture("published");
 try {
  const result = publish(value);
  const proof = await result; assert.equal(proof.workerSignalled, false); assert.equal(proof.productWorkerInjected, false);
  assert.deepEqual(await value.exited, { code: null, signal: "SIGKILL" });
 } finally { await value.cleanup(); }
});
it("resumes the parent when activation wins the race", async () => {
 const value = await fixture("activation-won");
 try {
  const result = publish(value);
  await assert.rejects(result, /Activation won the race/);
  assert.equal(value.child.exitCode, null); assert.equal(value.child.signalCode, null);
  assert(!execFileSync("/bin/ps", ["-p", String(value.child.pid), "-o", "stat="], { encoding: "utf8" }).includes("T"));
 } finally { await value.cleanup(); }
});
it("rejects an unrelated journal owner before a stop signal", async () => {
 const value = await fixture("wrong-owner");
 try {
  const result = publish(value);
  await assert.rejects(result, error => error.code === "ERR_ASSERTION");
  assert.equal(value.child.exitCode, null); assert.equal(value.child.signalCode, null);
  assert(!execFileSync("/bin/ps", ["-p", String(value.child.pid), "-o", "stat="], { encoding: "utf8" }).includes("T"));
 } finally { await value.cleanup(); }
});
it("resumes the parent on cancellation after freeze", async () => {
 const value = await fixture("published"); let cancelled = false;
 try {
  await assert.rejects(publish(value, { cancelled: () => cancelled, readSelection: async () => {
   const selected = await value.options.readSelection(); cancelled = true; return selected;
  } }), /cancelled before crash/);
  assert.equal(value.child.exitCode, null); assert.equal(value.child.signalCode, null);
  assert(!execFileSync("/bin/ps", ["-p", String(value.child.pid), "-o", "stat="], { encoding: "utf8" }).includes("T"));
 } finally { await value.cleanup(); }
});
});
