import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";
import { loadRetainedStoreUpdateFixture, retainStoreUpdateFixture } from "./native-store-update-profile.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(change = () => {}) {
	const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-chromium-desktop-canary-")));
	const evidence = await realpath(await mkdtemp(join(tmpdir(), "kestrel-store-fixture-evidence-")));
	roots.push(profile, evidence);
	await markDisposableNativeTestProfile(profile);
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
	change(receipt);
	await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
	return { profile, receiptPath, checkpointPath };
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
