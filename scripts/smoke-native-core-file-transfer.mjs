import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Set KESTREL_NATIVE_TEST_APP to the exact native candidate.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
const resources = join(app, "Contents/Resources/agent-core");
const executable = join(resources, "node/bin/node"), entry = join(resources, "service/host-profile-file-transfer.js");
await readFile(entry);
const evidence = resolve(process.env.KESTREL_NATIVE_CORE_TRANSFER_EVIDENCE || `.tmp/native-core-file-transfer-evidence-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a new evidence directory for Core transfer acceptance.");
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app),
	scope: "Generated Core files and in-memory host keys only; no real profile, Keychain, browser data, credential or app activation.", phases: [] };
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-core-file-transfer-")));
const sourceKey = randomBytes(32), destinationKey = randomBytes(32), children = new Set();
const fixtureText = `Generated confidential Core transfer ${randomUUID()}`;
const source = join(temporary, "source/kestrel.sqlite"), target = join(temporary, "destination/kestrel.sqlite");
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };

function startWorker() {
	const child = spawn(executable, [entry, "--protected-host-pipe"], {
		env: { HOME: temporary, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stderr = "", stdout = "", invalidOutput = false;
	const messages = [], waiting = new Map();
	const exited = new Promise((resolveExit, rejectExit) => {
		child.once("exit", (code, signal) => { children.delete(child); resolveExit({ code, signal }); });
		child.once("error", () => { children.delete(child); rejectExit(Error("The bundled protected transfer worker could not start.")); });
	});
	child.stdin.on("error", () => {});
	child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
	const lines = createInterface({ input: child.stdout });
	lines.on("line", line => {
		let value; try { value = JSON.parse(line); } catch { invalidOutput = true; return; }
		messages.push(value); const pending = waiting.get(value.requestId);
		if (pending) { waiting.delete(value.requestId); pending(value); }
	});
	async function request(method, values = {}) {
		const requestId = randomUUID();
		const response = new Promise(resolveResponse => waiting.set(requestId, resolveResponse));
		child.stdin.write(JSON.stringify({ requestId, method, ...values }) + "\n");
		return Promise.race([response, exited.then(() => { throw Error("Protected Core transfer stopped before responding."); }), delay(40_000, undefined, { ref: false }).then(() => { throw Error("Protected Core transfer response timed out."); })]);
	}
	function assertOutput() {
		assert.equal(invalidOutput, false); assert.equal(stderr, "");
		for (const sensitive of [fixtureText, sourceKey.toString("base64"), destinationKey.toString("base64")]) { assert(!stdout.includes(sensitive)); assert(!stderr.includes(sensitive)); }
		assert(!child.spawnargs.some(value => value.includes(sourceKey.toString("base64")) || value.includes(destinationKey.toString("base64"))));
	}
	async function stop(expected = 0) {
		child.stdin.end();
		const result = await Promise.race([exited, delay(10_000, undefined, { ref: false }).then(() => { throw Error("Protected Core transfer did not stop."); })]);
		assert.deepEqual(result, { code: expected, signal: null }); assertOutput();
	}
	return { child, request, messages, exited, stop, assertOutput };
}

try {
	const runtime = spawnSync(executable, ["-e", "process.stdout.write(JSON.stringify({node:process.versions.node,electron:typeof process.versions.electron}))"], { encoding: "utf8" });
	assert.equal(runtime.status, 0); const versions = JSON.parse(runtime.stdout); assert.equal(versions.electron, "undefined");
	const manifest = JSON.parse(await readFile(join(resources, "runtime-manifest.json"), "utf8"));
	assert.equal(manifest.service.protectedCoreTransfer, "service/host-profile-file-transfer.js");
	phase("bundled-standalone-Node-and-protected-transfer-entry");
	await mkdir(dirname(source), { mode: 0o700 }); await mkdir(dirname(target), { mode: 0o700 });
	const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
	const original = new KestrelDatabase(source, sourceKey);
	try {
		const at = "2026-11-02T15:30:00.000Z";
		original.saveRuntimeSession({ id: "generated-transfer-session", title: "Generated Core transfer", allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
		original.saveRuntimeMessage({ id: "generated-transfer-message", sessionId: "generated-transfer-session", role: "user", content: fixtureText, createdAt: at });
		original.setPrivateState("generated-private-transfer-state", { text: fixtureText });
	} finally { original.close(); }
	const before = await readFile(source), worker = startWorker();
	const planned = await worker.request("plan", { sourceDatabasePath: source, destinationDatabasePath: target, sourceKeyBase64: sourceKey.toString("base64") });
	assert.equal(planned.ok, true); assert.equal(planned.preview.authenticatedEnvelopes, 2); assert.equal(planned.preview.counts.runtime_messages, 1);
	assert.deepEqual(await readFile(source), before); assert.deepEqual(await readdir(dirname(target)), []);
	phase("private-pipe-read-only-preview-with-no-content-or-key-output");
	const apply = approved => worker.request("apply", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved, destinationKeyBase64: destinationKey.toString("base64") });
	const denied = await apply(false); assert.equal(denied.ok, false); assert.equal(denied.error.code, "PLAN_NOT_ACCEPTED"); assert.deepEqual(await readdir(dirname(target)), []);
	phase("unaccepted-plan-cannot-publish-a-database");
	const applied = await apply(true); assert.equal(applied.ok, true); assert.equal(applied.receipt.activationPerformed, false);
	assert.equal((await stat(target)).mode & 0o777, 0o600); assert.equal((await stat(target)).nlink, 1); assert.deepEqual(await readdir(dirname(target)), ["kestrel.sqlite"]);
	const restored = new KestrelDatabase(target, destinationKey);
	try { assert.equal(restored.listRuntimeMessages("generated-transfer-session")[0]?.content, fixtureText); assert.deepEqual(restored.getPrivateState("generated-private-transfer-state"), { text: fixtureText }); }
	finally { restored.close(); }
	assert(!(await readFile(target)).includes(Buffer.from(fixtureText))); assert.deepEqual(await readFile(source), before);
	phase("atomic-independent-key-file-publish-and-normal-reader-acceptance");
	const replay = await apply(true); assert.equal(replay.ok, false); assert.equal(replay.error.code, "PLAN_EXPIRED");
	const recovered = await worker.request("verify-recovery", { recoveryId: applied.recoveryId });
	assert.equal(recovered.ok, true); assert.deepEqual(recovered.recovery, { originalReadable: true, destinationReadable: true, activationPerformed: false });
	phase("single-use-apply-and-both-original-and-native-Core-recoverable");
	const later = new KestrelDatabase(target, destinationKey); later.setPrivateState("later-native-work", { retain: true }); later.close();
	const laterBytes = await readFile(target);
	const changed = await worker.request("verify-recovery", { recoveryId: applied.recoveryId }); assert.equal(changed.ok, false); assert.equal(changed.error.code, "RECOVERY_CHANGED");
	assert.deepEqual(await readFile(target), laterBytes); assert.deepEqual(await readFile(source), before);
	const discarded = await worker.request("discard-recovery", { recoveryId: applied.recoveryId }); assert.equal(discarded.ok, true);
	await worker.stop();
	phase("recovery-refuses-to-discard-later-native-work-and-private-worker-stops");
	const malformed = startWorker();
	malformed.child.stdin.end(JSON.stringify({ requestId: randomUUID(), untrusted: fixtureText + "x".repeat(65_536) }) + "\n");
	const exit = await Promise.race([malformed.exited, delay(10_000, undefined, { ref: false }).then(() => { throw Error("Oversized-frame refusal timed out."); })]);
	assert.deepEqual(exit, { code: 1, signal: null }); malformed.assertOutput(); assert.equal(malformed.messages[0]?.error?.code, "INVALID_FRAME");
	phase("oversized-private-frame-fails-closed-without-input-echo");
	receipt.result = "passed";
} catch (error) {
	receipt.result = "failed"; receipt.error = error?.code || "Core file transfer canary failed; inspect its current phase."; process.exitCode = 1;
} finally {
	for (const child of children) { child.kill("SIGKILL"); await new Promise(resolveExit => child.once("exit", resolveExit)); }
	sourceKey.fill(0); destinationKey.fill(0);
	await rm(temporary, { recursive: true, force: true });
	receipt.candidateSha256After = await candidateDigest(app);
	if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
	receipt.finishedAt = new Date().toISOString();
	await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
