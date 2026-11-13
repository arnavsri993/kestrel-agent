import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile, validateDisposableNativeTestProfile } from "./native-test-profile.mjs";
import { validateVaultCanaryCandidate } from "./native-vault-canary-candidate.mjs";

// This records generated-fixture provenance, not release acceptance. Callers
// must confirm the owned app and helpers stopped cleanly before capture.
const states = new WeakMap();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const vaultName = ".kestrel-local-vault-v1";
const forbidden = [".kestrel-native-test-profile-v1", ".kestrel-native-test-core-key-v1"];
const magic = Buffer.from([0x4b, 0x53, 0x54, 0x56, 0x4c, 0x54, 1, 0]);
const shaPattern = /^[a-f0-9]{64}$/;

function stateFor(storage) {
 const state = states.get(storage);
 assert(state, "A selected fixture storage descriptor is required.");
 return state;
}
function assertCandidateStopped(candidate) {
 const rows = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
 for (const row of rows.split(/\r?\n/)) {
  const match = row.trim().match(/^\d+\s+(.+)$/);
  assert(!match || !match[1].startsWith(`${candidate}/`), "A selected candidate process is still running.");
 }
}
// Do not terminate any process: callers own their launch and cleanup lifecycle.
export function assertNativeBrowserFixtureStopped(storage) {
 assertCandidateStopped(stateFor(storage).candidate);
}
async function profileInfo(profile) {
 assert.equal(typeof profile, "string");
 const temporary = await realpath(tmpdir());
 const canonical = await realpath(resolve(profile));
 const name = basename(canonical);
 assert.equal(dirname(canonical), temporary, "Fixture profile must be a direct temporary directory.");
 assert(name.startsWith("kestrel-chromium-desktop-canary-"), "Unexpected generated fixture profile name.");
 // Permit only the platform's temp-root alias, not an alias to the profile.
 const requested = resolve(profile);
 assert(requested === canonical || requested === join(resolve(tmpdir()), name), "Fixture profile path is aliased.");
 const info = await lstat(requested);
 assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700,
  "Fixture profile must be an owned private directory.");
 return { canonical, dev: info.dev, ino: info.ino };
}
async function noTestKeys(profile) {
 for (const name of forbidden) {
  const info = await lstat(join(profile, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  assert(!info, "Production-vault fixtures must not contain a test marker or raw test key.");
 }
}
async function vaultDigest(profile) {
 await noTestKeys(profile);
 const path = join(profile, vaultName);
 assert.equal(await realpath(path), path, "Vault path is aliased.");
 const pathBefore = await lstat(path);
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat();
  assert(info.isFile() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o777) === 0o600 && info.size > magic.length && info.size <= 16384,
   "Fixture vault must be an owned, single-link, bounded private regular file.");
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
   a.uid === b.uid && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  assert(same(pathBefore, info), "Fixture vault changed before inspection.");
  // A fixed-size buffer also detects growth after stat without allocating for
  // attacker-controlled file size. Read one byte past the permitted maximum.
  const buffer = Buffer.alloc(16385);
  let length = 0;
  while (length < buffer.length) {
   const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
   if (!bytesRead) break;
   length += bytesRead;
  }
  const bytes = buffer.subarray(0, length);
  const after = await file.stat();
  const pathAfter = await lstat(path);
  assert.equal(bytes.length, info.size);
  assert(same(info, after) && same(info, pathAfter) && await realpath(path) === path,
   "Fixture vault changed during inspection.");
  assert(bytes.subarray(0, magic.length).equals(magic), "Fixture vault has an invalid envelope.");
  return hash(bytes);
 } finally { await file.close(); }
}
async function verifyCandidate(state) {
 if (state.mode === "production-vault") {
  const checked = await validateVaultCanaryCandidate(state.candidate, { root: state.root });
  assert.equal(checked.candidate, state.candidate);
 }
 assert.equal(await candidateDigest(state.candidate), state.candidateSha256, "Fixture candidate changed.");
}
export async function selectNativeBrowserFixtureStorage({ candidate, root }) {
 const mode = process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT === "1" ? "production-vault" : "test-key";
 // Bind the live-provider opt-in to this selection, including later restarts.
 // It authorizes discovery only; no vendor paths or credentials are inherited.
 const realCodexRequested = process.env.KESTREL_TEST_REAL_CODEX === "1";
 const selected = mode === "production-vault" ? (await validateVaultCanaryCandidate(candidate, { root })).candidate : await realpath(resolve(candidate));
 const candidateSha256 = await candidateDigest(selected);
 const descriptor = Object.freeze({ mode, candidate: selected, candidateSha256 });
 states.set(descriptor, { mode, candidate: selected, candidateSha256, root, profile: null, realCodexRequested });
 return descriptor;
}
export async function prepareNativeBrowserFixtureProfile({ profile, storage }) {
 const state = stateFor(storage);
 assert.equal(state.profile, null, "Fixture storage is already bound to a profile.");
 await verifyCandidate(state);
 const info = await profileInfo(profile);
 assert.deepEqual(await readdir(info.canonical), [], "Fixture profile must start empty.");
 if (state.mode === "test-key") await markDisposableNativeTestProfile(info.canonical);
 state.profile = info;
 return info.canonical;
}
export function nativeBrowserFixtureStorageArgs(storage) {
 return stateFor(storage).mode === "test-key" ? ["--kestrel-test-profile-key"] : [];
}
export function nativeBrowserFixtureStorageEnv(storage) {
 const state = stateFor(storage);
 if (state.mode === "test-key") return { ...process.env };
 return { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: "en_US.UTF-8",
  ...(!state.realCodexRequested ? { KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" } : {}),
  KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" };
}
export async function captureNativeBrowserFixtureStorage({ profile, storage }) {
 const state = stateFor(storage);
 assert(state.profile, "Fixture profile was not prepared.");
 assertCandidateStopped(state.candidate);
 await verifyCandidate(state);
 const info = await profileInfo(profile);
 assert.deepEqual(info, state.profile, "Fixture profile changed since preparation.");
 const evidence = { kind: "native-browser-fixture-storage", version: 1, mode: state.mode, profile: info.canonical,
  candidate: state.candidate, candidateSha256: state.candidateSha256, profileDev: info.dev, profileIno: info.ino };
 if (state.mode === "production-vault") evidence.vaultSha256 = await vaultDigest(info.canonical);
 else await validateDisposableNativeTestProfile(info.canonical);
 return evidence;
}
export async function validateRetainedNativeBrowserFixtureStorage({ profile, candidate, candidateCopy, candidateSha256, evidence, root }) {
 assert(evidence && evidence.kind === "native-browser-fixture-storage" && evidence.version === 1);
 assert(["test-key", "production-vault"].includes(evidence.mode));
 assert.match(candidateSha256 ?? "", shaPattern);
 assert.equal(evidence.candidate, candidate); assert.equal(evidence.candidateSha256, candidateSha256);
 if (candidateCopy !== undefined) {
  assert.equal(evidence.mode, "production-vault", "A candidate copy is only supported for production-vault fixtures.");
  assert.equal(candidateCopy, resolve(candidateCopy), "Select an absolute canonical candidate copy.");
 }
 // The frozen receipt keeps the original path. A separately selected copy
 // must pass full production preflight and the exact complete-bundle digest;
 // neither the original receipt nor its profile/vault identity is rewritten.
 const selected = candidateCopy ?? candidate;
 const state = { mode: evidence.mode, candidate: selected, candidateSha256, root };
 assertCandidateStopped(candidate);
 if (selected !== candidate) assertCandidateStopped(selected);
 await verifyCandidate(state);
 const info = await profileInfo(profile);
 assert.equal(evidence.profile, info.canonical); assert.equal(evidence.profileDev, info.dev); assert.equal(evidence.profileIno, info.ino);
 if (state.mode === "production-vault") {
  assert.match(evidence.vaultSha256 ?? "", shaPattern);
  assert.equal(await vaultDigest(info.canonical), evidence.vaultSha256, "Fixture vault changed.");
 } else {
  assert.equal(evidence.vaultSha256, undefined);
  await validateDisposableNativeTestProfile(info.canonical);
 }
 return info.canonical;
}
