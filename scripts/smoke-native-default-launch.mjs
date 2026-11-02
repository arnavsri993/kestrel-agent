#!/usr/bin/env node
// Runs only against an explicitly supplied built candidate, never the installed app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

const supplied = process.env.KESTREL_NATIVE_TEST_APP;
if (!supplied) throw new Error("Set KESTREL_NATIVE_TEST_APP to a disposable candidate. No app was launched.");
const candidate = await realpath(resolve(supplied));
if (candidate === "/Applications/Kestrel.app" || candidate.startsWith("/Applications/Kestrel.app/")) throw new Error("The canonical app cannot be used for this test.");
const executable = join(candidate, "Contents/MacOS/Kestrel");
const profile = await mkdtemp(join(tmpdir(), "kestrel-default-launch-"));
await markDisposableNativeTestProfile(profile);
const legacyKeyPath = join(profile, "native-core/database.key");
const disposableTestKeyPath = join(profile, ".kestrel-native-test-core-key-v1");
const databasePath = join(profile, "native-core/database/kestrel.sqlite");
let child;
async function waitFor(check, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Candidate exited early: ${child.exitCode}`);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Default launch did not become ready.");
}
async function launch() {
  let output = "";
  child = spawn(executable, [], { env: { ...process.env, KESTREL_NATIVE_TEST_PROFILE_ROOT: profile, KESTREL_NATIVE_TEST_PROFILE_KEY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  await waitFor(async () => output.includes("KESTREL_CHROMIUM_DESKTOP_TAB_READY") && output.includes("KESTREL_CHROMIUM_DESKTOP_BRIDGE_READY") && output.includes("KESTREL_CHROMIUM_DESKTOP_DOCUMENT_LOADED") && await stat(databasePath).then(s => s.isFile(), () => false));
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Candidate failed to quit cleanly.")), 15000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  child.kill("SIGTERM");
  const exit = await exited;
  assert.equal(exit.code, 0, `Default launch failed to quit cleanly: ${JSON.stringify(exit)}`);
}
try {
  const rejected = spawn(executable, [], { env: { ...process.env, KESTREL_NATIVE_TEST_PROFILE_ROOT: "/" }, stdio: "ignore" });
  const invalidResult = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { rejected.kill("SIGKILL"); reject(new Error("Unsafe profile check timed out.")); }, 15000);
    rejected.once("error", reject);
    rejected.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.notEqual(invalidResult.code, 0, "Unsafe test profile must fail before opening the desktop.");
  await launch();
  await assert.rejects(stat(legacyKeyPath), { code: "ENOENT" });
  assert.equal((await stat(disposableTestKeyPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(join(profile, ".kestrel-native-default-v1"), "utf8")), "kestrel-native-v1\n");
  await launch();
  await assert.rejects(stat(legacyKeyPath), { code: "ENOENT" });
  assert.equal((await stat(disposableTestKeyPath)).mode & 0o777, 0o600);
  console.log("No-argument development desktop launch, authenticated Core/worker bridge, UI document load, disposable test-key-backed Core restart, and shutdown passed. Real Keychain access was not exercised; React rendering was not inspected.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await stopped;
  }
  await rm(profile, { recursive: true, force: true });
}
