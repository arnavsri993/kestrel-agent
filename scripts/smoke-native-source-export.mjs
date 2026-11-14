// Generated source-host export through the actual cached broker, live Core,
// signed native provisioner and packaged transfer worker. Chooser/consent are
// simulated here; this is not real-profile, native-dialog or cutover evidence.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT, "1", "Explicit generated-profile production-vault opt-in required.");
assert.equal(process.argv.length, 2);
assert(process.env.KESTREL_NATIVE_TEST_APP && process.env.KESTREL_NATIVE_VAULT_PROVISIONER && process.env.KESTREL_NATIVE_SOURCE_EXPORT_EVIDENCE);
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/") && !candidate.endsWith("/.tmp/native-chromium-host/Kestrel.app"));
const provisioner = await realpath(process.env.KESTREL_NATIVE_VAULT_PROVISIONER);
assert(!provisioner.startsWith("/Applications/"));
const evidence = resolve(process.env.KESTREL_NATIVE_SOURCE_EXPORT_EVIDENCE);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal(await realpath(evidence), evidence); assert.equal((await readdir(evidence)).length, 0);
const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-source-export-")));
await chmod(fixture, 0o700);
const source = join(fixture, "source"), destination = join(fixture, "exports"), oldFolder = join(fixture, "old-project-folder");
for (const path of [source, join(source, "database"), destination, oldFolder]) await mkdir(path, { recursive: true, mode: 0o700 });
const coreRoot = join(candidate, "Contents/Resources/agent-core"), executable = join(coreRoot, "node/bin/node");
const workerEntry = join(coreRoot, "service/host-profile-project-transfer.js");
const { CoreSupervisor } = await tsImport("../apps/core-service/src/core-supervisor.ts", import.meta.url);
const { nodeCoreProcess } = await tsImport("../apps/core-service/src/node-core-process.ts", import.meta.url);
const { CredentialBroker } = await tsImport("../apps/desktop/src/main/credential-broker.ts", import.meta.url);
const { NativeProfileExportHost } = await tsImport("../apps/desktop/src/main/native-profile-export-host.ts", import.meta.url);
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const sourceKey = randomBytes(32), at = "2026-11-14T12:00:00.000Z";
const project = { id: "generated-export-project", name: "Generated export project", path: oldFolder, order: 0, instructions: "Generated export instructions.\nKeep the second line.", createdAt: at, updatedAt: at };
const sessionId = "generated-export-session", message = "Generated private source-export message.";
const receipt = { kind: "native-source-export-canary", version: 1, result: "failed", startedAt: new Date().toISOString(), candidate,
	candidateSha256: await candidateDigest(candidate), provisionerSha256: createHash("sha256").update(await readFile(provisioner)).digest("hex"),
	scope: "Generated runtime-only source key, actual cached broker and live packaged Core; real signed Secure Enclave destination provisioning and packaged transfer worker. Simulated chooser/consent, no provider credentials, no source Keychain, no GUI, no installation or real-profile claim. Generated profiles retained for subsequent native acceptance.", phases: [], fixture };
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
const snapshot = async () => Object.fromEntries(await Promise.all(["database/kestrel.sqlite", "workspace-grants.json"].map(async name => [name, createHash("sha256").update(await readFile(join(source, name))).digest("hex")])));
let providerCalls = 0, protectionCalls = 0, starts = 0, stoppedSnapshot, host;
const broker = new CredentialBroker(source, { isEncryptionAvailable: () => true,
	encryptString: async () => { protectionCalls++; throw new Error("Unexpected protection call"); },
	decryptString: async () => { protectionCalls++; throw new Error("Unexpected protection call"); },
}, { keyProvider: async () => { providerCalls++; return sourceKey; } });
const core = new CoreSupervisor(undefined, undefined, { processFactory: () => { starts++; return nodeCoreProcess({ executable, entryPath: join(coreRoot, "service/index.js"),
	env: { HOME: fixture, TMPDIR: fixture, PATH: "/usr/bin:/bin", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" }, stdout: "ignore" }); } });
try {
	const db = new KestrelDatabase(join(source, "database/kestrel.sqlite"), sourceKey);
	try {
		db.saveRuntimeSession({ id: sessionId, title: "Generated cached source export", projectId: project.id, workspaceRoot: oldFolder, privacyMode: "private", allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
		db.saveRuntimeMessage({ id: "generated-export-message", sessionId, role: "user", content: message, createdAt: at });
	} finally { db.close(); }
	await writeFile(join(source, "workspace-grants.json"), JSON.stringify([project]), { mode: 0o600 });
	const key = await broker.getDatabaseKey(); assert(key.equals(sourceKey));
	await core.start({ databasePath: join(source, "database/kestrel.sqlite"), encryptionKeyBase64: key.toString("base64"), workspaceRoots: [], configuredWorkspaceRoots: [], projects: [],
		pluginRoots: [], managedPluginRoots: [], learnedSkillRoot: join(source, "learned-skills"), secureEnvironment: {} });
	assert(core.isReady); phase("generated-source-Core-running-with-runtime-only-cached-key");
	const beforeSessions = await core.request({ type: "runtime-list-sessions" });
	assert(beforeSessions.ok && beforeSessions.sessions.some(item => item.id === sessionId));
	const sourceCore = { get isReady() { return core.isReady; }, get hasProcess() { return core.hasProcess; },
		stop: async options => { await core.stop(options); assert(!core.hasProcess); stoppedSnapshot = await snapshot(); },
		resumeLastConfiguration: async () => { assert.deepEqual(await snapshot(), stoppedSnapshot); await core.resumeLastConfiguration(); },
	};
	let approved = false;
	host = new NativeProfileExportHost({ sourceRoot: source, broker, core: sourceCore, workerExecutable: executable, workerEntry, vaultProvisioner: provisioner,
		isBusy: () => false, shouldRestoreCore: () => true, chooseParent: async () => destination,
		approve: async preview => { (receipt.previews ??= []).push(preview); assert(!core.hasProcess); assert.equal(preview.counts.runtime_sessions, beforeSessions.sessions.length); assert.equal(preview.counts.runtime_messages, 1);
			assert.equal(preview.projects, 1); assert.equal(preview.instructions, 1); assert.deepEqual(await snapshot(), stoppedSnapshot); return approved; },
	});
	const cancelled = await host.execute(); assert.equal(cancelled.state, "cancelled"); assert(core.isReady);
	await assert.rejects(readFile(join(cancelled.outputFolder, "profile/.kestrel-desktop.lock")), { code: "ENOENT" });
	await assert.rejects(readFile(join(cancelled.outputFolder, "profile/native-core/database/kestrel.sqlite")), { code: "ENOENT" });
	phase("preview-cancellation-copies-no-database-and-resumes-source");
	approved = true;
	const prepared = await host.execute(); assert.equal(prepared.state, "prepared"); assert(core.isReady); assert(!host.restartRequired);
	const selection = JSON.parse(await readFile(join(prepared.profile, "native-core-profile.json"), "utf8"));
	assert.equal(selection.version, 2); assert.equal(selection.active, ""); assert.equal(selection.previous, ""); assert.equal(Object.keys(selection.handoffs).length, 1);
	assert.equal(await readFile(join(prepared.profile, ".kestrel-desktop.lock"), "utf8"), "");
	phase("actual-provision-plan-approved-apply-verify-and-native-profile-publication");
	const sessions = await core.request({ type: "runtime-list-sessions" }); assert(sessions.ok && sessions.sessions.some(item => item.id === sessionId));
	const messages = await core.request({ type: "runtime-list-messages", sessionId }); assert(messages.ok && messages.messages.some(item => item.content === message));
	assert.equal(providerCalls, 1); assert.equal(protectionCalls, 0); assert.equal(starts, 3);
	await assert.rejects(readFile(join(source, "secure/database-key.bin")), { code: "ENOENT" });
	await assert.rejects(readFile(join(prepared.profile, "native-core/database.key")), { code: "ENOENT" });
	phase("original-conversation-readback-and-no-reunlock-or-disk-key");
	for (const path of [join(prepared.profile, "native-core/database/kestrel.sqlite"), join(prepared.profile, "native-core/pending-project-handoff.json"), join(prepared.profile, ".kestrel-local-vault-v1")]) {
		const bytes = await readFile(path);
		for (const value of [message, project.instructions, sourceKey.toString("base64")]) assert(!bytes.includes(Buffer.from(value)));
	}
	phase("destination-payloads-encrypted-with-independent-native-key");
	await host.close(); await core.stop({ requireCleanExit: true }); assert(!core.hasProcess);
	phase("all-owned-source-and-transfer-processes-stopped-cleanly");
	receipt.profile = prepared.profile; receipt.cancelledOutput = cancelled.outputFolder; receipt.source = source;
	receipt.project = project; receipt.sessionId = sessionId; receipt.message = message; receipt.selection = selection;
	receipt.candidateSha256After = await candidateDigest(candidate); assert.equal(receipt.candidateSha256After, receipt.candidateSha256);
	assert.equal(createHash("sha256").update(await readFile(provisioner)).digest("hex"), receipt.provisionerSha256);
	receipt.result = "passed";
} catch (error) {
	receipt.error = { name: error.name, message: error.message, step: error.step };
	throw error;
} finally {
	await host?.close(); await core.stop().catch(() => {}); sourceKey.fill(0);
	receipt.completedAt = new Date().toISOString(); receipt.sourceCoreStopped = !core.hasProcess;
	await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
