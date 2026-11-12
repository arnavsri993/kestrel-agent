import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDisposableNativeTestProfile } from "./native-test-profile.mjs";
import { validateRetainedNativeBrowserFixtureStorage } from "./native-browser-fixture-storage.mjs";

const extensionIds = ["bcjindcccaagfpapjjmafapmmgkkhgoa", "ddkjiahejlhfcafbddmgiahcphecmpfh"];
const parityChecks = ["storeInstall", "extensionCreatedTabs", "toolbarActionPopup", "chromeManagerDisableReenable", "storePersistence", "storeVersionUpgrade"];
const aggregatePhases = new Set(["native-chromium-extension-parity-after-official-store-install", "native-chromium-extension-parity-final"]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function boundedJson(file) {
	const info = await lstat(file);
	assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 128 * 1024, "Store fixture metadata must be a bounded regular file.");
	const bytes = await readFile(file);
	assert(bytes.length <= 128 * 1024, "Store fixture metadata grew beyond its limit.");
	return { value: JSON.parse(bytes.toString("utf8")), sha256: digest(bytes) };
}
function validateReceipt(receipt) {
	assert.equal(receipt.kind, "native-chromium-desktop-receipt");
	assert.equal(receipt.storeRequested, true);
	assert.equal(receipt.extensionParityRequired, false, "Fixture retention cannot bypass strict extension acceptance.");
	assert.equal(receipt.failed, undefined);
	assert.match(receipt.candidateSha256, /^[a-f0-9]{64}$/);
	assert.equal(receipt.candidateSha256After, receipt.candidateSha256);
	const checks = receipt.extensionParity?.checks;
	assert.deepEqual(Object.keys(checks ?? {}).sort(), [...parityChecks].sort());
	for (const name of parityChecks.filter(name => name !== "storeVersionUpgrade")) assert.equal(checks[name], true, `Cannot retain an incomplete ${name} fixture.`);
	assert.equal(typeof checks.storeVersionUpgrade, "boolean");
	assert.equal(receipt.extensionParity.updateCheck.checkSucceeded, true);
	for (const item of receipt.extensionParity.missing ?? []) assert.equal(item.capability, "published-store-version-upgrade");
	assert(Array.isArray(receipt.phases) && receipt.phases.length > 0);
	for (const phase of receipt.phases) if (!aggregatePhases.has(phase.phase)) assert.equal(phase.passed, true, `Cannot retain failed phase ${phase.phase}.`);
	for (const name of ["native-web-store-install", "native-action-extension-web-store-install", "native-extension-functional-after-restart", "native-extension-restart", "durable-core-and-clean-restart"]) assert(receipt.phases.some(phase => phase.phase === name && phase.passed === true), `Missing Store fixture phase ${name}.`);
	const provenance = receipt.phases.find(phase => phase.phase === "native-store-update-fixture-provenance");
	assert.equal(provenance?.passed, true);
	assert.deepEqual(provenance.extensions.map(item => item.id).sort(), [...extensionIds].sort());
	for (const item of provenance.extensions) {
		assert.equal(item.installType, "normal"); assert.equal(item.enabled, true);
		assert.match(item.version, /^\d+(?:\.\d+){0,3}$/);
		const expected = Object.values(receipt.extensionParity.extensions).find(extension => extension.id === item.id);
		assert.equal(expected?.storeInstalled, true);
		const restart = receipt.extensionParity.restartEvidence;
		assert.equal(item.version, item.id === restart?.extensionId ? restart.version : restart?.actionExtension?.version);
	}
	return provenance.extensions;
}

// Retain only a clean, generated official-Store fixture. The missing real
// version upgrade stays missing; this checkpoint is not retirement evidence.
export async function retainStoreUpdateFixture({ profile, receiptPath, checkpointPath, storageEvidence, root = repositoryRoot }) {
	const canonicalReceipt = await realpath(receiptPath), checkpoint = resolve(checkpointPath);
	assert.equal(canonicalReceipt, join(await realpath(dirname(checkpoint)), "receipt.json"));
	const receipt = await boundedJson(canonicalReceipt), extensions = validateReceipt(receipt.value);
	assert.deepEqual(storageEvidence, receipt.value.fixtureStorage, "Store fixture storage evidence must match its receipt.");
	const profileRoot = storageEvidence
		? await validateRetainedNativeBrowserFixtureStorage({ profile, candidate: receipt.value.candidate,
			candidateSha256: receipt.value.candidateSha256, evidence: storageEvidence, root })
		: await validateDisposableNativeTestProfile(profile);
	assert(basename(profileRoot).startsWith("kestrel-chromium-desktop-canary-"));
	assert.equal(receipt.value.storeUpdateFixture?.profileRoot, profileRoot);
	assert.equal(receipt.value.storeUpdateFixture?.checkpointPath, checkpoint);
	const value = { kind: "native-store-update-fixture", version: 1, createdAt: new Date().toISOString(),
		profileRoot, receiptPath: canonicalReceipt, receiptSha256: receipt.sha256,
		candidate: receipt.value.candidate, candidateSha256: receipt.value.candidateSha256, extensions,
		upgradeObserved: receipt.value.extensionParity.checks.storeVersionUpgrade };
	// Preserve legacy checkpoints' marker-only resume behavior. Production
	// storage additionally stays bound to the original candidate and vault.
	if (storageEvidence?.mode === "production-vault") value.fixtureStorage = storageEvidence;
	const handle = await open(checkpoint, "wx", 0o600);
	try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
	finally { await handle.close(); }
	return value;
}

// Revalidate actual filesystem state; a saved path alone is not a live wait or
// proof the temporary profile still exists. No browser or Keychain is opened.
export async function loadRetainedStoreUpdateFixture(checkpointPath, { root = repositoryRoot } = {}) {
	const checkpoint = resolve(checkpointPath), { value } = await boundedJson(checkpoint);
	assert.equal(value.kind, "native-store-update-fixture"); assert.equal(value.version, 1);
	assert.equal(value.profileRoot, value.fixtureStorage
		? await validateRetainedNativeBrowserFixtureStorage({ profile: value.profileRoot, candidate: value.candidate,
			candidateSha256: value.candidateSha256, evidence: value.fixtureStorage, root })
		: await validateDisposableNativeTestProfile(value.profileRoot));
	assert(basename(value.profileRoot).startsWith("kestrel-chromium-desktop-canary-"));
	assert.equal(value.receiptPath, join(await realpath(dirname(checkpoint)), "receipt.json"));
	const receipt = await boundedJson(value.receiptPath), extensions = validateReceipt(receipt.value);
	assert.equal(receipt.sha256, value.receiptSha256, "Store fixture receipt changed.");
	assert.equal(receipt.value.storeUpdateFixture?.profileRoot, value.profileRoot);
	assert.equal(receipt.value.storeUpdateFixture?.checkpointPath, checkpoint);
	assert.equal(value.candidate, receipt.value.candidate);
	assert.equal(value.candidateSha256, receipt.value.candidateSha256);
	if (value.fixtureStorage) assert.deepEqual(value.fixtureStorage, receipt.value.fixtureStorage, "Store fixture storage evidence changed.");
	else assert(!receipt.value.fixtureStorage || receipt.value.fixtureStorage.mode === "test-key", "Production fixture storage evidence is missing.");
	assert.equal(value.upgradeObserved, receipt.value.extensionParity.checks.storeVersionUpgrade);
	assert.deepEqual(value.extensions, extensions);
	return value;
}
