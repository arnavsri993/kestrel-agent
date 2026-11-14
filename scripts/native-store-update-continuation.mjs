import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const formatter = "bcjindcccaagfpapjjmafapmmgkkhgoa";
const action = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const ids = [formatter, action];
const maxBytes = 128 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const witnessKeys = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];

function privateFile(info) {
  assert(info.isFile() && !info.isSymbolicLink(), "Continuation must be a regular file without symbolic links.");
  assert.equal(info.uid, BigInt(process.getuid()), "Continuation must belong to the current user.");
  assert.equal(info.nlink, 1n, "Continuation must have exactly one link.");
  assert.equal(info.mode & 0o077n, 0n, "Continuation must be private to the current user.");
  assert(info.size > 0n && info.size <= BigInt(maxBytes), "Continuation must be nonempty and bounded.");
}
function sameWitness(before, after) {
  for (const key of witnessKeys) assert.equal(after[key], before[key], "Continuation changed while being read.");
}
async function readReceipt(path) {
  assert.equal(await realpath(path), path, "Continuation path must not traverse symbolic links.");
  const before = await lstat(path, { bigint: true });
  privateFile(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    privateFile(opened); sameWitness(before, opened);
    // A fixed allocation also bounds reads if the file grows after fstat.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    assert.equal(BigInt(length), opened.size, "Continuation size changed while being read.");
    sameWitness(opened, await handle.stat({ bigint: true }));
    const after = await lstat(path, { bigint: true });
    privateFile(after); sameWitness(opened, after);
    assert.equal(await realpath(path), path, "Continuation path changed while being read.");
    const content = bytes.subarray(0, length);
    return { receipt: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)),
      sha256: createHash("sha256").update(content).digest("hex") };
  } finally { await handle.close(); }
}
function object(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return value;
}
function version(value) {
  assert(typeof value === "string" && /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value), "Store versions must use normalized Chrome version numbers.");
  const parts = value.split(".").map(Number);
  assert(parts.every(part => part <= 65535) && parts.some(part => part > 0), "Store version is outside Chrome's supported range.");
  return parts;
}
function newer(left, right) {
  const a = version(left), b = version(right);
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
function rejectContinuation(value) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(!/continuation/i.test(key), "A continuation cannot itself continue another receipt.");
    rejectContinuation(child);
  }
}

// Read only the prior failed receipt. Candidate and fixture identity are supplied
// by the caller's independently verified current candidate/checkpoint. This does
// not open a profile or prove that Chrome installed the pending update.
export async function loadStoreUpdateContinuation(receiptPath, { candidate, candidateSha256, checkpoint, fixtureReceiptSha256, actionExtensionId, fixtureStorageMode = "test-key", fixtureStorage }) {
  assert.equal(typeof receiptPath, "string");
  assert.equal(typeof candidate, "string"); assert.equal(candidate, resolve(candidate));
  assert.equal(typeof checkpoint, "string"); assert.equal(checkpoint, resolve(checkpoint));
  assert.match(candidateSha256, sha256); assert.match(fixtureReceiptSha256, sha256);
  assert.equal(actionExtensionId, action, "Only the known action extension can continue a pending Store query.");
  const path = resolve(receiptPath);
  assert.notEqual(path, checkpoint, "A checkpoint cannot be its own continuation receipt.");
  assert.notEqual(path, candidate);
  const { receipt, sha256: receiptSha256 } = await readReceipt(path);
  object(receipt, "Continuation receipt"); rejectContinuation(receipt);
  assert.equal(receipt.kind, "native-store-update-resume"); assert.equal(receipt.version, 1);
  assert.equal(receipt.mode, "update-acceptance");
  assert(["test-key", "production-vault"].includes(fixtureStorageMode), "Unknown fixture storage mode.");
  assert.equal(receipt.fixtureStorageMode ?? "test-key", fixtureStorageMode, "Continuation fixture storage mode changed.");
  assert.equal(receipt.fixtureStorageChanged, undefined, "Continuation reported changed fixture storage.");
  assert.equal(receipt.shutdownFailed, undefined, "Continuation did not stop cleanly.");
  if (fixtureStorageMode === "production-vault") {
    assert.equal(fixtureStorage?.mode, "production-vault");
    assert.deepEqual(receipt.fixtureStorage, fixtureStorage, "Continuation vault evidence changed.");
    assert(Array.isArray(receipt.stops) && receipt.stops.length > 0, "Production continuation requires clean stops.");
    for (const stop of receipt.stops) {
      assert.equal(stop.exitCode, 0); assert.equal(stop.signal, null);
      assert.equal(stop.forced, false); assert.equal(stop.candidateProcessesStopped, true);
    }
  }
  assert.equal(receipt.candidate, candidate);
  assert.equal(receipt.candidateSha256, candidateSha256);
  assert.equal(receipt.candidateSha256After, candidateSha256);
  assert.equal(receipt.candidateChanged, undefined);
  const fixture = object(receipt.fixture, "Continuation fixture");
  assert.equal(fixture.checkpoint, checkpoint); assert.equal(fixture.receiptSha256, fixtureReceiptSha256);
  assert.equal(receipt.result, "failed"); assert.equal(receipt.failedStage, "official-update-check");
  assert.equal(receipt.updateQueryRequested, true); assert.equal(receipt.profileRetained, true);
  const check = object(receipt.updateCheck, "Continuation update check");
  assert.equal(check.status, "update_available"); assert.equal(check.checkSucceeded, true);
  const baselineVersions = object(receipt.diskVersionsBefore, "Continuation disk versions");
  assert.deepEqual(Object.keys(baselineVersions).sort(), [...ids].sort());
  const initial = object(receipt.initial, "Continuation initial provenance");
  assert.deepEqual(Object.keys(initial).sort(), [...ids].sort());
  for (const id of ids) {
    version(baselineVersions[id]);
    const entry = object(initial[id], "Continuation extension provenance");
    assert.equal(entry.id, id); assert.equal(entry.enabled, true); assert.equal(entry.installType, "normal");
    version(entry.version); assert.equal(entry.version, baselineVersions[id]);
  }
  assert(newer(check.reportedVersion, baselineVersions[action]), "Reported Store update must be newer than the original on-disk action version.");
  assert(Number.isSafeInteger(receipt.initialSessionCount) && receipt.initialSessionCount >= 0, "Continuation must record the original Core session count.");
  return { path, sha256: receiptSha256, baselineVersions: { ...baselineVersions },
    updateCheck: { status: check.status, reportedVersion: check.reportedVersion, checkSucceeded: true },
    initialSessionCount: receipt.initialSessionCount };
}
