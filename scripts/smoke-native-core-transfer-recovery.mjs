import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Set the exact disposable native candidate.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
const resources = join(app, "Contents/Resources/agent-core"), executable = join(resources, "node/bin/node"), entry = join(resources, "service/host-profile-file-transfer.js");
await readFile(entry);
const evidence = resolve(process.env.KESTREL_NATIVE_CORE_RECOVERY_EVIDENCE || `.tmp/native-core-transfer-recovery-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 }); assert.equal((await readdir(evidence)).length, 0);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app),
	scope: "Generated Core files/keys and actual bundled Node subprocesses; test-only preload kills only owned workers. No real profile, Keychain, credentials, native desktop input or app activation.", phases: [] };
const clients = [], roots = [], keys = [];
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const { writeCoreTransferCrashPreload, launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
function launch(home, preload) { const value = launchCoreTransferFixture({ executable, entry, home, ...(preload ? { preload } : {}) }); clients.push(value); return value; }
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function fixture(point) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-core-recovery-canary-"))); roots.push(root);
	const source = join(root, "source/kestrel.sqlite"), target = join(root, "target/kestrel.sqlite"), preload = join(root, "crash.mjs");
	await mkdir(dirname(source), { mode: 0o700 }); await mkdir(dirname(target), { mode: 0o700 });
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	const secret = `Generated private recovery proof ${point}`;
	const db = new KestrelDatabase(source, sourceKey); db.setPrivateState("generated-core-recovery", { secret }); db.close();
	const before = await readFile(source);
	await writeCoreTransferCrashPreload(preload, target, point);
	const owner = launch(root, preload), planned = await owner.request("plan", { sourceDatabasePath: source, destinationDatabasePath: target, sourceKeyBase64: sourceKey.toString("base64") });
	assert.equal(planned.ok, true);
	owner.send("apply", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: destinationKey.toString("base64") });
	if (point === "hold-before-link") await owner.ready(); else assert.deepEqual(await owner.exited, { code: null, signal: "SIGKILL" });
	const journal = await readFile(target + ".kestrel-transfer-journal", "utf8");
	for (const value of [secret, sourceKey.toString("base64"), destinationKey.toString("base64")]) assert(!journal.includes(value));
	return { root, source, target, sourceKey, destinationKey, secret, before, owner };
}
function safeOutput(client, fixture) {
	assert.equal(client.errors(), "");
	for (const value of [fixture.secret, fixture.sourceKey.toString("base64"), fixture.destinationKey.toString("base64")]) assert(!client.output().includes(value));
}
try {
	for (const point of ["before-link", "after-link", "after-unlink"]) {
		const value = await fixture(point), restarted = launch(value.root);
		const reviewed = await restarted.request("inspect-interrupted", { destinationDatabasePath: value.target });
		assert.equal(reviewed.ok, true); assert.equal(reviewed.preview.state, point === "before-link" ? "staged" : "published");
		if (point === "after-link") assert.equal((await stat(value.target)).nlink, 2);
		const request = { reviewId: reviewed.reviewId, acceptedRecoverySha256: reviewed.preview.recoverySha256,
			sourceKeyBase64: value.sourceKey.toString("base64"), destinationKeyBase64: value.destinationKey.toString("base64") };
		const denied = await restarted.request("recover-interrupted", { ...request, approved: false }); assert.equal(denied.error.code, "PLAN_NOT_ACCEPTED");
		const recovered = await restarted.request("recover-interrupted", { ...request, approved: true }); assert.equal(recovered.ok, true); assert.equal(recovered.receipt.activationPerformed, false);
		const verified = await restarted.request("verify-recovery", { recoveryId: recovered.recoveryId }); assert.equal(verified.ok, true); assert.equal(verified.recovery.originalReadable, true); assert.equal(verified.recovery.destinationReadable, true);
		const replay = await restarted.request("recover-interrupted", { ...request, approved: true }); assert.equal(replay.error.code, "RECOVERY_EXPIRED");
		assert.equal((await stat(value.target)).nlink, 1); assert.deepEqual(await readdir(dirname(value.target)), ["kestrel.sqlite"]);
		const db = new KestrelDatabase(value.target, value.destinationKey); try { assert.deepEqual(db.getPrivateState("generated-core-recovery"), { secret: value.secret }); } finally { db.close(); }
		assert.deepEqual(await readFile(value.source), value.before);
		assert.deepEqual(await restarted.stop(), { code: 0, signal: null }); safeOutput(restarted, value); safeOutput(value.owner, value);
		phase(`bundled-process-death-${point}-reviewed-recovery-and-original-preserved`);
	}
	const live = await fixture("hold-before-link"), inspector = launch(live.root);
	const denied = await inspector.request("inspect-interrupted", { destinationDatabasePath: live.target }); assert.equal(denied.error.code, "RECOVERY_BUSY");
	assert.deepEqual(await readFile(live.source), live.before); assert.deepEqual(await inspector.stop(), { code: 0, signal: null });
	live.owner.child.kill("SIGKILL"); assert.deepEqual(await live.owner.exited, { code: null, signal: "SIGKILL" }); safeOutput(live.owner, live); safeOutput(inspector, live);
	phase("actual-live-owner-cannot-be-stolen-by-a-second-worker");
	const incomplete = await fixture("after-journal"), second = launch(incomplete.root);
	const reviewed = await second.request("inspect-interrupted", { destinationDatabasePath: incomplete.target }); assert.equal(reviewed.ok, true);
	const refused = await second.request("recover-interrupted", { reviewId: reviewed.reviewId, acceptedRecoverySha256: reviewed.preview.recoverySha256, approved: true,
		sourceKeyBase64: incomplete.sourceKey.toString("base64"), destinationKeyBase64: incomplete.destinationKey.toString("base64") });
	assert.equal(refused.ok, false); assert.equal(refused.error.code, "SOURCE_UNREADABLE");
	assert((await readdir(dirname(incomplete.target))).includes("kestrel.sqlite.kestrel-transfer-journal")); assert.deepEqual(await readFile(incomplete.source), incomplete.before);
	assert.deepEqual(await second.stop(), { code: 0, signal: null }); safeOutput(second, incomplete); safeOutput(incomplete.owner, incomplete);
	phase("incomplete-stage-is-retained-for-separate-review-with-original-unchanged");
	receipt.result = "passed";
} catch (error) { receipt.result = "failed"; receipt.error = error?.code || "Protected Core recovery canary failed at the next phase."; process.exitCode = 1; }
finally {
	for (const client of clients) { if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGKILL"); await client.exited; }
	for (const key of keys) key.fill(0); for (const root of roots) await rm(root, { recursive: true, force: true });
	receipt.candidateSha256After = await candidateDigest(app);
	if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
	receipt.finishedAt = new Date().toISOString(); await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
