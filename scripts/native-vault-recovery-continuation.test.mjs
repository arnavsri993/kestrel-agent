import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { loadNativeVaultRecoveryContinuation } from "./native-vault-recovery-continuation.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = [], digest = bytes => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
 await mkdir(join(repository, ".tmp"), { recursive: true });
 const directory = await mkdtemp(join(repository, ".tmp/native-continuation-fixture-")); directories.push(directory);
 const candidate = join(directory, "Kestrel.app"), hash = "a".repeat(64);
 const source = join(await realpath(tmpdir()), `kestrel-chromium-desktop-canary-${randomUUID()}`);
 const owner = join(await realpath(tmpdir()), `kestrel-chromium-desktop-canary-${randomUUID()}`);
 const relative = `native-core-profiles/${randomUUID()}`, handoff = randomUUID();
 const selection = { version: 2, active: "", previous: "", handoffs: { "": null, [relative]: handoff } };
 const interruption = { boundary: "published-before-activation", parent: { pid: 12345, ppid: 12344, executable: join(candidate, "Contents/MacOS/Kestrel"), started: "generated parent start" },
  journalOwner: { pid: 12346, ppid: 12345, executable: join(candidate, "Contents/Resources/agent-core/node/bin/node"), started: "generated worker start" },
  workerSignalled: false, sourceKeyExported: false, productWorkerInjected: false };
 const evidence = profile => ({ kind: "native-browser-fixture-storage", version: 1, mode: "production-vault", candidate, candidateSha256: hash, profile, profileDev: 1, profileIno: 2, vaultSha256: "b".repeat(64) });
 const receipt = { kind: "native-vault-published-recovery-canary", version: 1, result: "failed", failedStage: "restart-D-after-crash", exactCandidateAbsent: true, generatedProfilesRemoved: false,
  publishedRecoveryRequested: true, modalQuitRequested: false, candidate, candidateSha256: hash, candidateSha256After: hash,
  retainedProfiles: { A: source, D: owner }, fixtureEvidence: { A: evidence(source), D: evidence(owner) }, sourceSnapshots: { A: { generated: null } },
  phases: [{ phase: "A-production-vault-generated-session-restart-readback-and-snapshot", passed: true }, { phase: "production-published-parent-crash-left-source-and-selection-preserved", passed: true }],
  stages: [{ stage: "published-crash-D", pid: 12345, code: null, signal: "SIGKILL", ...structuredClone(interruption), preparedRelative: relative, reviewedSelection: structuredClone(selection), journalSha256: "c".repeat(64), vaultSha256: "d".repeat(64) }] };
 const receiptPath = join(directory, "failed.json"), interruptionPath = join(directory, "interruption.json"), path = join(directory, "continuation.json");
 const spec = { kind: "native-vault-recovery-continuation", version: 1, nonce: "1234abcd", candidateSha256: hash,
  failedReceipt: { path: receiptPath, sha256: "" }, interruption: { path: interruptionPath, sha256: "" }, preparedRelative: relative,
  reviewedSelection: selection, journalSha256: "c".repeat(64), vaultSha256: "d".repeat(64) };
 async function save() {
  for (const [target, value] of [[receiptPath, receipt], [interruptionPath, interruption]]) await writeFile(target, JSON.stringify(value), { mode: 0o600 });
  spec.failedReceipt.sha256 = digest(await readFile(receiptPath)); spec.interruption.sha256 = digest(await readFile(interruptionPath));
  await writeFile(path, JSON.stringify(spec), { mode: 0o600 });
 }
 await save();
 return { directory, receipt, interruption, spec, path, receiptPath, interruptionPath, save,
  load: () => loadNativeVaultRecoveryContinuation(path, { candidateSha256: hash }) };
}
describe("generated production recovery continuation", () => {
 it("binds original failure, interrupted process, selected child and opaque digests", async () => {
  const f = await fixture(), value = await f.load();
  assert.equal(value.originalTitle, "Recovery D original 1234abcd");
  assert.equal(value.sourceExpectation.message, "Generated A message 1234abcd");
  assert.equal(value.witnessOrigin, "published-crash-stage"); assert.equal(value.prepared.relative, f.spec.preparedRelative);
  assert.equal(value.failedReceiptSha256, digest(await readFile(f.receiptPath)));
 });
 it("keeps older failed evidence distinct with explicit post-failure checkpoints", async () => {
  const f = await fixture();
  for (const key of ["preparedRelative", "reviewedSelection", "journalSha256", "vaultSha256"]) delete f.receipt.stages[0][key];
  await f.save(); await assert.rejects(f.load(), /explicit post-failure/);
  f.spec.witnessOrigin = "post-failure-generated-fixture"; await f.save();
  assert.equal((await f.load()).witnessOrigin, "post-failure-generated-fixture");
 });
 for (const [label, mutate] of [
  ["wrong failure state", f => { f.receipt.result = "passed"; }],
  ["changed candidate", f => { f.receipt.candidateSha256After = "e".repeat(64); }],
  ["extra retained profile", f => { f.receipt.retainedProfiles.extra = f.receipt.retainedProfiles.A; }],
  ["different journal owner", f => { f.interruption.journalOwner.pid++; }],
  ["different reviewed mapping", f => { f.receipt.stages[0].reviewedSelection = { ...f.spec.reviewedSelection, previous: f.spec.preparedRelative }; }],
  ["changed journal digest", f => { f.spec.journalSha256 = "e".repeat(64); }],
  ["partial crash witnesses", f => { delete f.receipt.stages[0].vaultSha256; f.spec.witnessOrigin = "post-failure-generated-fixture"; }],
 ]) it(`rejects ${label}`, async () => { const f = await fixture(); mutate(f); await f.save(); await assert.rejects(f.load()); });
 it("rejects tampered referenced receipt without updating its frozen digest", async () => {
  const f = await fixture(); await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, extra: true }), { mode: 0o600 }); await assert.rejects(f.load(), /digest changed/);
 });
 for (const unsafe of ["public", "hardlink", "oversized"]) it(`rejects ${unsafe} continuation files`, async () => {
  const f = await fixture();
  if (unsafe === "public") await chmod(f.path, 0o644);
  if (unsafe === "hardlink") await link(f.path, join(f.directory, "alias.json"));
  if (unsafe === "oversized") await writeFile(f.path, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(f.load());
 });
});
