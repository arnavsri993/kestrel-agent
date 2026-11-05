import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Set the exact disposable native candidate.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
const resources = join(app, "Contents/Resources/agent-core");
const evidence = resolve(process.env.KESTREL_NATIVE_LARGE_CORE_EVIDENCE || `.tmp/native-large-core-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 }); assert.equal((await readdir(evidence)).length, 0);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app),
	scope: "Generated large profiles/keys and exact bundled private Node worker; no app activation, real profile, Keychain or provider contact.", phases: [], peakWorkerRssMiB: 0 };
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const { seedNativeLegacy19Source } = await tsImport("../packages/database/src/legacy-profile-source-fixture.ts", import.meta.url);
const { readHostProfileTransferSourceSnapshot } = await tsImport("../packages/database/src/profile-transfer.ts", import.meta.url);
const { encryptText } = await tsImport("../packages/encryption/src/index.ts", import.meta.url);
const { launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const roots = [], keys = [];
let worker, timer;
const hash = text => createHash("sha256").update(text).digest("hex");
async function fileHash(path) { const value = createHash("sha256"); for await (const bytes of createReadStream(path)) value.update(bytes); return value.digest("hex"); }
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-large-core-fixture-"))); roots.push(root);
	const source = join(root, "source/kestrel.sqlite"), target = join(root, "target/kestrel.sqlite");
	await mkdir(dirname(source), { mode: 0o700 }); await mkdir(dirname(target), { mode: 0o700 });
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	return { root, source, target, sourceKey, destinationKey };
}
function start(home) {
	worker = launchCoreTransferFixture({ executable: join(resources, "node/bin/node"), entry: join(resources, "service/host-profile-file-transfer.js"), home, requestTimeoutMs: 120_000 });
	timer = setInterval(() => {
		if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
		try { const rss = Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(worker.child.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim());
			if (Number.isFinite(rss)) receipt.peakWorkerRssMiB = Math.max(receipt.peakWorkerRssMiB, rss / 1024); } catch {}
	}, 100);
}
async function stop() {
	if (timer) clearInterval(timer); timer = undefined;
	if (!worker) return;
	assert.deepEqual(await worker.stop(), { code: 0, signal: null });
	assert.equal(worker.errors(), "");
	for (const key of keys) assert(!worker.output().includes(key.toString("base64")));
	worker = undefined;
}
try {
	const value = await fixture(), recordCount = 20, recordBytes = 4 * 1024 * 1024, claims = 116_500;
	const generated = seedNativeLegacy19Source(value.source, value.sourceKey, { compactDdl: true, configurationAudit: true, largePrivateRecords: { count: recordCount, bytes: recordBytes }, idempotencyClaims: claims });
	const expectedTextHash = hash("GENERATED_PRIVATE_LARGE_TRANSFER_TEXT_".padEnd(recordBytes, "x")), sourceBefore = await fileHash(value.source);
	// The ordinary snapshot API keeps its original 64 MiB / 100k budget.
	// Open the generated historical file with SQLite only, never a writable constructor.
	const sourceView = new Database(value.source, { readonly: true });
	try { assert.throws(() => readHostProfileTransferSourceSnapshot(sourceView, value.sourceKey), /limit/); }
	finally { sourceView.close(); }
	phase("ordinary-snapshot-budget-remains-unchanged");
	start(value.root);
	const started = Date.now(), planned = await worker.request("plan", { sourceDatabasePath: value.source, destinationDatabasePath: value.target, sourceKeyBase64: value.sourceKey.toString("base64") });
	assert.equal(planned.ok, true); assert.equal(planned.preview.excluded.idempotencyClaims, claims);
	assert.deepEqual(planned.preview.legacy, { sourceSchemaVersion: 19, jobAliases: 1, archivedDiagnosticEvents: 1 });
	assert.deepEqual(await readdir(dirname(value.target)), []); assert.equal(await fileHash(value.source), sourceBefore);
	for (const secret of [generated.privateMessage, generated.diagnostic, generated.alias, "GENERATED_PRIVATE_LARGE_TRANSFER_TEXT_"]) assert(!worker.output().includes(secret));
	phase("large-legacy19-preview-preserves-source-and-reports-only-counts");
	const applied = await worker.request("apply", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: value.destinationKey.toString("base64") });
	assert.equal(applied.ok, true); assert.equal(applied.receipt.activationPerformed, false);
	const verified = await worker.request("verify-recovery", { recoveryId: applied.recoveryId });
	assert.equal(verified.ok, true); assert.equal(verified.recovery.originalReadable, true); assert.equal(verified.recovery.destinationReadable, true);
	assert.equal(await fileHash(value.source), sourceBefore);
	receipt.largeTransferDurationMs = Date.now() - started;
	phase("large-reviewed-file-transfer-and-independent-key-recovery");
	const target = new KestrelDatabase(value.target, value.destinationKey);
	try {
		for (let index = 0; index < recordCount; index++) { const record = target.getPrivateState(`generated-large-${index}`); assert.equal(record.index, index); assert.equal(hash(record.text), expectedTextHash); }
		assert.equal(target.getMemoryJob(generated.alias).attempts, 3); assert.equal(target.getMemoryJob(generated.alias).maxAttempts, 3);
		assert.equal(target.db.prepare("SELECT COUNT(*) AS count FROM idempotency_claims").get().count, 0);
		assert.equal(target.listAgentConfigurationAuditEvents()[0]?.action, "default_migrated");
	} finally { target.close(); }
	phase("all-large-private-records-and-terminal-budget-preserved-without-inherited-claims");
	await stop();
	const conflict = await fixture(), conflictSource = new KestrelDatabase(conflict.source, conflict.sourceKey), conflictTime = "2026-11-04T12:00:00.000Z";
	try {
		const original = { id: "generated-conflict-original", kind: "cleanup", dedupeKey: "GENERATED_PRIVATE_CONFLICT_DEDUPE", status: "failed", payload: {}, attempts: 3, maxAttempts: 3, runAfter: conflictTime, createdAt: conflictTime, updatedAt: conflictTime };
		conflictSource.queueMemoryJob(original);
		const duplicate = { ...original, id: "generated-conflict-duplicate", status: "pending", attempts: 0 }, encrypted = encryptText(JSON.stringify(duplicate), conflict.sourceKey);
		conflictSource.db.prepare("INSERT INTO memory_jobs SELECT ?,kind,?,?,?,max_attempts,run_after,locked_at,lease_until,last_error,created_at,updated_at,?,?,? FROM memory_jobs WHERE id=?")
			.run(duplicate.id, duplicate.dedupeKey, duplicate.status, duplicate.attempts, encrypted.ciphertext, encrypted.iv, encrypted.authTag, original.id);
	} finally { conflictSource.close(); }
	const conflictBefore = await fileHash(conflict.source); start(conflict.root);
	const conflictResult = await worker.request("plan", { sourceDatabasePath: conflict.source, destinationDatabasePath: conflict.target, sourceKeyBase64: conflict.sourceKey.toString("base64") });
	assert.equal(conflictResult.ok, false); assert.equal(conflictResult.error.code, "SOURCE_MEMORY_CONFLICT");
	assert(!worker.output().includes("GENERATED_PRIVATE_CONFLICT_DEDUPE"));
	assert.deepEqual(await readdir(dirname(conflict.target)), []); assert.equal(await fileHash(conflict.source), conflictBefore);
	phase("ambiguous-job-identities-refused-without-losing-or-reviving-either-job");
	await stop();
	const expansion = await fixture(), db = new KestrelDatabase(expansion.source, expansion.sourceKey), time = "2026-11-04T12:00:00.000Z";
	try {
		db.saveRuntimeSession({ id: "generated-expansion", title: "Generated expansion", allowedTools: [], status: "active", checkpoints: [], createdAt: time, updatedAt: time });
		const encrypted = encryptText("\u0000".repeat(1024 * 1024), expansion.sourceKey);
		const insert = db.db.prepare("INSERT INTO runtime_messages (id,session_id,role,content_ciphertext,content_iv,content_auth_tag,parent_message_id,tool_execution_id,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?)");
		db.db.transaction(() => { for (let index = 0; index < 45; index++) insert.run(`generated-expansion-${index}`, "generated-expansion", "user", encrypted.ciphertext, encrypted.iv, encrypted.authTag, time); })();
	} finally { db.close(); }
	const expansionBefore = await fileHash(expansion.source); start(expansion.root);
	const refused = await worker.request("plan", { sourceDatabasePath: expansion.source, destinationDatabasePath: expansion.target, sourceKeyBase64: expansion.sourceKey.toString("base64") });
	assert.equal(refused.ok, false); assert.equal(refused.error.code, "SOURCE_LIMIT_EXCEEDED");
	assert.deepEqual(await readdir(dirname(expansion.target)), []); assert.equal(await fileHash(expansion.source), expansionBefore);
	phase("incremental-json-expansion-refused-without-a-destination-or-source-write");
	await stop();
	assert(receipt.peakWorkerRssMiB > 0 && receipt.peakWorkerRssMiB < 1536, "Generated worker exceeded its measured RSS acceptance budget.");
	receipt.result = "passed";
} catch (error) {
	receipt.result = "failed"; receipt.error = "Large protected Core transfer failed at the next phase.";
	receipt.failureLocations = String(error?.stack || "").split("\n").filter(line => /^\s+at /.test(line) && line.includes("smoke-native-large-core-transfer.mjs:")).slice(0, 2).map(line => line.trim());
	process.exitCode = 1;
} finally {
	if (timer) clearInterval(timer);
	if (worker) { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await worker.exited; }
	for (const key of keys) key.fill(0); for (const root of roots) await rm(root, { recursive: true, force: true });
	receipt.candidateSha256After = await candidateDigest(app);
	if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
	receipt.finishedAt = new Date().toISOString(); await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
