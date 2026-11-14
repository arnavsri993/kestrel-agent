// Disposable acceptance harness only. Signals only the caller's own live
// ChildProcess; discovered worker PIDs are observed, never signalled.
import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function identity(pid) {
 assert(Number.isSafeInteger(pid) && pid > 1);
 const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid=,lstart=,comm="], { encoding: "utf8", timeout: 5000 }).trim();
 const match = output.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
 assert(match, "Owned process identity is unavailable.");
 return { pid, ppid: Number(match[1]), executable: match[3], started: match[2].replace(/\s+/g, " ") };
}
function assertOwned(child, expected) {
 assert(child instanceof ChildProcess && child.exitCode === null && child.signalCode === null, "Owned app is no longer live.");
 assert.deepEqual(identity(child.pid), expected, "Owned app identity changed; no signal sent.");
 assert.equal(expected.ppid, process.pid, "Only a direct child of this harness may be interrupted.");
}
export function captureOwnedTransferProcesses(child, { executable, workerExecutable, workerEntry }) {
 assert(child instanceof ChildProcess && child.exitCode === null && child.signalCode === null);
 const parent = identity(child.pid);
 assert.equal(parent.executable, executable); assert.equal(parent.ppid, process.pid);
 const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 5000 });
 const matches = [];
 for (const row of rows.split("\n")) {
  const parsed = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!parsed || Number(parsed[2]) !== child.pid || parsed[3] !== workerExecutable) continue;
  const pid = Number(parsed[1]);
  const args = execFileSync("/bin/ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 5000 }).trim();
  if (args === `${workerExecutable} --max-old-space-size=1536 ${workerEntry} --protected-host-pipe`) matches.push(identity(pid));
 }
 assert.equal(matches.length, 1, "Exactly one direct protected transfer worker must be present.");
 assertOwned(child, parent);
 return { parent, worker: matches[0] };
}
async function privateFile(path, maxBytes, allowPublishedLink = false) {
 let stat;
 try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
 assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
  (stat.mode & 0o7777) === 0o600 && stat.size > 0 && stat.size <= maxBytes &&
  (stat.nlink === 1 || (allowPublishedLink && stat.nlink === 2)), "Published recovery file is unsafe.");
 return stat;
}
export async function interruptOwnedPublishedTransfer({ child, ownership, database, sourceDatabase,
 readSelection, reviewedSelection, cancelled = () => false, onArmed = () => {}, timeoutMs = 10 * 60_000 }) {
 assert(timeoutMs > 0 && timeoutMs <= 10 * 60_000);
 assertOwned(child, ownership.parent);
 const directory = await lstat(dirname(database));
 assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() && (directory.mode & 0o077) === 0);
 assert.equal(await privateFile(database, 1024 * 1024 * 1024, true), null, "Destination already exists; no interruption armed.");
 let wake, timer, frozen = false, killed = false;
 const observer = watch(dirname(database), () => wake?.());
 const until = Date.now() + timeoutMs;
 try {
  onArmed();
  while (Date.now() < until) {
   assert(!cancelled(), "Published recovery interruption cancelled.");
   assert(child.exitCode === null && child.signalCode === null, "Owned app exited before publication.");
   const published = await privateFile(database, 1024 * 1024 * 1024, true);
   if (published) {
    assert(await privateFile(`${database}.kestrel-transfer-journal`, 4 * 1024 * 1024), "Published recovery journal missing.");
    const journal = JSON.parse(await readFile(`${database}.kestrel-transfer-journal`, "utf8"));
    assert.equal(journal.format, "kestrel-core-transfer-journal"); assert.equal(journal.version, 1);
    assert.equal(journal.ownerPid, ownership.worker.pid);
    assert.equal(journal.plan?.source?.path, sourceDatabase); assert.equal(journal.plan?.destination?.path, database);
    assertOwned(child, ownership.parent);
    assert(child.kill("SIGSTOP"), "Could not freeze owned app."); frozen = true;
    for (let index = 0; index < 50; index++) {
     const state = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "stat="], { encoding: "utf8", timeout: 5000 }).trim();
     if (state.includes("T")) break;
     assert(index < 49, "Owned app did not enter stopped state."); await delay(2);
    }
    assertOwned(child, ownership.parent);
    assert.deepEqual(await readSelection(), reviewedSelection, "Activation won the race; app will resume without a crash.");
    assert(await privateFile(database, 1024 * 1024 * 1024, true));
    assert.deepEqual(JSON.parse(await readFile(`${database}.kestrel-transfer-journal`, "utf8")), journal);
    assert(!cancelled(), "Published recovery interruption cancelled before crash; resuming owned app.");
    assert(child.kill("SIGKILL"), "Could not interrupt the owned frozen app."); killed = true;
    return { boundary: "published-before-activation", parent: ownership.parent, journalOwner: ownership.worker,
     workerSignalled: false, sourceKeyExported: false, productWorkerInjected: false };
   }
   await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 25); });
   clearTimeout(timer); wake = undefined;
  }
  throw Error("Published interruption boundary was not observed; no crash performed.");
 } finally {
  clearTimeout(timer); observer.close();
  if (frozen && !killed) { assertOwned(child, ownership.parent); assert(child.kill("SIGCONT"), "Owned app could not resume; preserve all fixtures."); }
 }
}
