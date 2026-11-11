#!/usr/bin/env node
// Hardware Core-key fixture only. This is not candidate-bound release evidence.
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";
import { createInterface } from "node:readline";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { validateRealKeychainCandidate, assertNoExactExecutableRunning } from "./native-real-keychain-candidate.mjs";

assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "apps/native-chromium-host/src");
const tempRoot = await realpath(join(root, ".tmp"));
assert.equal(tempRoot, join(root, ".tmp"));
const tempStat = await lstat(tempRoot);
assert(tempStat.isDirectory() && !tempStat.isSymbolicLink() && tempStat.uid === process.getuid() && !(tempStat.mode & 0o022));
const evidence = join(tempRoot, `native-local-vault-core-fixture-${Date.now()}-${randomUUID()}`);
await mkdir(evidence, { mode: 0o700 });
const work = join(evidence, "work");
await mkdir(work, { mode: 0o700 });
assert.equal(await realpath(work), work);
const app = join(work, "VaultFixture.app"), macos = join(app, "Contents/MacOS");
const executable = join(macos, "VaultFixture"), helper = join(macos, "Kestrel Vault"), object = join(work, "vault.o");
const receipt = { version: 1, gate: "native-local-vault-core-fixture", result: "failed", notCandidateBound: true, encryptedDatabaseVerified: false, coreKeyRestartVerified: false, noKeychainItemAPIs: "production source path uses no item APIs; system internals not observed", scope: "Standalone Core profile key fixture only; no Kestrel app, Chromium, candidate, database encryption, signing or user data proof." };
let stage = "setup";
const coreApp = process.env.KESTREL_NATIVE_TEST_APP;
function command(args) { execFileSync("/usr/bin/xcrun", args, { stdio: "pipe", timeout: 60000 }); }
function run(mode, profile) {
 const result = spawnSync(executable, [mode, profile], { encoding: "utf8", timeout: 20000, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), LANG: "en_US.UTF-8" } });
 assert(!result.error && result.status === 0 && result.signal === null, `Fixture failed during ${stage}.`);
 assert.equal(result.stderr, "");
 if (mode === "refuse") { assert.equal(result.stdout, ""); return; }
 assert.match(result.stdout, /^[a-f0-9]{64}\n$/); return result.stdout.trim();
}

// Optional integration with a selected bundle's actual Node/Core resources.
// The production key store is in this compiled fixture, not Kestrel's main
// process. This evidence cannot satisfy the candidate-bound release gate.
async function verifyBundledCore(profile) {
 const { candidate, executable: browserExecutable } = await validateRealKeychainCandidate(coreApp, { root });
 assertNoExactExecutableRunning(browserExecutable);
 const before = await candidateDigest(candidate);
 const resources = join(candidate, "Contents/Resources");
 const fixture = `local-vault-encrypted-core:${randomUUID()}`;
 let active;
 async function stop() {
  if (!active) return;
  const owned = active; active = undefined;
  if (owned.child.exitCode === null && owned.child.signalCode === null)
   owned.child.stdin.end(JSON.stringify({ type: "shutdown" }) + "\n");
  const timer = setTimeout(() => owned.child.kill("SIGKILL"), 10000);
  try {
   const outcome = await owned.exited;
   assert(outcome.code === 0 && outcome.signal === null, "Bundled Core did not stop cleanly.");
  } finally { clearTimeout(timer); owned.lines.close(); }
 }
 function start() {
  const child = spawn(join(resources, "agent-core/node/bin/node"),
   [join(resources, "native-core-relay.mjs"), "--profile-root", profile, "--durable-profile"],
   { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: work, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
    KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" } });
  const messages = [], listeners = new Set(); let failed = false, requestedKey = false, next = 0;
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", () => {}); // Never include process output or key frames in diagnostics.
  child.stdin.on("error", () => { failed = true; for (const notify of listeners) notify(); });
  child.on("error", () => { failed = true; for (const notify of listeners) notify(); });
  const exited = new Promise(resolveExit => child.once("exit", (code, signal) => {
   resolveExit({ code, signal }); for (const notify of listeners) notify();
  }).once("error", () => resolveExit({ code: null, signal: null })));
  lines.on("line", line => {
   if (Buffer.byteLength(line) > 1024 * 1024) { failed = true; for (const notify of listeners) notify(); return; }
   let frame; try { frame = JSON.parse(line); } catch { failed = true; }
   if (frame?.type === "native-core-profile-key-request") {
    if (requestedKey || frame.requestId !== "native-core-profile-key-v1") { failed = true; }
    else {
     requestedKey = true;
     // Native fixture returns only over a captured pipe. No key is written to
     // a log, receipt, file, argument or environment variable.
     const response = spawnSync(executable, ["private-core-key", profile], {
      input: "kestrel-vault-core-fixture-key-v1\n", timeout: 20000, maxBuffer: 1024,
      env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8" } });
     const key = response.stdout;
     if (response.error || response.status !== 0 || response.signal !== null ||
         !Buffer.isBuffer(key) || key.length !== 45 || !/^[A-Za-z0-9+/]{43}=\n$/.test(key.toString("ascii"))) {
      failed = true;
     } else {
      child.stdin.write(JSON.stringify({ type: "native-core-profile-key-response", requestId: frame.requestId,
       ok: true, keyBase64: key.subarray(0, 44).toString("ascii") }) + "\n");
     }
     if (Buffer.isBuffer(key)) key.fill(0);
    }
   } else if (frame) {
    if (messages.length >= 256) failed = true; else messages.push(frame);
   }
   for (const notify of listeners) notify();
  });
  function wait(predicate) {
   return new Promise((resolveWait, rejectWait) => {
    const finish = (failure, value) => { clearTimeout(timer); listeners.delete(check); failure ? rejectWait(new Error("Bundled Core private protocol failed or timed out.")) : resolveWait(value); };
    const check = () => {
     const frame = messages.find(predicate);
     if (failed) finish(true);
     else if (frame) finish(false, frame);
     else if (child.exitCode !== null || child.signalCode !== null) finish(true);
    };
    const timer = setTimeout(() => finish(true), 30000);
    listeners.add(check); check();
   });
  }
  active = { child, lines, exited };
  return {
   ready: () => wait(frame => frame.type === "ready"),
   async request(request) {
    const id = `vault-core-${++next}`;
    child.stdin.write(JSON.stringify({ type: "request", id, request }) + "\n");
    const frame = await wait(frame => frame.type === "response" && frame.id === id);
    assert(frame.response?.ok === true, "Bundled Core request failed.");
    return frame.response;
   },
  };
 }
 async function verifyCiphertext() {
  const directory = join(profile, "native-core/database"), names = await readdir(directory);
  assert(names.includes("kestrel.sqlite"), "Bundled Core database missing.");
  for (const name of names.filter(name => /^kestrel\.sqlite(?:$|[-.])/.test(name))) {
   const file = join(directory, name), info = await lstat(file);
   assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.size < 32 * 1024 * 1024,
    "Unexpected Core database file.");
   assert(!(await readFile(file)).includes(Buffer.from(fixture)), "Generated plaintext was present in raw database/WAL bytes.");
  }
 }
 try {
  stage = "bundled-core-encrypted-write"; console.log(`STAGE ${stage}`);
  let relay = start(); await relay.ready();
  const created = await relay.request({ type: "runtime-create-session", title: "Local vault encrypted Core fixture", kind: "conversation" });
  const sessionId = created.session?.id; assert(typeof sessionId === "string" && sessionId, "Core session missing.");
  await relay.request({ type: "runtime-append-message", sessionId, role: "user", content: fixture });
  let result = await relay.request({ type: "runtime-list-messages", sessionId });
  assert(result.messages?.some(message => message.content === fixture), "Generated message did not round-trip.");
  await stop(); await verifyCiphertext();
  stage = "bundled-core-encrypted-restart"; console.log(`STAGE ${stage}`);
  relay = start(); await relay.ready();
  result = await relay.request({ type: "runtime-list-messages", sessionId });
  assert(result.messages?.some(message => message.content === fixture), "Generated message did not decrypt after restart.");
  await stop(); await verifyCiphertext();
  assert(await candidateDigest(candidate) === before, "Selected bundle changed during Core integration fixture.");
  return { result: "passed", bundleSha256: before, bundleSha256After: before,
   nativeMainProcessExercised: false, browserExercised: false, productionKeyStore: true,
   sameProfileRestartReadback: true, generatedPlaintextAbsentFromDatabaseAndWal: true };
 } finally { await stop(); }
}
try {
 await mkdir(macos, { recursive: true, mode: 0o700 });
 await writeFile(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>VaultFixture</string><key>CFBundleIdentifier</key><string>com.kestrel.local-vault-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`, { mode: 0o600 });
 stage = "compile-swift"; compileNativeLocalVaultCrypto(object);
 const flags = ["-std=c++20", "-fobjc-arc", "-mmacosx-version-min=13.0"];
 stage = "compile-helper"; command(["clang++", ...flags, join(src, "kestrel_local_vault_crypto_helper.cc"), object, ...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security", "-o", helper]);
 stage = "compile-core-fixture"; command(["clang++", ...flags, join(src, "kestrel_native_core_keychain.mm"), join(src, "kestrel_local_vault.mm"), join(src, "kestrel_local_vault_crypto_process.mm"), join(root, "apps/native-chromium-host/tests/native_local_vault_core_fixture.mm"), object, ...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security", "-o", executable]);
 await chmod(executable, 0o700); await chmod(helper, 0o700);
 const profile = join(work, "profile"); await mkdir(profile, { mode: 0o700 });
 stage = "production-create"; console.log(`STAGE ${stage}`); const first = run("create", profile);
 const vault = join(profile, ".kestrel-local-vault-v1"), stat = await lstat(vault);
 assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
 const envelope = await readFile(vault); assert(envelope.length > 0 && envelope.length <= 16384);
 for (const path of [join(profile, ".kestrel-native-test-core-key-v1"), join(profile, "native-core/database.key")])
  await assert.rejects(lstat(path), { code: "ENOENT" });
 await mkdir(join(profile, "native-core"), { mode: 0o700 });
 stage = "production-restart-existing"; console.log(`STAGE ${stage}`); const second = run("existing", profile); assert.equal(first, second);
 receipt.coreKeyRestartVerified = true; receipt.keySha256 = first; receipt.envelopeMode0600 = true;
 if (coreApp) {
  receipt.bundledCore = await verifyBundledCore(profile);
  receipt.encryptedCorePayloadVerified = true;
  receipt.scope = "Standalone production native key-store fixture plus selected bundle's Node/Core resources. Not Kestrel's native main process, Chromium/browser, installed app, migration or release acceptance.";
 }
 const missing = join(work, "existing-without-vault"); await mkdir(missing, { mode: 0o700 }); await mkdir(join(missing, "native-core"), { mode: 0o700 });
 await writeFile(join(missing, "native-core", "sentinel"), "generated fixture data", { mode: 0o600 });
 stage = "existing-profile-no-vault"; console.log(`STAGE ${stage}`); run("refuse", missing);
 await assert.rejects(lstat(join(missing, ".kestrel-local-vault-v1")), { code: "ENOENT" });
 assert.equal(await readFile(join(missing, "native-core", "sentinel"), "utf8"), "generated fixture data");
 const corrupt = join(work, "corrupt-profile"); await mkdir(corrupt, { mode: 0o700 });
 const damaged = Buffer.from(envelope); damaged[damaged.length - 1] ^= 1; const damagedPath = join(corrupt, ".kestrel-local-vault-v1");
 await writeFile(damagedPath, damaged, { mode: 0o600 });
 stage = "corrupt-envelope-contained"; console.log(`STAGE ${stage}`); run("refuse", corrupt);
 assert.deepEqual(await readFile(damagedPath), damaged); assert.deepEqual(await readFile(vault), envelope);
 receipt.existingProfileWithoutVaultRefused = true; receipt.corruptEnvelopeRefused = true;
 receipt.result = "passed";
} catch (error) {
 if (stage.startsWith("compile-")) console.error(String(error.stderr ?? "").slice(0, 8000));
 receipt.failedStage = stage; process.exitCode = 1; console.error(`Native local-vault Core fixture failed at ${stage}.`);
} finally {
 await rm(work, { recursive: true, force: true });
 await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
if (receipt.result === "passed") console.log(`Core fixture passed; receipt: ${join(evidence, "receipt.json")}`);
