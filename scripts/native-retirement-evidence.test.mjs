import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as test } from "vitest";
import { candidateDigest, RETIREMENT_GATES, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kestrel-retirement-evidence-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "Kestrel.app");
  await mkdir(join(candidate, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(candidate, "Contents", "Resources"));
  await writeFile(join(candidate, "Contents", "MacOS", "Kestrel"), "executable");
  await writeFile(join(candidate, "Contents", "Resources", "ui"), "ui version 1");
  await symlink("ui", join(candidate, "Contents", "Resources", "ui-link"));
  const candidateSha256 = await candidateDigest(candidate);
  const artifact = Buffer.from("actual recorded supporting output");
  await writeFile(join(root, "artifact.txt"), artifact);
  const manifest = { version: 1, candidateSha256, gates: {} };
  for (const gate of RETIREMENT_GATES) {
    const receipt = Buffer.from(JSON.stringify({ version: 1, gate, candidateSha256, result: "passed", observedAt: "2026-10-29T12:00:00Z", summary: "Observed the required workflow", artifacts: [{ path: "artifact.txt", sha256: sha(artifact) }] }));
    await writeFile(join(root, `${gate}.json`), receipt);
    manifest.gates[gate] = { receipt: `${gate}.json`, sha256: sha(receipt) };
  }
  const manifestPath = join(root, "evidence.json");
  async function save() { await writeFile(manifestPath, JSON.stringify(manifest)); }
  await save();
  return { root, candidate, candidateSha256, manifest, manifestPath, save };
}

test("accepts complete candidate-bound receipts with unchanged artifacts", async t => {
  const f = await fixture(t);
  assert.deepEqual((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems, []);
});
test("rejects missing gates and an incorrect candidate", async t => {
  const f = await fixture(t);
  delete f.manifest.gates["provider-sign-in"];
  f.manifest.candidateSha256 = "0".repeat(64);
  await f.save();
  const { problems } = await validateRetirementEvidence(f.candidate, f.manifestPath);
  assert(problems.some(x => x.includes("provider-sign-in: missing")));
  assert(problems.some(x => x.includes("does not match")));
});
test("detects stale candidate resources and changed evidence artifacts", async t => {
  const f = await fixture(t);
  await writeFile(join(f.candidate, "Contents", "Resources", "ui"), "ui version 2");
  await writeFile(join(f.root, "artifact.txt"), "changed");
  const { problems } = await validateRetirementEvidence(f.candidate, f.manifestPath);
  assert(problems.some(x => x.includes("does not match")));
  assert(problems.some(x => x.includes("different candidate")));
  // Restore bundle identity to independently check artifact validation.
  await writeFile(join(f.candidate, "Contents", "Resources", "ui"), "ui version 1");
  assert((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems.some(x => x.includes("artifact missing, empty, or changed")));
});
test("rejects unverified, tampered, wrong-gate and reused receipts", async t => {
  const f = await fixture(t);
  const gate = "provider-sign-in";
  const receiptPath = join(f.root, `${gate}.json`);
  const receipt = JSON.parse(await readFile(receiptPath));
  receipt.result = "failed";
  let bytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(receiptPath, bytes);
  f.manifest.gates[gate].sha256 = sha(bytes);
  f.manifest.gates["local-models"] = f.manifest.gates[gate];
  await f.save();
  let problems = (await validateRetirementEvidence(f.candidate, f.manifestPath)).problems;
  assert(problems.some(x => x.includes(`${gate}: receipt is invalid`)));
  assert(problems.some(x => x.includes("local-models: receipt is reused")));
  receipt.result = "passed"; receipt.gate = "other";
  bytes = Buffer.from(JSON.stringify(receipt)); await writeFile(receiptPath, bytes);
  f.manifest.gates[gate].sha256 = sha(bytes); await f.save();
  problems = (await validateRetirementEvidence(f.candidate, f.manifestPath)).problems;
  assert(problems.some(x => x.includes(`${gate}: receipt is invalid`)));
  await writeFile(receiptPath, "tampered");
  problems = (await validateRetirementEvidence(f.candidate, f.manifestPath)).problems;
  assert(problems.some(x => x.includes("receipt digest mismatch")));
});
test("candidate fingerprint includes modes and symlink targets", async t => {
  const f = await fixture(t);
  await rm(join(f.candidate, "Contents", "Resources", "ui-link"));
  await symlink("../MacOS/Kestrel", join(f.candidate, "Contents", "Resources", "ui-link"));
  assert.notEqual(await candidateDigest(f.candidate), f.candidateSha256);
  await rm(join(f.candidate, "Contents", "Resources", "ui-link"));
  await symlink(f.root, join(f.candidate, "Contents", "Resources", "ui-link"));
  await assert.rejects(candidateDigest(f.candidate), /escapes/);
});


test("CLI rejects acceptance alone and does not run parity for incomplete evidence", async t => {
  const f = await fixture(t);
  const env = { ...process.env, KESTREL_ACCEPT_ELECTRON_RETIREMENT: "1" };
  delete env.KESTREL_NATIVE_RETIREMENT_EVIDENCE;
  const absent = spawnSync(process.execPath, ["scripts/check-electron-retirement-gates.mjs", f.candidate], { env, encoding: "utf8" });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /Acceptance is not evidence/);
  delete f.manifest.gates["profile-transfer-and-rollback"];
  await f.save();
  const incomplete = spawnSync(process.execPath, ["scripts/check-electron-retirement-gates.mjs", f.candidate], { env: { ...env, KESTREL_NATIVE_RETIREMENT_EVIDENCE: f.manifestPath }, encoding: "utf8" });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /profile-transfer-and-rollback: missing/);
  const noAcceptance = spawnSync(process.execPath, ["scripts/check-electron-retirement-gates.mjs", f.candidate], { env: { ...env, KESTREL_ACCEPT_ELECTRON_RETIREMENT: "0", KESTREL_NATIVE_RETIREMENT_EVIDENCE: f.manifestPath }, encoding: "utf8" });
  assert.notEqual(noAcceptance.status, 0);
  assert.match(noAcceptance.stderr, /Explicit retirement acceptance/);
});
