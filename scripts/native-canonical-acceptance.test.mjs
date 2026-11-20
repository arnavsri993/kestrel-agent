import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { candidateDigest, validateNativeExtensionParityEvidence, validateRetirementEvidence } from "./native-retirement-evidence.mjs";
import { validateNativeCanonicalAcceptance, waitForNativeCanonicalAcceptance } from "./native-canonical-acceptance.mjs";

// Parser/transaction fixture tests do not stand in for any real release gate.
vi.mock("./native-retirement-evidence.mjs", async importOriginal => ({
  ...await importOriginal(), validateRetirementEvidence: vi.fn(async () => ({ problems: [] })),
  validateNativeExtensionParityEvidence: vi.fn(async () => ({ problems: [] })),
}));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const roots = [];
const sharp = createRequire(new URL("../apps/core-service/package.json", import.meta.url))("sharp");
beforeEach(() => { vi.mocked(validateRetirementEvidence).mockClear(); vi.mocked(validateNativeExtensionParityEvidence).mockClear(); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-canonical-evidence-unit-"))); roots.push(root);
  const target = join(root, "Applications", "Kestrel.app"); await mkdir(target, { recursive: true });
  await writeFile(join(target, "inert-unit-fixture"), "not an executable app");
  const transactionId = randomUUID(), candidateSha256 = await candidateDigest(target);
  const transaction = { target, candidateSha256, previousSha256: "b".repeat(64), transactionId,
    transactionPath: join(dirname(target), ".Kestrel-cutover-backups", transactionId, "transaction.json"), startedAt: new Date(Date.now() - 1000).toISOString() };
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png().toBuffer();
  await writeFile(join(root, "inert-header-unit.png"), png, { mode: 0o600 });
  const proof = { version: 1, kind: "native-canonical-workflow-observation", result: "passed", ...transaction,
    candidateSha256After: candidateSha256, observedAt: new Date().toISOString(), runningPid: 123,
    checks: { runningNativeIdentity: true, visibleCanonicalWindow: true, sameWindowKestrelWorkflow: true, userDataPreserved: true, ownedAppStoppedCleanly: true },
    screenshots: [{ path: "inert-header-unit.png", sha256: hash(png) }], scope: "Synthetic parser fixture, never runtime or on-screen acceptance." };
  const proofPath = join(root, "observation.json"), wrapperPath = join(root, "canonical.json"), manifestPath = join(root, "evidence.json");
  const manifest = { version: 1, candidateSha256, gates: {} };
  async function save(include = true) {
    const proofBytes = Buffer.from(JSON.stringify(proof)); await writeFile(proofPath, proofBytes, { mode: 0o600 });
    const wrapper = { version: 1, gate: "canonical-dock-app-on-screen", candidateSha256, result: "passed", observedAt: proof.observedAt,
      summary: "Synthetic unit fixture only", artifacts: [{ kind: proof.kind, path: "observation.json", sha256: hash(proofBytes) }] };
    const bytes = Buffer.from(JSON.stringify(wrapper)); await writeFile(wrapperPath, bytes, { mode: 0o600 });
    if (include) manifest.gates[wrapper.gate] = { receipt: "canonical.json", sha256: hash(bytes) }; else delete manifest.gates[wrapper.gate];
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  }
  await save();
  return { root, target, transaction, proof, proofPath, wrapperPath, manifest, manifestPath, save };
}
it("requires transaction-bound observations and full retirement/parity validation", async () => {
  const f = await fixture(), result = await validateNativeCanonicalAcceptance(f);
  expect(result.pending).toBe(false); expect(result.observationPath).toBe(f.proofPath);
  expect(validateRetirementEvidence).toHaveBeenCalledWith(f.target, f.manifestPath);
  expect(validateNativeExtensionParityEvidence).toHaveBeenCalledWith(f.target, f.manifestPath, f.transaction.candidateSha256);
});
it("waits only when the canonical gate is absent, then times out or aborts without accepting retirement", async () => {
  const f = await fixture(); await f.save(false);
  expect(await validateNativeCanonicalAcceptance(f)).toEqual({ pending: true });
  await expect(waitForNativeCanonicalAcceptance(f, { timeoutMs: 15, pollMs: 5 })).rejects.toThrow(/timed out/);
  const controller = new AbortController(); controller.abort(Error("fixture interruption"));
  await expect(waitForNativeCanonicalAcceptance(f, { signal: controller.signal })).rejects.toThrow(/fixture interruption/);
  expect(validateRetirementEvidence).not.toHaveBeenCalled();
});
it("refuses acceptance if validation finishes after the observation deadline", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.mocked(validateRetirementEvidence).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 101); return { problems: [] };
    });
    await expect(waitForNativeCanonicalAcceptance(f, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  } finally { vi.useRealTimers(); }
});
it.each([
  ["stale transaction", p => { p.transactionId = randomUUID(); }], ["another path", p => { p.target += "-other"; }],
  ["another journal", p => { p.transactionPath += "-other"; }], ["changed candidate", p => { p.candidateSha256After = "c".repeat(64); }],
  ["another prior app", p => { p.previousSha256 = "c".repeat(64); }], ["pre-install observation", p => { p.observedAt = "2000-01-01T00:00:00Z"; }],
  ["future observation", p => { p.observedAt = new Date(Date.now()+120_000).toISOString(); }],
  ["no running identity", p => { p.checks.runningNativeIdentity = false; }], ["no visible workflow", p => { p.checks.sameWindowKestrelWorkflow = false; }],
  ["no clean stop", p => { p.checks.ownedAppStoppedCleanly = false; }], ["no screenshots", p => { p.screenshots = []; }],
  ["escaped screenshot", p => { p.screenshots[0].path = "../outside.png"; }], ["generic observation", p => { p.kind = "generic-passed"; }],
])("rejects %s instead of turning an attestation into final acceptance", async (_name, mutate) => {
  const f = await fixture(); mutate(f.proof); await f.save();
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow();
});
it("rejects changed screenshots, changed app bytes and failed full gates", async () => {
  const f = await fixture(), screenshot = join(f.root, "inert-header-unit.png"), original = await readFile(screenshot);
  await writeFile(screenshot, "changed"); await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow(/screenshot changed/);
  await writeFile(screenshot, original);
  vi.mocked(validateRetirementEvidence).mockResolvedValueOnce({ problems: ["native-local-vault: missing"] });
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow(/retirement acceptance/);
  await writeFile(join(f.target, "inert-unit-fixture"), "changed app");
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow(/Installed candidate changed/);
});
it("rejects public observations and symbolic/hard link aliases", async () => {
  const f = await fixture(); await chmod(f.proofPath, 0o644);
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow(/safe permissions/);
  await chmod(f.proofPath, 0o600);
  const hard = join(f.root, "alias-hard"); await link(f.proofPath, hard);
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow(/single-link/);
  await rm(hard); const bytes = await readFile(f.proofPath); await rm(f.proofPath);
  const other = join(f.root, "other.json"); await writeFile(other, bytes, { mode: 0o600 }); await symlink(other, f.proofPath);
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow(/traverse links/);
});
it("rejects a hash-matched but truncated PNG instead of accepting its header as a screenshot", async () => {
  const f = await fixture(), screenshot = join(f.root, "inert-header-unit.png");
  const bytes = (await readFile(screenshot)).subarray(0, 24); await writeFile(screenshot, bytes);
  f.proof.screenshots[0].sha256 = hash(bytes); await f.save();
  await expect(validateNativeCanonicalAcceptance(f)).rejects.toThrow();
});
