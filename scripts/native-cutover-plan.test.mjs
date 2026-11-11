import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNativeCutoverPlan } from "./native-cutover-plan.mjs";
import { candidateDigest, RETIREMENT_GATES } from "./native-retirement-evidence.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-cutover-plan-test-"))); roots.push(root);
	const candidate = join(root, "candidate", "Kestrel.app"), target = join(root, "Applications", "Kestrel.app");
	for (const [path, value] of [[candidate, "generated native"], [target, "generated previous"]]) {
		await mkdir(path, { recursive: true }); await writeFile(join(path, "fixture"), value);
	}
	const manifestPath = join(root, "evidence.json");
	const manifest = { version: 1, candidateSha256: await candidateDigest(candidate), gates: {} };
	await writeFile(manifestPath, JSON.stringify(manifest));
	return { root, candidate, target, manifestPath, manifest };
}

it("reports all existing gates before apply and plans an exclusive UUID backup without writing any bundle", async () => {
	const f = await fixture(), before = await candidateDigest(f.target);
	const plan = await createNativeCutoverPlan(f);
	expect(plan.version).toBe(2);
	expect(plan.preCutover.evidenceComplete).toBe(false);
	expect(plan.preCutover.evidenceProblems.some(p => p.startsWith("canonical-dock-app-on-screen:"))).toBe(true);
	expect(plan.backup.allocatedExclusivelyDuringApply).toBe(true);
	expect(plan.backup.pathTemplate).toContain("<transaction UUID>/previous/Kestrel.app");
	expect(await candidateDigest(f.target)).toBe(before);
	expect(await candidateDigest(f.candidate)).toBe(f.manifest.candidateSha256);
	await expect(lstat(plan.backup.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not treat generic synthetic gate attestations as native Store parity", async () => {
	const f = await fixture(), artifact = "unit-only synthetic attestation; not release evidence";
	await writeFile(join(f.root, "unit-artifact.txt"), artifact);
	for (const gate of RETIREMENT_GATES) {
		const receipt = JSON.stringify({ version: 1, gate, candidateSha256: f.manifest.candidateSha256, result: "passed", observedAt: "2026-11-05T00:00:00Z", summary: "Generated unit fixture", artifacts: [{ path: "unit-artifact.txt", sha256: hash(artifact) }] });
		const filename = `${gate}.json`; await writeFile(join(f.root, filename), receipt);
		f.manifest.gates[gate] = { receipt: filename, sha256: hash(receipt) };
	}
	await writeFile(f.manifestPath, JSON.stringify(f.manifest));
	const before = await readFile(f.manifestPath, "utf8");
	const plan = await createNativeCutoverPlan(f);
	expect(plan.preCutover.evidenceComplete).toBe(false);
	expect(plan.preCutover.evidenceProblems.some(p => p.startsWith("native-extension-parity:"))).toBe(true);
	expect(plan.preCutover.evidenceProblems.some(p => p.startsWith("native-local-vault:"))).toBe(true);
	expect(plan.preCutover.evidenceProblems.some(p => p.startsWith("native-browser-local-vault:"))).toBe(true);
	expect(await readFile(f.manifestPath, "utf8")).toBe(before);
});

it("reports a symlinked recovery root without changing it", async () => {
	const f = await fixture(), outside = join(f.root, "outside"); await mkdir(outside);
	const recovery = join(f.root, "Applications", ".Kestrel-cutover-backups"); await symlink(outside, recovery);
	const plan = await createNativeCutoverPlan(f);
	expect(plan.preCutover.evidenceProblems).toContain("Retained-bundle recovery directory is not an owned private directory.");
	expect((await lstat(recovery)).isSymbolicLink()).toBe(true);
});
