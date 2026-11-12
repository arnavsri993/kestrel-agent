import { afterEach, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";
import { loadRetainedStoreUpdateFixture, retainStoreUpdateFixture } from "./native-store-update-profile.mjs";
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
