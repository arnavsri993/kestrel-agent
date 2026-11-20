import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as test } from "vitest";
import { candidateDigest, RETIREMENT_GATES, validateNativeExtensionParityEvidence, validateNativePreCutoverEvidence, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kestrel-retirement-evidence-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "Kestrel.app");
  await mkdir(join(candidate, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(candidate, "Contents", "Resources"));
  await writeFile(join(candidate, "Contents", "MacOS", "Kestrel"), "executable");
  await writeFile(join(candidate, "Contents", "Info.plist"), "<?xml version=\"1.0\"?><plist><dict><key>CFBundleVersion</key><string>2</string></dict></plist>");
  await writeFile(join(candidate, "Contents", "Resources", "ui"), "ui version 1");
  await symlink("ui", join(candidate, "Contents", "Resources", "ui-link"));
  const candidateSha256 = await candidateDigest(candidate);
  const artifact = Buffer.from("actual recorded supporting output");
  await writeFile(join(root, "artifact.txt"), artifact);
  const manifest = { version: 1, candidateSha256, gates: {} };
  for (const gate of RETIREMENT_GATES) {
    const artifacts = [{ path: "artifact.txt", sha256: sha(artifact) }];
    if (["native-local-vault", "native-browser-local-vault"].includes(gate)) {
      // Synthetic unit fixtures exercise the validator only; they are not release evidence.
      const kind = `${gate}-canary`;
      const proof = Buffer.from(JSON.stringify({ version: 1, kind, gate, result: "passed", provider: gate === "native-local-vault" ? "secure-enclave-local-vault" : "chromium-local-vault", candidateSha256, candidateSha256After: candidateSha256, checks: { freshGeneratedProfile: true, productionProvider: true, cleanRestart: true, sameProfileRestartReadback: true, encryptedDataVerified: true, plaintextAbsent: true, noMockProvider: true, noTestKey: true, noKeychainItemAPIs: true, persistentCookieReadback: true, encryptedCookieRow: true, tamperedCookieRejected: true, persistentPasswordReadback: true, encryptedPasswordRow: true, nativePasswordAutofill: true } }));
      await writeFile(join(root, `${kind}.json`), proof);
      artifacts.push({ kind, path: `${kind}.json`, sha256: sha(proof) });
    }
    if (gate === "native-app-update") {
      const kind = "native-app-update-canary";
      const proof = Buffer.from(JSON.stringify({ version: 1, kind, gate, result: "passed", candidateSha256, candidateSha256After: candidateSha256, previousCandidateSha256: "a".repeat(64), previousVersion: "1", installedVersion: "2", checks: Object.fromEntries(["isolatedProfile", "developerIdSignedBoth", "notarizedBoth", "sameSigningTeam", "nativeRuntimeBoth", "signatureVerified", "httpsFeed", "orderlyQuit", "cleanRestart", "profileContinuity", "vaultReadback", "candidateInstalled"].map(key => [key, true])) }));
      await writeFile(join(root, `${kind}.json`), proof);
      artifacts.push({ kind, path: `${kind}.json`, sha256: sha(proof) });
    }
    const receipt = Buffer.from(JSON.stringify({ version: 1, gate, candidateSha256, result: "passed", observedAt: "2026-10-29T12:00:00Z", summary: "Observed the required workflow", artifacts }));
    await writeFile(join(root, `${gate}.json`), receipt);
    manifest.gates[gate] = { receipt: `${gate}.json`, sha256: sha(receipt) };
  }
  const manifestPath = join(root, "evidence.json");
  async function save() { await writeFile(manifestPath, JSON.stringify(manifest)); }
  await save();
  return { root, candidate, candidateSha256, manifest, manifestPath, save };
}

const parityChecks = {
  storeInstall: true,
  extensionCreatedTabs: true,
  toolbarActionPopup: true,
  chromeManagerDisableReenable: true,
  storePersistence: true,
  storeVersionUpgrade: true,
};
function desktopReceipt(candidateSha256, updateCheck = {
  extensionId: "ddkjiahejlhfcafbddmgiahcphecmpfh", status: "update_available", checkSucceeded: true, installedVersionBefore: "1.0", reportedVersion: "1.1",
  installedVersionAfter: "1.1", observedVersionUpgrade: true,
}) {
  const checks = { ...parityChecks };
  return {
    kind: "native-chromium-desktop-receipt",
    candidateSha256, candidateSha256After: candidateSha256,
    storeRequested: true,
    extensionParityRequired: true,
    extensionParity: {
      passed: true,
      missing: [],
      checks,
      updateCheck,
      extensions: {
        content: { id: "bcjindcccaagfpapjjmafapmmgkkhgoa", version: "0.10.2", storeInstalled: true },
        action: { id: "ddkjiahejlhfcafbddmgiahcphecmpfh", version: "1.0", storeInstalled: true },
      },
      extensionCreatedTabEvidence: { extensionId: "ddkjiahejlhfcafbddmgiahcphecmpfh", created: true, adoptedByKestrel: true, sameWindow: true, updated: true, updateAdopted: true, removedFromKestrel: true, chromeWindowId: 1 },
      toolbarActionPopupEvidence: {
        extensionId: "ddkjiahejlhfcafbddmgiahcphecmpfh", declaredPopup: "chrome-extension://ddkjiahejlhfcafbddmgiahcphecmpfh/popup.html",
        actionResult: { ok: true, chromeWindowId: 1, activeTabId: 7, histogram: "Extensions.Toolbar.InvocationSource", bucket: 1,
          before: { total: 0, toolbar: 0 }, after: { total: 1, toolbar: 1 } },
        popup: { observed: true, isolated: true, popupView: true, targetId: "popup-target", url: "chrome-extension://ddkjiahejlhfcafbddmgiahcphecmpfh/popup.html" },
      },
      chromeManagerEvidence: { extensionId: "bcjindcccaagfpapjjmafapmmgkkhgoa", disabledVisibleInKestrel: true, disabledWorkerStopped: true, disabledRuntimeInactive: true, reenabledVisibleInKestrel: true, reenabledWorkerStarted: true, runtimeRestored: true },
      restartEvidence: {
        extensionId: "bcjindcccaagfpapjjmafapmmgkkhgoa", installed: true, enabled: true,
        version: "0.10.2", functionalAfterRestart: true,
        actionExtension: { id: "ddkjiahejlhfcafbddmgiahcphecmpfh", enabled: true, installType: "normal", version: updateCheck.installedVersionAfter },
      },
    },
    phases: [
      { phase: "native-extension-functional", passed: true },
      { phase: "native-extension-functional-after-chrome-manager-toggle", passed: true },
      { phase: "native-extension-functional-after-restart", passed: true },
      { phase: "native-extension-restart", passed: true, actionExtension: { id: "ddkjiahejlhfcafbddmgiahcphecmpfh", enabled: true, installType: "normal", version: updateCheck.installedVersionAfter } },
      { phase: "native-chromium-extension-parity-final", passed: true, checks },
      { phase: "durable-core-and-clean-restart", passed: true },
    ],
  };
}
async function writeDesktopParityArtifact(f, desktop) {
  const desktopPath = join(f.root, "native-chromium-desktop-receipt.json");
  const desktopBytes = Buffer.from(JSON.stringify(desktop));
  await writeFile(desktopPath, desktopBytes);
  const receiptPath = join(f.root, "native-extension-parity.json");
  const receipt = JSON.parse(await readFile(receiptPath));
  receipt.artifacts = receipt.artifacts.filter(artifact => artifact.kind !== "native-chromium-desktop-receipt");
  receipt.artifacts.push({
    kind: "native-chromium-desktop-receipt",
    path: "native-chromium-desktop-receipt.json",
    sha256: sha(desktopBytes),
  });
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(receiptPath, receiptBytes);
  f.manifest.gates["native-extension-parity"].sha256 = sha(receiptBytes);
  await f.save();
  return desktopPath;
}

test("accepts complete candidate-bound receipts with unchanged artifacts", async t => {
  const f = await fixture(t);
  assert.deepEqual((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems, []);
});
test("allows only absent canonical observations before cutover while full retirement still requires them", async t => {
  const f = await fixture(t);
  delete f.manifest.gates["canonical-dock-app-on-screen"]; await f.save();
  assert.deepEqual((await validateNativePreCutoverEvidence(f.candidate, f.manifestPath)).problems, []);
  assert.deepEqual((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems, ["canonical-dock-app-on-screen: missing receipt or receipt digest"]);
  delete f.manifest.gates["native-local-vault"]; await f.save();
  assert((await validateNativePreCutoverEvidence(f.candidate, f.manifestPath)).problems.some(item => item.startsWith("native-local-vault:")));
});
test("does not skip supplied but malformed canonical evidence during pre-cutover validation", async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { receipt: "canonical-dock-app-on-screen.json", sha256: "0".repeat(64) }]) {
    f.manifest.gates["canonical-dock-app-on-screen"] = value; await f.save();
    assert((await validateNativePreCutoverEvidence(f.candidate, f.manifestPath)).problems.some(item => item.startsWith("canonical-dock-app-on-screen:")));
  }
});
for (const gate of ["native-local-vault", "native-browser-local-vault"]) test(`requires dedicated ${gate} proof and rejects incomplete or stale observations`, async t => {
  const f = await fixture(t);
  const path = join(f.root, `${gate}-canary.json`);
  const original = JSON.parse(await readFile(path));
  const wrapperPath = join(f.root, `${gate}.json`);
  const wrapper = JSON.parse(await readFile(wrapperPath));
  const artifact = wrapper.artifacts.find(a => a.kind === `${gate}-canary`);
  async function setProof(proof) {
    const bytes = Buffer.from(JSON.stringify(proof)); await writeFile(path, bytes); artifact.sha256 = sha(bytes);
    const wrapperBytes = Buffer.from(JSON.stringify(wrapper)); await writeFile(wrapperPath, wrapperBytes);
    f.manifest.gates[gate].sha256 = sha(wrapperBytes); await f.save();
  }
  for (const mutation of [
    proof => { proof.candidateSha256After = "0".repeat(64); },
    proof => { proof.checks.noMockProvider = false; },
    proof => { delete proof.checks.noTestKey; },
    proof => { proof.checks.noKeychainItemAPIs = false; },
    proof => { proof.checks.sameProfileRestartReadback = false; },
    proof => { proof.checks.encryptedDataVerified = false; },
    proof => { proof.provider = "system-keychain"; },
    ...(gate === "native-browser-local-vault" ? [proof => { proof.checks.encryptedCookieRow = false; }, proof => { delete proof.checks.tamperedCookieRejected; }, proof => { proof.checks.tamperedCookieRejected = false; }, proof => { delete proof.checks.persistentPasswordReadback; }, proof => { proof.checks.encryptedPasswordRow = false; }, proof => { proof.checks.nativePasswordAutofill = false; }] : []),
  ]) {
    const proof = structuredClone(original); mutation(proof); await setProof(proof);
    assert((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems.some(p => p.startsWith(`${gate}:`)));
  }
  await setProof(original);
  wrapper.artifacts = wrapper.artifacts.filter(a => a.kind !== `${gate}-canary`);
  const bytes = Buffer.from(JSON.stringify(wrapper)); await writeFile(wrapperPath, bytes);
  f.manifest.gates[gate].sha256 = sha(bytes); await f.save();
  assert((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems.some(p => p.includes(`${gate}: expected exactly one`)));
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
  assert((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems.some(x => x.includes("artifact missing, empty, oversized, or changed")));
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

test("native desktop Store receipt requires candidate-bound checks and a real published upgrade", async t => {
  const f = await fixture(t);
  let result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("expected exactly one native Chromium desktop receipt artifact")));

  await writeDesktopParityArtifact(f, desktopReceipt(f.candidateSha256));
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert.deepEqual(result.problems, []);
  const strictGate = spawnSync(process.execPath, ["scripts/check-electron-retirement-gates.mjs", f.candidate], {
    env: { ...process.env, KESTREL_ACCEPT_ELECTRON_RETIREMENT: "1", KESTREL_NATIVE_RETIREMENT_EVIDENCE: f.manifestPath },
    encoding: "utf8",
  });
  assert.equal(strictGate.status, 0, strictGate.stderr);
  assert.match(strictGate.stdout, /native Chromium desktop Store parity passed/);

  await writeDesktopParityArtifact(f, desktopReceipt(f.candidateSha256, {
    extensionId: "ddkjiahejlhfcafbddmgiahcphecmpfh", status: "no_update", installedVersionBefore: "1.0", reportedVersion: null,
    installedVersionAfter: "1.0", observedVersionUpgrade: false,
  }));
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("no_update confirms the installed version")), JSON.stringify(result.problems));

  await writeDesktopParityArtifact(f, desktopReceipt(f.candidateSha256, {
    extensionId: "ddkjiahejlhfcafbddmgiahcphecmpfh", status: "update_available", checkSucceeded: true, installedVersionBefore: "1.0", reportedVersion: "1.1",
    installedVersionAfter: "1.0", observedVersionUpgrade: false,
  }));
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("did not produce an observed installed version transition")));
});

test("native desktop Store receipt rejects false checks, wrong candidates, bad hashes and unsafe paths", async t => {
  const f = await fixture(t);
  const desktop = desktopReceipt(f.candidateSha256);
  desktop.extensionParity.checks.toolbarActionPopup = false;
  desktop.phases[4].checks.toolbarActionPopup = false;
  await writeDesktopParityArtifact(f, desktop);
  let result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("toolbarActionPopup")));

  desktop.extensionParity.checks.toolbarActionPopup = true;
  desktop.phases[4].checks.toolbarActionPopup = true;
  desktop.candidateSha256 = "0".repeat(64);
  await writeDesktopParityArtifact(f, desktop);
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("not a Store parity run for this exact candidate")), JSON.stringify(result.problems));

  desktop.candidateSha256 = f.candidateSha256;
  const desktopPath = await writeDesktopParityArtifact(f, desktop);
  const wrapperPath = join(f.root, "native-extension-parity.json");
  const wrapper = JSON.parse(await readFile(wrapperPath));
  wrapper.artifacts.find(artifact => artifact.kind === "native-chromium-desktop-receipt").sha256 = "0".repeat(64);
  let bytes = Buffer.from(JSON.stringify(wrapper));
  await writeFile(wrapperPath, bytes);
  f.manifest.gates["native-extension-parity"].sha256 = sha(bytes);
  await f.save();
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("desktop receipt artifact digest mismatch")));

  wrapper.artifacts.find(artifact => artifact.kind === "native-chromium-desktop-receipt").path = "../outside.json";
  bytes = Buffer.from(JSON.stringify(wrapper));
  await writeFile(wrapperPath, bytes);
  f.manifest.gates["native-extension-parity"].sha256 = sha(bytes);
  await f.save();
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("path escapes its receipt directory")));

  await writeFile(desktopPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  wrapper.artifacts.find(artifact => artifact.kind === "native-chromium-desktop-receipt").path = "native-chromium-desktop-receipt.json";
  wrapper.artifacts.find(artifact => artifact.kind === "native-chromium-desktop-receipt").sha256 = sha(await readFile(desktopPath));
  bytes = Buffer.from(JSON.stringify(wrapper));
  await writeFile(wrapperPath, bytes);
  f.manifest.gates["native-extension-parity"].sha256 = sha(bytes);
  await f.save();
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("exceeds the size limit")));
});

test("native desktop Store receipt rejects incomplete launch, failed tail phases and missing durable restart", async t => {
  const f = await fixture(t);
  let desktop = desktopReceipt(f.candidateSha256);
  desktop.awaitingNativeInstall = true;
  await writeDesktopParityArtifact(f, desktop);
  let result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("not a Store parity run")));

  desktop = desktopReceipt(f.candidateSha256);
  desktop.failed = "failure after parity final";
  await writeDesktopParityArtifact(f, desktop);
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("not a Store parity run")));

  desktop = desktopReceipt(f.candidateSha256);
  desktop.phases = desktop.phases.filter(phase => phase.phase !== "durable-core-and-clean-restart");
  await writeDesktopParityArtifact(f, desktop);
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("durable Core and clean restart phase is missing or failed")));

  desktop = desktopReceipt(f.candidateSha256);
  desktop.extensionParity.restartEvidence.actionExtension.enabled = false;
  await writeDesktopParityArtifact(f, desktop);
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("uBlock Origin Lite persistence and enabled restart evidence is incomplete")));
});

test("native desktop evidence rejects parent symlink escapes for wrapper and artifact paths", async t => {
  const f = await fixture(t);
  const desktopPath = await writeDesktopParityArtifact(f, desktopReceipt(f.candidateSha256));
  const outside = await mkdtemp(join(tmpdir(), "kestrel-retirement-outside-evidence-"));
  t.onTestFinished(() => rm(outside, { recursive: true, force: true }));
  const wrapperPath = join(f.root, "native-extension-parity.json");
  const wrapperBytes = await readFile(wrapperPath);
  await writeFile(join(outside, "native-extension-parity.json"), wrapperBytes);
  await writeFile(join(outside, "native-chromium-desktop-receipt.json"), await readFile(desktopPath));
  await symlink(outside, join(f.root, "linked-evidence"), "dir");
  f.manifest.gates["native-extension-parity"].receipt = "linked-evidence/native-extension-parity.json";
  f.manifest.gates["native-extension-parity"].sha256 = sha(wrapperBytes);
  await f.save();
  let result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("receipt parent path escapes")));

  // Restore the receipt in the evidence root and make only the nested artifact
  // parent escape through a symlink.
  f.manifest.gates["native-extension-parity"].receipt = "native-extension-parity.json";
  const localWrapper = JSON.parse(wrapperBytes.toString("utf8"));
  localWrapper.artifacts.find(artifact => artifact.kind === "native-chromium-desktop-receipt").path = "linked-evidence/native-chromium-desktop-receipt.json";
  const localWrapperBytes = Buffer.from(JSON.stringify(localWrapper));
  await writeFile(wrapperPath, localWrapperBytes);
  f.manifest.gates["native-extension-parity"].sha256 = sha(localWrapperBytes);
  await f.save();
  result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
  assert(result.problems.some(problem => problem.includes("artifact parent path escapes")));
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

test("native app update gate rejects missing and downgraded or incomplete upgrade proof", async t => {
  const f = await fixture(t);
  const proofPath = join(f.root, "native-app-update-canary.json");
  const wrapperPath = join(f.root, "native-app-update.json");
  const wrapper = JSON.parse(await readFile(wrapperPath));
  const artifact = wrapper.artifacts.find(item => item.kind === "native-app-update-canary");
  const original = JSON.parse(await readFile(proofPath));
  for (const mutate of [p => { p.installedVersion = p.previousVersion; }, p => { p.installedVersion = "3"; }, p => { p.checks.profileContinuity = false; }, p => { p.checks.nativeRuntimeBoth = false; }, p => { p.candidateSha256After = "0".repeat(64); }]) {
    const proof = structuredClone(original); mutate(proof);
    const bytes = Buffer.from(JSON.stringify(proof)); await writeFile(proofPath, bytes); artifact.sha256 = sha(bytes);
    const receipt = Buffer.from(JSON.stringify(wrapper)); await writeFile(wrapperPath, receipt); f.manifest.gates["native-app-update"].sha256 = sha(receipt); await f.save();
    assert((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems.some(p => p.startsWith("native-app-update:")));
  }
  delete f.manifest.gates["native-app-update"]; await f.save();
  assert((await validateRetirementEvidence(f.candidate, f.manifestPath)).problems.some(p => p.includes("native-app-update: missing")));
});

test("native app update proof cannot read artifacts outside its receipt directory", async t => {
  const f = await fixture(t);
  const proofPath = join(f.root, "native-app-update-canary.json");
  const wrapperPath = join(f.root, "native-app-update.json");
  const wrapper = JSON.parse(await readFile(wrapperPath));
  const artifact = wrapper.artifacts.find(item => item.kind === "native-app-update-canary");
  async function pointArtifact(path) {
    artifact.path = path;
    const receipt = Buffer.from(JSON.stringify(wrapper));
    await writeFile(wrapperPath, receipt);
    f.manifest.gates["native-app-update"].sha256 = sha(receipt);
    await f.save();
  }

  await pointArtifact("../native-app-update-canary.json");
  let result = await validateRetirementEvidence(f.candidate, f.manifestPath);
  assert(result.problems.some(problem => problem.includes("update canary artifact escapes receipt directory")));

  const outside = `${f.root}-outside.json`;
  t.onTestFinished(() => rm(outside, { force: true }));
  await writeFile(outside, await readFile(proofPath));
  const link = join(f.root, "canary-link.json");
  await symlink(outside, link);
  await pointArtifact("canary-link.json");
  result = await validateRetirementEvidence(f.candidate, f.manifestPath);
  assert(result.problems.some(problem => problem.includes("update canary artifact escapes through a symlink")));
});

test("rejects invalid Store versions, equivalent versions, and popup API calls without toolbar input", async t => {
  const f = await fixture(t);
  for (const version of ["0.9", "1", "1.0.0.0", "2.000", "65536", "2\n", "2.0.0.0.1", "0.0"]) {
    const desktop = desktopReceipt(f.candidateSha256);
    const parity = desktop.extensionParity;
    parity.updateCheck.reportedVersion = parity.updateCheck.installedVersionAfter = version;
    parity.restartEvidence.actionExtension.version = desktop.phases[3].actionExtension.version = version;
    await writeDesktopParityArtifact(f, desktop);
    const result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
    assert(result.problems.some(problem => problem.includes("version transition")), version);
  }
  for (const mutate of [
    e => { e.actionResult = { ok: true }; },
    e => { e.actionResult.after.toolbar = 0; },
    e => { e.actionResult.after.total = 2; },
    e => { e.popup.popupView = false; },
    e => { e.actionResult.chromeWindowId = 2; },
    e => { e.declaredPopup = e.popup.url + "wrong"; },
  ]) {
    const desktop = desktopReceipt(f.candidateSha256);
    mutate(desktop.extensionParity.toolbarActionPopupEvidence);
    await writeDesktopParityArtifact(f, desktop);
    const result = await validateNativeExtensionParityEvidence(f.candidate, f.manifestPath, f.candidateSha256);
    assert(result.problems.some(problem => problem.includes("isolated action popup")));
  }
});

test("accepts an independently hashed retained Store transition for the same candidate and generated production profile", async t => {
  const f = await fixture(t);
  const formatter = "bcjindcccaagfpapjjmafapmmgkkhgoa", action = "ddkjiahejlhfcafbddmgiahcphecmpfh";
  const desktop = desktopReceipt(f.candidateSha256);
  const profile = join(f.root, "kestrel-chromium-desktop-canary-example");
  const checkpointPath = join(f.root, "store-update-checkpoint.json");
  const active = (id, version) => ({ id, version, enabled: true, installType: "normal" });
  const storage = { kind: "native-browser-fixture-storage", version: 1, mode: "production-vault", profile,
    candidate: f.candidate, candidateSha256: f.candidateSha256, profileDev: 1, profileIno: 20, vaultSha256: "b".repeat(64) };
  const stops = [1,2,3].map(pid => ({pid, exitCode: 0, signal: null, forced: false, candidateProcessesStopped: true}));
  Object.assign(desktop, {candidate: f.candidate, candidateSha256After: f.candidateSha256, extensionParityRequired:false,
    fixtureStorageMode:"production-vault", storeAcceptanceMode:"full-extension-parity", exactCandidateAbsent:true,
    generatedProfilesRemoved:false, stops, fixtureStorage:storage, storeUpdateFixture:{profileRoot:profile,checkpointPath}});
  const parity = desktop.extensionParity;
  parity.passed = false;
  parity.checks.storeVersionUpgrade = false;
  parity.missing = [{capability:"published-store-version-upgrade"}];
  Object.assign(parity.updateCheck, {status:"no_update",reportedVersion:null,installedVersionAfter:"1.0",observedVersionUpgrade:false});
  parity.restartEvidence.actionExtension.version = "1.0";
  desktop.phases[3].actionExtension.version = "1.0";
  desktop.phases[4].passed = false;
  const initial = {[formatter]:active(formatter,"0.10.2"), [action]:active(action,"1.0")};
  desktop.phases.push({phase:"native-web-store-install",passed:true},{phase:"native-action-extension-web-store-install",passed:true});
  desktop.phases.push({phase:"native-store-update-fixture-provenance",passed:true,extensions:Object.values(initial)});
  const deskFile = await writeDesktopParityArtifact(f, desktop);
  const desktopHash = sha(await readFile(deskFile));
  const checkpoint = {kind:"native-store-update-fixture", version:1, profileRoot:profile, receiptPath:join(f.root,"receipt.json"),
    receiptSha256:desktopHash,candidate:f.candidate,candidateSha256:f.candidateSha256,extensions:Object.values(initial),upgradeObserved:false,fixtureStorage:storage};
  await writeFile(checkpointPath, JSON.stringify(checkpoint)); const checkpointHash = sha(await readFile(checkpointPath));
  const versions = {[formatter]:"0.10.2",[action]:"1.0"};
  const after = {...initial, [action]:active(action,"1.1")};
  const resume = {kind:"native-store-update-resume", version:1, mode:"update-acceptance", result:"passed", observedVersionUpgrade:true,
    profileRetained:true, candidate:f.candidate, candidateSha256:f.candidateSha256,candidateSha256After:f.candidateSha256,
    fixtureStorageMode:"production-vault",fixtureStorage:storage, fixture:{checkpoint:checkpointPath,checkpointSha256:checkpointHash,
      receiptSha256:desktopHash, originalCandidate:f.candidate, originalCandidateSha256:f.candidateSha256},
    updateCheckSource:"current-invocation",updateQueryRequested:true,actionDocumentUsed:true,
    updateActivation:{method:"clean-browser-restart",missingOriginalSessions:0},missingOriginalSessions:0,initialSessionCount:1,restartedSessionCount:1,stops,
    upgradeBaselineVersions:versions,diskVersionsBefore:versions,initial,afterCheck:after,afterRestart:after,
    updateCheck:{extensionId:action,status:"update_available",checkSucceeded:true,reportedVersion:"1.1"},
    phases:["updated-formatter-function-and-extension-owned-tab-isolation","retained-formatter-function-after-clean-restart",
      "retained-Core-and-normal-Store-versions-survive-clean-restart"].map(phase=>({phase,passed:true}))};
  for (const mutate of [null,
    r => { r.fixture.checkpointSha256 = "f".repeat(64); },
    r => { r.fixture.receiptSha256 = "e".repeat(64); },
    r => { r.fixture.checkpoint = "/different/store-update-checkpoint.json"; },
    r => { r.fixtureStorage.profileIno++; },
    r => { r.candidateSha256After = "d".repeat(64); },
    r => { r.updateCheck.extensionId = formatter; },
    r => { r.updateCheck.status = "no_update"; },
    r => { r.updateCheck.reportedVersion = "1.0.0"; },
    r => { r.afterRestart[action].installType = "development"; },
    r => { r.stops[0].forced = true; },
    r => { r.phases.pop(); },
  ]) {
    const example = JSON.parse(JSON.stringify(resume));
    if (mutate) mutate(example);
    const resumeFile = join(f.root,"resume.json"); await writeFile(resumeFile,JSON.stringify(example));
    const wrapperPath = join(f.root,"native-extension-parity.json");
    const wrapper = JSON.parse(await readFile(wrapperPath));
    wrapper.artifacts = [wrapper.artifacts.find(x=>x.kind==="native-chromium-desktop-receipt"),
      {kind:"native-store-update-fixture",path:"store-update-checkpoint.json",sha256:checkpointHash},
      {kind:"native-store-update-resume",path:"resume.json",sha256:sha(await readFile(resumeFile))}];
    const bytes=Buffer.from(JSON.stringify(wrapper));await writeFile(wrapperPath,bytes);
    f.manifest.gates["native-extension-parity"].sha256=sha(bytes); await f.save();
    const result=await validateNativeExtensionParityEvidence(f.candidate,f.manifestPath,f.candidateSha256);
    if (mutate) assert(result.problems.length, String(mutate)); else assert.deepEqual(result.problems,[]);
  }
});
