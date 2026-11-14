import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an exact disposable native candidate.");
assert(process.env.KESTREL_NATIVE_PROFILE_RESERVATION_EVIDENCE, "Select a fresh evidence directory.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
const installed = await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app");
assert(candidate.endsWith(".app") && candidate !== installed && !candidate.startsWith("/Applications/"));
const executable = await realpath(join(candidate, "Contents/MacOS/Kestrel"));
for (const row of execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000 }).split("\n")) {
 const match = row.trim().match(/^(\d+)\s+(.+)$/);
 if (!match || !match[2].endsWith("/Contents/MacOS/Kestrel")) continue;
 assert.notEqual(await realpath(match[2]).catch(() => ""), executable, "Candidate must not already be running.");
}
const evidence = resolve(process.env.KESTREL_NATIVE_PROFILE_RESERVATION_EVIDENCE);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-reservation-smoke-")));
const profile = join(temporary, "profile"), fixture = join(temporary, "reservation-fixture");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate, candidateSha256: await candidateDigest(candidate),
 scope: "Disposable generated profile and disposable test key; actual selected Chromium candidate plus a fixture compiled from this checkout's native reservation sources. No real profile, no explicit OS Keychain access, microphone or desktop input. No live profile renames. The lower-level fixture separately tests swaps.", phases: [] };
const owned = new Set();
let stage = "prepare", interrupted = false, forced = false;
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
 interrupted = true;
 for (const state of owned) if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGTERM");
});
async function bounded(promise, milliseconds, label) {
 let timer;
 try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds); })]); }
 finally { clearTimeout(timer); }
}
function launch() {
 const child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key"], { stdio: ["ignore", "pipe", "pipe"] });
 const state = { child, output: "", error: undefined };
 state.exited = new Promise(done => { child.once("error", error => { state.error = error; owned.delete(state); done({ code: null, signal: null, spawnError: true }); }); child.once("exit", (code, signal) => { owned.delete(state); done({ code, signal }); }); });
 state.closed = new Promise(done => child.once("close", () => done()));
 for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { if (state.output.length < 1_000_000) state.output += bytes.toString("utf8").slice(0, 1_000_000 - state.output.length); });
 owned.add(state); return state;
}
async function waitReady(state) {
 const deadline = Date.now() + 20_000;
 while (Date.now() < deadline) {
  if (interrupted) throw Error("Probe interrupted.");
  if (state.error || state.child.exitCode !== null || state.child.signalCode !== null) throw Error("Owned candidate exited before its document loaded.");
  if (state.output.includes("KESTREL_CHROMIUM_DESKTOP_DOCUMENT_LOADED")) return;
  await delay(100);
 }
 throw Error("Owned candidate document did not load in time.");
}
async function stop(state) {
 assert.equal(state.child.exitCode, null, "Owned candidate must be running before graceful stop.");
 assert.equal(state.child.signalCode, null);
 assert(state.child.kill("SIGTERM"), "Could not request graceful shutdown.");
 const result = await bounded(state.exited, 20_000, "Graceful owned candidate shutdown");
 assert.deepEqual(result, { code: 0, signal: null });
}
function fixtureCheck(expected) {
 const result = spawnSync(fixture, ["child", profile, expected], { encoding: "utf8", timeout: 5_000 });
 assert.equal(result.error, undefined, `Reservation fixture ${expected} failed.`);
 assert.equal(result.status, 0, `Reservation fixture did not observe ${expected}.`);
}
try {
 await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
 const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5_000 }).trim();
 const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8", timeout: 5_000 }).trim();
 execFileSync(compiler, ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
  "-I", join(repository, "apps/native-chromium-host/src"), join(repository, "apps/native-chromium-host/src/kestrel_profile_reservation.cc"),
  join(repository, "apps/native-chromium-host/tests/native_profile_reservation_fixture.cc"), "-o", fixture], { timeout: 30_000, stdio: "pipe" });
 fixtureCheck("free");
 stage = "first-launch";
 const first = launch(); await waitReady(first); fixtureCheck("busy");
 phase("actual-candidate-holds-external-profile-fence");
 stage = "second-process-refused";
 const second = launch(); const secondResult = await bounded(second.exited, 20_000, "Second candidate refusal");
 assert.deepEqual(secondResult, { code: 1, signal: null });
 await bounded(second.closed, 5000, "Second candidate output closure");
 assert.match(second.output, /profile.*(?:in use|busy|unavailable)|(?:in use|busy|unavailable).*profile/i);
 assert.equal(first.child.exitCode, null); assert.equal(first.child.signalCode, null); fixtureCheck("busy");
 phase("second-candidate-refused-while-first-remains-running");
 stage = "graceful-stop";
 await stop(first); fixtureCheck("free");
 phase("graceful-candidate-exit-releases-external-fence");
 stage = "restart";
 const restarted = launch(); await waitReady(restarted); fixtureCheck("busy"); await stop(restarted); fixtureCheck("free");
 phase("same-generated-profile-restarts-and-releases-fence");
 receipt.result = "passed";
} catch (error) {
 receipt.result = "failed"; receipt.failedStage = stage; receipt.error = String(error?.message || error).slice(0, 500);
 console.error(`Native reservation probe failed at ${stage}: ${receipt.error}`); process.exitCode = 1;
} finally {
 for (const state of [...owned]) {
  if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGTERM");
  try { await bounded(state.exited, 20_000, "Owned cleanup"); }
  catch { forced = true; state.child.kill("SIGKILL"); await bounded(state.exited, 5000, "Forced cleanup").catch(() => {}); }
 }
 receipt.forcedCleanup = forced; receipt.ownedProcessesRemaining = owned.size;
 if (forced || owned.size || interrupted) { receipt.result = "failed"; process.exitCode = 1; }
 try { receipt.candidateSha256After = await candidateDigest(candidate); if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; } }
 catch { receipt.result = "failed"; receipt.digestError = true; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
 if (!owned.size) await rm(temporary, { recursive: true, force: true });
}
