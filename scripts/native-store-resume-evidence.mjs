import assert from "node:assert/strict";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseStoreVersion, storeVersionIsNewer, storeActionId, storeActionUpgrade } from "./native-store-version.mjs";

const formatter = "bcjindcccaagfpapjjmafapmmgkkhgoa";
const hash = /^[a-f0-9]{64}$/;

function assertCleanStops(stops, minimum) {
  assert(Array.isArray(stops) && stops.length >= minimum, "Missing clean Store profile restarts.");
  for (const stop of stops) {
    assert(Number.isSafeInteger(stop.pid) && stop.pid > 0);
    assert(stop.exitCode === 0 && stop.signal === null && stop.forced === false && stop.candidateProcessesStopped === true);
  }
}

function assertNormalExtension(entry, id, version) {
  parseStoreVersion(version);
  assert.deepEqual(entry, { id, version, enabled: true, installType: "normal" });
}

// Hashes here belong to independently read wrapper artifacts. Recorded source paths
// identify their original relationship even after the evidence is archived.
export function validateStoreResumeLink(desktop, desktopHash, checkpoint, checkpointHash, resume, candidateHash) {
  assert.equal(desktop.extensionParityRequired, false);
  assert.equal(desktop.storeAcceptanceMode, "full-extension-parity");
  assert.equal(desktop.fixtureStorageMode, "production-vault");
  assert.equal(desktop.candidateSha256After, candidateHash);
  assert.equal(desktop.exactCandidateAbsent, true);
  assert.equal(desktop.generatedProfilesRemoved, false);
  assertCleanStops(desktop.stops, 2);
  assert(checkpoint.kind === "native-store-update-fixture" && checkpoint.version === 1 && checkpoint.upgradeObserved === false);
  assert.equal(desktop.extensionParity?.checks?.storeVersionUpgrade, false);
  assert.equal(desktop.extensionParity.updateCheck?.checkSucceeded, true);
  const aggregates = new Set(["native-chromium-extension-parity-after-official-store-install", "native-chromium-extension-parity-final"]);
  for (const phase of desktop.phases) {
    if (!aggregates.has(phase.phase)) assert.equal(phase.passed, true);
  }
  for (const phase of ["native-web-store-install", "native-action-extension-web-store-install"]) {
    assert(desktop.phases.some(entry => entry.phase === phase && entry.passed === true));
  }
  const storage = desktop.fixtureStorage;
  assert(storage?.kind === "native-browser-fixture-storage" && storage.version === 1 && storage.mode === "production-vault");
  assert(storage.candidate === desktop.candidate && storage.candidateSha256 === candidateHash);
  assert(hash.test(storage.vaultSha256) && Number.isSafeInteger(storage.profileDev) && storage.profileDev >= 0 &&
    Number.isSafeInteger(storage.profileIno) && storage.profileIno > 0);
  assert(isAbsolute(storage.profile) && basename(storage.profile).startsWith("kestrel-chromium-desktop-canary-"));
  assert.deepEqual(checkpoint.fixtureStorage, storage);
  assert(checkpoint.profileRoot === storage.profile && desktop.storeUpdateFixture?.profileRoot === storage.profile);
  const path = desktop.storeUpdateFixture.checkpointPath;
  assert(isAbsolute(path) && basename(path) === "store-update-checkpoint.json");
  assert.equal(checkpoint.receiptPath, join(dirname(path), "receipt.json"));
  assert.equal(checkpoint.receiptSha256, desktopHash);
  assert(checkpoint.candidateSha256 === candidateHash && checkpoint.candidate === desktop.candidate);

  assert(resume.kind === "native-store-update-resume" && resume.version === 1 && resume.mode === "update-acceptance");
  assert(resume.result === "passed" && resume.observedVersionUpgrade === true && resume.profileRetained === true);
  assert(resume.candidateSha256 === candidateHash && resume.candidateSha256After === candidateHash);
  assert(resume.fixtureStorageMode === "production-vault" && resume.candidateChanged === undefined &&
    resume.fixtureStorageChanged === undefined && resume.shutdownFailed === undefined && resume.failedStage === undefined);
  assert.deepEqual(resume.fixtureStorage, storage);
  assert.equal(resume.fixture?.checkpoint, path);
  assert.equal(resume.fixture.checkpointSha256, checkpointHash);
  assert.equal(resume.fixture.receiptSha256, desktopHash);
  assert.equal(resume.fixture.originalCandidate, desktop.candidate);
  assert.equal(resume.fixture.originalCandidateSha256, candidateHash);
  assert(resume.updateCheckSource === "current-invocation" && resume.updateQueryRequested === true &&
    resume.continuation === undefined && resume.actionDocumentUsed === true);
  assert.equal(resume.updateActivation?.method, "clean-browser-restart");
  assert.equal(resume.updateActivation.missingOriginalSessions, 0);
  assert.equal(resume.missingOriginalSessions, 0);
  assert(Number.isSafeInteger(resume.initialSessionCount) && resume.initialSessionCount > 0);
  assert(Number.isSafeInteger(resume.restartedSessionCount) && resume.restartedSessionCount >= resume.initialSessionCount);
  assertCleanStops(resume.stops, 3);

  const held = desktop.phases.find(phase => phase.phase === "native-store-update-fixture-provenance");
  assert.equal(held?.passed, true);
  assert.deepEqual(checkpoint.extensions, held.extensions);
  assert.deepEqual(checkpoint.extensions.map(entry => entry.id).sort(), [formatter, storeActionId].sort());
  const initialVersions = Object.fromEntries(checkpoint.extensions.map(entry => [entry.id, entry.version]));
  assert.deepEqual(resume.upgradeBaselineVersions, initialVersions);
  assert.deepEqual(resume.diskVersionsBefore, initialVersions);
  for (const [id, version] of Object.entries(initialVersions)) {
    assertNormalExtension(held.extensions.find(entry => entry.id === id), id, version);
    assertNormalExtension(resume.initial[id], id, version);
  }
  assert.equal(initialVersions[storeActionId], desktop.extensionParity?.restartEvidence?.actionExtension?.version);
  assert.equal(initialVersions[formatter], desktop.extensionParity.restartEvidence.version);
  assert.deepEqual(resume.afterRestart, resume.afterCheck);
  assert(storeActionUpgrade(resume.updateCheck, initialVersions[storeActionId], resume.afterRestart[storeActionId]),
    "Missing strictly newer, active official uBlock Origin Lite update after restart.");
  const finalFormatter = resume.afterRestart[formatter];
  assertNormalExtension(finalFormatter, formatter, finalFormatter.version);
  assert(!storeVersionIsNewer(initialVersions[formatter], finalFormatter.version));
  for (const name of ["updated-formatter-function-and-extension-owned-tab-isolation",
    "retained-formatter-function-after-clean-restart", "retained-Core-and-normal-Store-versions-survive-clean-restart"]) {
    assert(resume.phases?.some(phase => phase.phase === name && phase.passed === true));
  }
}
