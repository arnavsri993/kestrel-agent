import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest, validateNativeExtensionParityEvidence, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

const gate = "canonical-dock-app-on-screen";
const kind = "native-canonical-workflow-observation";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const checks = ["runningNativeIdentity", "visibleCanonicalWindow", "sameWindowKestrelWorkflow", "userDataPreserved", "ownedAppStoppedCleanly"];
const witness = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"];
const sharp = createRequire(new URL("../apps/core-service/package.json", import.meta.url))("sharp");

async function boundedFile(path, maximum, privateFile = false) {
  assert.equal(await realpath(path), path, "Canonical evidence must not traverse links.");
  const before = await lstat(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  function safe(info) {
    assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 &&
      (info.mode & (privateFile ? 0o077 : 0o022)) === 0 && info.size > 0 && info.size <= maximum,
      "Canonical evidence must be a bounded, owned, single-link regular file with safe permissions.");
  }
  function same(a, b) { for (const key of witness) assert.equal(a[key], b[key], "Canonical evidence changed during inspection."); }
  try {
    const info = await file.stat(); safe(before); safe(info); same(before, info);
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    assert.equal(length, info.size, "Canonical evidence grew or changed during inspection.");
    same(info, await file.stat()); same(info, await lstat(path));
    assert.equal(await realpath(path), path);
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
function containedReference(base, reference) {
  assert(typeof reference === "string" && reference && !isAbsolute(reference), "Canonical artifact paths must be relative.");
  const path = resolve(base, reference), rel = relative(base, path);
  assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "Canonical artifact escapes its evidence directory.");
  return path;
}
const json = bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

// These are bound observations for reviewer inspection, not computer-vision
// proof that pixels depict the claimed workflow. A generic passed wrapper or
// an observation from a prior installation cannot complete this transaction.
export async function validateNativeCanonicalAcceptance({ target, manifestPath, transaction }) {
  assert.equal(resolve(target), target);
  assert.equal(transaction?.target, target);
  assert(uuidPattern.test(transaction.transactionId ?? ""));
  assert.equal(transaction.transactionPath, join(dirname(target), ".Kestrel-cutover-backups", transaction.transactionId, "transaction.json"));
  assert(hashPattern.test(transaction.candidateSha256 ?? "") && hashPattern.test(transaction.previousSha256 ?? ""));
  assert(Number.isFinite(Date.parse(transaction.startedAt)), "Verification requires a transaction start time.");
  const manifestFile = resolve(manifestPath), manifestBytes = await boundedFile(manifestFile, 4 * 1024 * 1024);
  const manifest = json(manifestBytes);
  assert(manifest.version === 1 && manifest.gates && typeof manifest.gates === "object" && !Array.isArray(manifest.gates));
  assert.equal(manifest.candidateSha256, transaction.candidateSha256);
  if (!Object.hasOwn(manifest.gates, gate)) return { pending: true };
  const entry = manifest.gates[gate];
  assert(hashPattern.test(entry?.sha256 ?? ""), "Canonical receipt is incomplete.");
  const wrapperPath = containedReference(dirname(manifestFile), entry.receipt);
  const wrapperBytes = await boundedFile(wrapperPath, 128 * 1024);
  assert.equal(sha(wrapperBytes), entry.sha256, "Canonical receipt digest changed.");
  const wrapper = json(wrapperBytes);
  const observations = wrapper.artifacts?.filter(item => item?.kind === kind);
  assert(Array.isArray(observations) && observations.length === 1, "A dedicated canonical workflow observation is required.");
  const reference = observations[0]; assert(hashPattern.test(reference.sha256 ?? ""));
  const proofPath = containedReference(dirname(wrapperPath), reference.path);
  const proofBytes = await boundedFile(proofPath, 128 * 1024, true);
  assert.equal(sha(proofBytes), reference.sha256);
  const proof = json(proofBytes);
  assert.equal(proof.version, 1); assert.equal(proof.kind, kind); assert.equal(proof.result, "passed");
  for (const key of ["target", "transactionId", "transactionPath", "candidateSha256", "previousSha256"])
    assert.equal(proof[key], transaction[key], `Canonical observation has a different ${key}.`);
  assert.equal(proof.candidateSha256After, transaction.candidateSha256);
  const observedAt = Date.parse(proof.observedAt);
  assert(Number.isFinite(observedAt) && observedAt >= Date.parse(transaction.startedAt) && observedAt <= Date.now() + 60_000,
    "Canonical observations must be fresh for this installed transaction.");
  assert(Number.isSafeInteger(proof.runningPid) && proof.runningPid > 0);
  for (const check of checks) assert.equal(proof.checks?.[check], true, `Missing canonical observation: ${check}.`);
  assert(Array.isArray(proof.screenshots) && proof.screenshots.length > 0 && proof.screenshots.length <= 4,
    "Canonical observations require bounded screenshot artifacts.");
  for (const screenshot of proof.screenshots) {
    assert(hashPattern.test(screenshot?.sha256 ?? ""));
    const path = containedReference(dirname(proofPath), screenshot.path);
    const bytes = await boundedFile(path, 20 * 1024 * 1024, true);
    assert.equal(sha(bytes), screenshot.sha256, "Canonical screenshot changed.");
    assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), "Canonical screenshot must be PNG.");
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: 16_777_216, sequentialRead: true });
    const metadata = await image.metadata();
    assert(metadata.format === "png" && metadata.width >= 64 && metadata.height >= 64 && (metadata.pages ?? 1) === 1,
      "Canonical screenshot must be a usable single PNG image.");
    // Force bounded decoding; a truncated header alone is not an image artifact.
    await image.raw().toBuffer();
  }
  const full = await validateRetirementEvidence(target, manifestFile);
  const parity = await validateNativeExtensionParityEvidence(target, manifestFile, transaction.candidateSha256);
  assert.deepEqual([...full.problems, ...parity.problems], [], "Full retirement acceptance is still incomplete.");
  assert.equal(await candidateDigest(target), transaction.candidateSha256, "Installed candidate changed during verification.");
  assert.equal(sha(await boundedFile(manifestFile, 4 * 1024 * 1024)), sha(manifestBytes), "Evidence manifest changed during verification.");
  return { pending: false, observationPath: proofPath, observationSha256: reference.sha256 };
}

export async function waitForNativeCanonicalAcceptance(options, { timeoutMs = 10 * 60_000, pollMs = 1000, signal } = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10 * 60_000);
  assert(Number.isInteger(pollMs) && pollMs > 0 && pollMs <= 1000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw Error("Canonical on-screen verification timed out; retirement was not accepted.");
    const result = await validateNativeCanonicalAcceptance(options);
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw Error("Canonical on-screen verification timed out; retirement was not accepted.");
    if (!result.pending) return result;
    await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
  }
}
