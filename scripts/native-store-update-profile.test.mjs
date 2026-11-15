import { afterEach, expect, it, vi } from "vitest";
import { appendFile, cp, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";
import { loadRetainedStoreUpdateFixture, retainStoreUpdateFixture, storeFixturePendingName, storeFixtureFailureName } from "./native-store-update-profile.mjs";
import { selectNativeBrowserFixtureStorage, prepareNativeBrowserFixtureProfile, captureNativeBrowserFixtureStorage } from "./native-browser-fixture-storage.mjs";

vi.mock("./native-vault-canary-candidate.mjs", () => ({
	validateVaultCanaryCandidate: vi.fn(async candidate => ({ candidate })),
}));

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(change = () => {}, production = false) {
	const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-chromium-desktop-canary-")));
	const evidence = await realpath(await mkdtemp(join(tmpdir(), "kestrel-store-fixture-evidence-")));
	roots.push(profile, evidence);
	let storageEvidence;
	if (production) {
		const candidate = await realpath(await mkdtemp(join(tmpdir(), "kestrel-store-fixture-candidate-")));
		roots.push(candidate);
		await writeFile(join(candidate, "inert-unit-test-binary"), "candidate");
		const prior = process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT;
		if (production === true) process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT = "1";
		else delete process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT;
		let storage;
		try { storage = await selectNativeBrowserFixtureStorage({ candidate, root: candidate }); }
		finally { if (prior === undefined) delete process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT; else process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT = prior; }
		await prepareNativeBrowserFixtureProfile({ profile, storage });
		if (production === true) await writeFile(join(profile, ".kestrel-local-vault-v1"), Buffer.from([0x4b,0x53,0x54,0x56,0x4c,0x54,1,0,1,2,3]), { mode: 0o600 });
		storageEvidence = await captureNativeBrowserFixtureStorage({ profile, storage });
	} else await markDisposableNativeTestProfile(profile);
	const extensions = [{ id: "bcjindcccaagfpapjjmafapmmgkkhgoa", version: "0.10.2", enabled: true, installType: "normal" },
		{ id: "ddkjiahejlhfcafbddmgiahcphecmpfh", version: "2026.1026.1812", enabled: true, installType: "normal" }];
	const receiptPath = join(evidence, "receipt.json"), checkpointPath = join(evidence, "store-update-checkpoint.json");
	const receipt = { kind: "native-chromium-desktop-receipt", storeRequested: true, extensionParityRequired: false,
		candidate: "/generated-fixture/Kestrel.app", candidateSha256: "a".repeat(64), candidateSha256After: "a".repeat(64),
		extensionParity: { checks: { storeInstall: true, extensionCreatedTabs: true, toolbarActionPopup: true, chromeManagerDisableReenable: true, storePersistence: true, storeVersionUpgrade: false },
			updateCheck: { checkSucceeded: true }, missing: [{ capability: "published-store-version-upgrade" }],
			extensions: { content: { ...extensions[0], storeInstalled: true }, action: { ...extensions[1], storeInstalled: true } },
			restartEvidence: { extensionId: extensions[0].id, version: extensions[0].version, actionExtension: extensions[1] } },
		phases: ["native-web-store-install", "native-action-extension-web-store-install", "native-extension-functional-after-restart", "native-extension-restart", "durable-core-and-clean-restart"].map(phase => ({ phase, passed: true })),
		storeUpdateFixture: { profileRoot: profile, checkpointPath } };
	receipt.phases.push({ phase: "native-chromium-extension-parity-final", passed: false });
	receipt.phases.push({ phase: "native-store-update-fixture-provenance", passed: true, extensions });
	if (storageEvidence) {
		receipt.candidate = storageEvidence.candidate;
		receipt.candidateSha256 = receipt.candidateSha256After = storageEvidence.candidateSha256;
		receipt.fixtureStorage = storageEvidence;
	}
	change(receipt);
	await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
	return { profile, receiptPath, checkpointPath, ...(storageEvidence ? { storageEvidence } : {}) };
}

it("retains and revalidates a generated Store fixture without claiming a real version upgrade", async () => {
	const paths = await fixture(), before = await readdir(paths.profile);
	const checkpoint = await retainStoreUpdateFixture(paths);
	expect(checkpoint.upgradeObserved).toBe(false);
	expect(await loadRetainedStoreUpdateFixture(paths.checkpointPath)).toEqual(checkpoint);
	expect(await readdir(paths.profile)).toEqual(before);
	expect(JSON.parse(await readFile(paths.receiptPath, "utf8")).extensionParity.checks.storeVersionUpgrade).toBe(false);
	await expect(retainStoreUpdateFixture(paths)).rejects.toThrow(/EEXIST/);
});

it.each([
	["strict acceptance", receipt => { receipt.extensionParityRequired = true; }],
	["missing Store run", receipt => { receipt.storeRequested = false; }],
	["failed receipt", receipt => { receipt.failed = "generated failure"; }],
	["changed candidate", receipt => { receipt.candidateSha256After = "b".repeat(64); }],
	["incomplete action popup", receipt => { receipt.extensionParity.checks.toolbarActionPopup = false; }],
	["unsuccessful update request", receipt => { receipt.extensionParity.updateCheck.checkSucceeded = false; }],
	["failed normal phase", receipt => { receipt.phases[0].passed = false; }],
	["missing clean stop", receipt => { receipt.phases = receipt.phases.filter(item => item.phase !== "durable-core-and-clean-restart"); }],
	["unpacked extension", receipt => { receipt.phases.at(-1).extensions[0].installType = "development"; }],
	["changed restart version", receipt => { receipt.extensionParity.restartEvidence.version = "9.9"; }],
	["another missing capability", receipt => { receipt.extensionParity.missing.push({ capability: "toolbar-action-popup" }); }],
])("rejects a %s fixture", async (_name, change) => {
	const paths = await fixture(change);
	await expect(retainStoreUpdateFixture(paths)).rejects.toThrow();
	await expect(readFile(paths.checkpointPath)).rejects.toThrow(/ENOENT/);
});

it("rejects changed receipt provenance and a missing temporary profile on resume", async () => {
	const paths = await fixture();
	await retainStoreUpdateFixture(paths);
	await appendFile(paths.receiptPath, "\n");
	await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow(/receipt changed/);
	await rm(paths.profile, { recursive: true });
	await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow(/ENOENT/);
});

it("retains production fixture storage without raw keys and refuses later vault changes", async () => {
	const paths = await fixture(() => {}, true);
	const checkpoint = await retainStoreUpdateFixture(paths);
	expect(checkpoint.fixtureStorage.mode).toBe("production-vault");
	expect(checkpoint.upgradeObserved).toBe(false);
	expect(await loadRetainedStoreUpdateFixture(paths.checkpointPath)).toEqual(checkpoint);
	expect(await readdir(paths.profile)).toEqual([".kestrel-local-vault-v1"]);
	await appendFile(join(paths.profile, ".kestrel-local-vault-v1"), "changed");
	await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow(/vault changed/);
});
it("keeps checkpoint provenance frozen while validating an explicitly selected identical app copy", async () => {
	const paths = await fixture(() => {}, true), checkpoint = await retainStoreUpdateFixture(paths);
	const copy = await realpath(await mkdtemp(join(tmpdir(), "kestrel-store-fixture-copy-"))); roots.push(copy);
	await cp(paths.storageEvidence.candidate, copy, { recursive: true });
	const before = await readFile(paths.checkpointPath);
	expect(await loadRetainedStoreUpdateFixture(paths.checkpointPath, { candidateCopy: copy })).toEqual(checkpoint);
	expect(await readFile(paths.checkpointPath)).toEqual(before);
	await writeFile(join(copy, "inert-unit-test-binary"), "changed");
	await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath, { candidateCopy: copy })).rejects.toThrow(/candidate changed/);
});

it("preserves marker-only legacy resume even when the original test candidate is removed", async () => {
	const paths = await fixture(() => {}, "test-key");
	const checkpoint = await retainStoreUpdateFixture(paths);
	expect(checkpoint.fixtureStorage).toBeUndefined();
	await rm(paths.storageEvidence.candidate, { recursive: true });
	expect(await loadRetainedStoreUpdateFixture(paths.checkpointPath)).toEqual(checkpoint);
});

it("refuses omitted or substituted production storage evidence before creating a checkpoint", async () => {
	const paths = await fixture(() => {}, true);
	await expect(retainStoreUpdateFixture({ ...paths, storageEvidence: undefined })).rejects.toThrow(/must match/);
	await expect(retainStoreUpdateFixture({ ...paths, storageEvidence: { ...paths.storageEvidence, mode: "test-key" } })).rejects.toThrow(/must match/);
	await expect(readFile(paths.checkpointPath)).rejects.toThrow(/ENOENT/);
});

it("refuses a checkpoint that removes or substitutes the receipt's storage mode", async () => {
	const paths = await fixture(() => {}, true);
	const checkpoint = await retainStoreUpdateFixture(paths);
	delete checkpoint.fixtureStorage;
	await writeFile(paths.checkpointPath, JSON.stringify(checkpoint));
	await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow();
	checkpoint.fixtureStorage = { ...paths.storageEvidence, mode: "test-key" };
	await writeFile(paths.checkpointPath, JSON.stringify(checkpoint));
	await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow();
});

it("publishes a loadable checkpoint only after the terminal receipt is sealed", async () => {
 const paths = await fixture(() => {}, true);
 const { finalizeStoreUpdateFixture } = await import('./native-store-update-finalization.mjs');
 const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'));
 Object.assign(receipt, { cleanup: { forced: false, cleanupUnconfirmed: false }, exactCandidateAbsent: true,
  generatedProfilesRemoved: false, retainedProfile: paths.profile });
 let sealed = false;
 const checkpoint = await finalizeStoreUpdateFixture({ ...paths, receipt, checkCancellation: () => expect(sealed).toBe(false), seal: () => { sealed = true; } });
 expect(sealed).toBe(true);
 const sealedBytes = await readFile(paths.receiptPath);
 expect(await loadRetainedStoreUpdateFixture(paths.checkpointPath)).toEqual(checkpoint);
 expect(await readFile(paths.receiptPath)).toEqual(sealedBytes);
 expect(JSON.parse(sealedBytes).exactCandidateAbsent).toBe(true);
 expect(await readdir(join(paths.checkpointPath, '..'))).not.toContain(storeFixturePendingName);
});

it.each(['cleanup failure', 'cancelled', 'late cancellation'])('does not publish after %s', async mode => {
 const paths = await fixture();
 const { finalizeStoreUpdateFixture } = await import('./native-store-update-finalization.mjs');
 const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'));
 Object.assign(receipt, { cleanup: { forced: mode === 'cleanup failure', cleanupUnconfirmed: false }, exactCandidateAbsent: true,
  generatedProfilesRemoved: false, retainedProfile: paths.profile });
 if (mode === 'cancelled') { receipt.cancelled = { signal: 'SIGTERM' }; receipt.failed = 'cancelled'; }
 let sealed = false;
 await expect(finalizeStoreUpdateFixture({ ...paths, receipt, checkCancellation: () => { if (mode === 'late cancellation') throw Error('cancelled'); }, seal: () => { sealed = true; } })).rejects.toThrow();
 expect(sealed).toBe(false);
 await expect(readFile(paths.checkpointPath)).rejects.toThrow(/ENOENT/);
});

it('keeps the pending marker when cancellation arrives immediately before sealing', async () => {
 const paths = await fixture();
 const { finalizeStoreUpdateFixture } = await import('./native-store-update-finalization.mjs');
 const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'));
 Object.assign(receipt, { cleanup: { forced: false }, exactCandidateAbsent: true,
  generatedProfilesRemoved: false, retainedProfile: paths.profile });
 let checks = 0, sealed = false;
 await expect(finalizeStoreUpdateFixture({ ...paths, receipt, checkCancellation: () => { if (++checks === 2) throw Error('cancelled'); }, seal: () => { sealed = true; } })).rejects.toThrow('cancelled');
 expect(sealed).toBe(false);
 expect(await readFile(join(paths.checkpointPath, '..', storeFixturePendingName), 'utf8')).toContain('pending');
 await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow(/finalization is incomplete/);
});

it.each(['sync', 'close'])('rejects a complete checkpoint when its %s fails after sealing', async method => {
 const paths = await fixture();
 const { finalizeStoreUpdateFixture } = await import('./native-store-update-finalization.mjs');
 const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'));
 Object.assign(receipt, { cleanup: { forced: false }, exactCandidateAbsent: true,
  generatedProfilesRemoved: false, retainedProfile: paths.profile });
 const probe = await open(paths.receiptPath, 'r');
 const prototype = Object.getPrototypeOf(probe);
 await probe.close();
 const originalSync = prototype.sync;
 const syncSpy = vi.spyOn(prototype, 'sync').mockImplementation(async function (...args) {
  const result = await originalSync.call(this, ...args);
  if (method === 'sync') throw Error('injected sync failure');
  const originalClose = this.close;
  this.close = async function (...closeArgs) {
   await originalClose.apply(this, closeArgs);
   throw Error('injected close failure');
  };
  return result;
 });
 try {
  await expect(finalizeStoreUpdateFixture({ ...paths, receipt, checkCancellation: () => {}, seal: () => {} })).rejects.toThrow(`injected ${method} failure`);
 } finally { syncSpy.mockRestore(); }
 expect(JSON.parse(await readFile(paths.checkpointPath, 'utf8')).kind).toBe('native-store-update-fixture');
 expect(await readFile(join(paths.checkpointPath, '..', storeFixturePendingName), 'utf8')).toContain('pending');
 await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow(/finalization is incomplete/);
});

it.each(['pending symlink', 'failure log'])('rejects a checkpoint with %s', async kind => {
 const paths = await fixture();
 await retainStoreUpdateFixture(paths);
 const marker = join(paths.checkpointPath, '..', kind === 'pending symlink' ? storeFixturePendingName : storeFixtureFailureName);
 if (kind === 'pending symlink') await symlink('missing-target', marker);
 else await writeFile(marker, 'failure');
 await expect(loadRetainedStoreUpdateFixture(paths.checkpointPath)).rejects.toThrow(/finalization is incomplete/);
});
