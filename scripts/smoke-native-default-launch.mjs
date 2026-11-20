#!/usr/bin/env node
// Runs only against an explicitly supplied built candidate, never the installed app.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const supplied = process.env.KESTREL_NATIVE_TEST_APP;
if (!supplied) throw new Error("Set KESTREL_NATIVE_TEST_APP to a disposable candidate. No app was launched.");
const candidate = await realpath(resolve(supplied));
if (candidate === "/Applications/Kestrel.app" || candidate.startsWith("/Applications/Kestrel.app/")) throw new Error("The canonical app cannot be used for this test.");
const executable = join(candidate, "Contents/MacOS/Kestrel");
const profile = await mkdtemp(join(tmpdir(), "kestrel-default-launch-"));
const launchLogs = await mkdtemp(join(tmpdir(), "kestrel-default-launch-logs-"));
// The no-argument profile is explicitly disposable. It uses the real local
// vault implementation with generated data and never enables test-key mode.
await writeFile(join(profile, ".kestrel-native-test-profile-v1"), "native-test-profile-v1\n", { flag: "wx", mode: 0o600 });
await writeFile(join(profile, ".kestrel-native-default-v1"), "kestrel-native-v1\n", { flag: "wx", mode: 0o600 });
const legacyKeyPath = join(profile, "native-core/database.key");
const rawTestKeyPath = join(profile, ".kestrel-native-test-core-key-v1");
const localVaultPath = join(profile, ".kestrel-local-vault-v1");
let child;
let launchServicesChild;
let nativePid;
let launchLogPaths;
let candidatePidsBeforeLaunch = new Set();
let launchCount = 0;

function launchServicesInfo(command, args = []) {
  const result = spawnSync("/usr/bin/lsappinfo", [command, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return "";
  return result.stdout;
}

function candidatePids() {
  const entries = launchServicesInfo("list").split(/(?=^\s*\d+\) )/m);
  return entries.flatMap(entry => {
    if (!entry.includes(`bundle path="${candidate}"`) || !entry.includes(`executable path="${executable}"`)) return [];
    const pid = Number(entry.match(/\bpid = (\d+)/)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}

function frontmostApplication() {
  const front = launchServicesInfo("front").match(/ASN:[^\s]+/)?.[0];
  if (!front) return null;
  const info = launchServicesInfo("info", [front]);
  const pid = Number(info.match(/\bpid = (\d+)/)?.[1]);
  const bundlePath = info.match(/\bbundle path="([\s\S]*?)"/)?.[1];
  return Number.isSafeInteger(pid) && bundlePath ? { pid, bundlePath } : null;
}

function nativeWindowTitles(pid) {
  const source = `import AppKit
import CoreGraphics
let pid = ${pid}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows where (window[kCGWindowOwnerPID as String] as? Int) == pid {
  if let title = window[kCGWindowName as String] as? String { print(title) }
}`;
  const result = spawnSync("/usr/bin/swift", ["-e", source], { encoding: "utf8", timeout: 15000 });
  if (result.error || result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map(title => title.trim()).filter(Boolean);
}

async function launchOutput() {
  if (!launchLogPaths) return "";
  const [stdout, stderr] = await Promise.all(launchLogPaths.map(path => readFile(path, "utf8").catch(() => "")));
  return `${stdout}\n${stderr}`;
}

async function waitFor(check, timeout = 45000, failureMessage = "Default launch did not become ready.", intervalMs = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`Candidate exited early: ${child.exitCode}`);
    if (launchServicesChild && launchServicesChild.exitCode !== null)
      throw new Error(`LaunchServices exited early: ${launchServicesChild.exitCode}\n${await launchOutput()}`);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${failureMessage}\n${await launchOutput()}`);
}
async function launch() {
  launchCount += 1;
  candidatePidsBeforeLaunch = new Set(candidatePids());
  launchLogPaths = [join(launchLogs, `launch-${launchCount}.stdout`), join(launchLogs, `launch-${launchCount}.stderr`)];
  launchServicesChild = spawn("/usr/bin/open", [
    "-n", "-W", "-a", candidate,
    "--env", `KESTREL_NATIVE_TEST_PROFILE_ROOT=${profile}`,
    "--stdout", launchLogPaths[0], "--stderr", launchLogPaths[1],
  ], { stdio: "ignore" });
  await waitFor(async () => {
    const output = await launchOutput();
    if (!output.includes("KESTREL_CHROMIUM_DESKTOP_TAB_READY")) return false;
    nativePid = Number(output.match(/KESTREL_CHROMIUM_DESKTOP_TAB_READY pid=(\d+)/)?.[1]);
    return Number.isSafeInteger(nativePid) && !candidatePidsBeforeLaunch.has(nativePid) && candidatePids().includes(nativePid);
  }, 45000, "LaunchServices did not create Kestrel's first browser window.");
  await waitFor(async () => {
    const output = await launchOutput();
    const appReady = output.includes("KESTREL_CHROMIUM_DESKTOP_BRIDGE_READY");
    return appReady;
  }, 45000, "Kestrel became foreground but its native browser frame/Core bridge did not become ready.");
  await waitFor(() => {
    const front = frontmostApplication();
    return front?.pid === nativePid && front.bundlePath === candidate;
  }, 10000, "Kestrel's full shell loaded, but macOS kept another app in front.");
  await waitFor(() => nativeWindowTitles(nativePid).includes("Kestrel"), 10000,
    "Kestrel's native browser window did not expose its own Kestrel identity.", 500);
  console.log("PASS LaunchServices presented the native Kestrel browser frame and activated its process.");
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Candidate failed to quit cleanly.")), 15000);
    launchServicesChild.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  process.kill(nativePid, "SIGTERM");
  const exit = await exited;
  assert.equal(exit.code, 0, `LaunchServices default launch failed to quit cleanly: ${JSON.stringify(exit)}`);
  child = undefined;
  launchServicesChild = undefined;
  nativePid = undefined;
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
  await assert.rejects(stat(rawTestKeyPath), { code: "ENOENT" });
  assert.equal((await stat(localVaultPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(join(profile, ".kestrel-native-default-v1"), "utf8")), "kestrel-native-v1\n");
  await launch();
  await assert.rejects(stat(legacyKeyPath), { code: "ENOENT" });
  await assert.rejects(stat(rawTestKeyPath), { code: "ENOENT" });
  assert.equal((await stat(localVaultPath)).mode & 0o777, 0o600);
  console.log("LaunchServices no-argument Chromium-owned Kestrel frame, foreground native window, authenticated UI/Core bridge, local-vault persistence across restart, and clean shutdown passed. No Keychain prompt appeared; no test-key mode was used.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await stopped;
  }
  if (launchServicesChild && launchServicesChild.exitCode === null) {
    const startedByThisLaunch = candidatePids().filter(pid => !candidatePidsBeforeLaunch.has(pid));
    const ownedPid = Number.isSafeInteger(nativePid) && !candidatePidsBeforeLaunch.has(nativePid) ? [nativePid] : [];
    for (const pid of [...new Set([...startedByThisLaunch, ...ownedPid])]) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await new Promise(resolve => launchServicesChild.once("exit", resolve));
  }
  await rm(profile, { recursive: true, force: true });
  await rm(launchLogs, { recursive: true, force: true });
}
