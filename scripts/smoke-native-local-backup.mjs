// Bundled native-desktop-core backup lifecycle canary. The trusted native host
// is simulated over its private pipe; no Cocoa window, Keychain, or real profile
// is opened. Every profile, key, credential, and payload is generated here.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Set KESTREL_NATIVE_TEST_APP to the exact disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "The canary must not use the installed Kestrel app.");
const resources = join(candidate, "Contents/Resources");
const executable = join(resources, "agent-core/node/bin/node");
const entry = join(resources, "native-desktop-core.mjs");
const nativePeerPath = join(resources, "native-peer.node");
const [nodeInfo] = await Promise.all([stat(executable), readFile(entry), readFile(nativePeerPath)]);
assert(nodeInfo.isFile());
const candidateSha256 = await candidateDigest(candidate);
const evidence = resolve(process.env.KESTREL_NATIVE_LOCAL_BACKUP_EVIDENCE || `.tmp/native-local-backup-evidence-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a new evidence directory for each backup canary.");

const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-local-backup-")));
const profile = join(temporary, "browser-profile");
const destination = join(temporary, "backup-destination");
const project = join(temporary, "external-project");
const coreRoot = join(profile, "native-core");
const databasePath = join(coreRoot, "database/kestrel.sqlite");
const profileKey = randomBytes(32);
const profileKeyBase64 = profileKey.toString("base64");
const apiSecret = `fixture-api-${randomUUID()}`;
const seededContent = `generated-encrypted-conversation-${randomUUID()}`;
const seededPrivateState = `generated-private-setting-${randomUUID()}`;
const modelMarker = `generated-model-${randomUUID()}`;
const browserMarker = `generated-browser-${randomUUID()}`;
const projectMarker = `generated-project-${randomUUID()}`;
const fixtureSessionId = randomUUID();
const fixtureMessageId = randomUUID();
const fixtureSessionTitle = "Generated native backup fixture conversation";
const createdAt = new Date().toISOString();
const children = new Set();
const states = [];
const receipt = {
	version: 1,
	startedAt: new Date().toISOString(),
	candidate,
	candidateSha256,
	scope: "Generated disposable profile, credentials, database, model/browser/project markers, and fixture key only.",
	syntheticHost: {
		picker: "Private pipe responses simulate folder selection and reveal acknowledgement; Cocoa is not launched.",
		permissions: "Screen recording and accessibility are answered unavailable; microphone access is not requested.",
		key: "Generated 32-byte test key sent over the private host pipe; no Keychain access or key file.",
	},
	phases: [],
};
let result = "failed";
let firstBackupPath;
let backupId;

function phase(name) {
	receipt.phases.push({ phase: name, passed: true });
	console.log(`PASS ${name}`);
}

function boundedError(error) {
	const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
	return code && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "Native local backup canary failed; inspect its phase ledger.";
}

function timeout(promise, milliseconds, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
}

async function writePrivateJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}

function directCorePids(host) {
	const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5_000 });
	assert.equal(ps.status, 0, "Could not enumerate the canary-owned Core child.");
	return ps.stdout.split("\n").flatMap(line => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (!match || Number(match[2]) !== host.child.pid || !match[3].includes("agent-core/service/index.js")) return [];
		return [Number(match[1])];
	});
}

async function waitForCorePid(host, previous) {
	const end = Date.now() + 15_000;
	while (Date.now() < end) {
		assert.equal(host.child.exitCode, null, "The bundled native desktop Core host exited unexpectedly.");
		const pids = directCorePids(host);
		if (pids.length === 1 && (previous === undefined || pids[0] !== previous)) return pids[0];
		assert(pids.length <= 1, "The native desktop Core host spawned more than one Agent Core child.");
		await delay(50);
	}
	throw new Error("The bundled Agent Core child did not reach the expected lifecycle state.");
}

async function waitForPidsGone(pids, milliseconds = 5_000) {
	const end = Date.now() + milliseconds;
	while (Date.now() < end) {
		const alive = pids.filter(pid => {
			try { process.kill(pid, 0); return true; }
			catch (error) { if (error.code === "ESRCH") return false; throw error; }
		});
		if (!alive.length) return;
		await delay(50);
	}
	throw new Error("A canary-owned Agent Core child did not exit within the cleanup bound.");
}

function startHost(dialogSimulation) {
	const child = spawn(executable, [entry, "--profile-root", profile, "--browser-profile-root", profile, "--durable-profile"], {
		env: {
			HOME: profile,
			TMPDIR: temporary,
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			LANG: "en_US.UTF-8",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	const pending = new Map();
	let sequence = 0;
	let ready = false;
	let protocolError;
	let stderrText = "";
	let resolveReady;
	let rejectReady;
	const readyPromise = new Promise((resolveReadyPromise, rejectReadyPromise) => {
		resolveReady = resolveReadyPromise;
		rejectReady = rejectReadyPromise;
	});
	const exited = new Promise(resolveExit => child.once("exit", (code, signal) => {
		children.delete(child);
		resolveExit({ code, signal });
		for (const entry of pending.values()) entry.reject(new Error("Native desktop Core host exited before responding."));
		pending.clear();
	}));
	child.stdin.on("error", () => {});
	child.stderr.on("data", chunk => { stderrText = (stderrText + chunk.toString("utf8")).slice(-64_000); });
	child.once("error", () => {
		const error = new Error("The bundled native desktop Core host could not start.");
		protocolError = error;
		rejectReady(error);
	});
	function failProtocol(message) {
		if (protocolError) return;
		protocolError = new Error(message);
		rejectReady(protocolError);
		for (const entry of pending.values()) entry.reject(protocolError);
		pending.clear();
	}
	function send(message) {
		if (child.stdin.destroyed || child.exitCode !== null) throw new Error("Native desktop Core host input closed.");
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	async function respondRequest(message) {
		const operation = message.operation;
		if (operation === "select-local-backup-folder") {
			if (Object.keys(message).sort().join(",") !== "operation,requestId,type") throw new Error("Backup folder picker request had unexpected fields.");
			const choice = dialogSimulation.selectionQueue.shift();
			if (choice === undefined) throw new Error("Unexpected backup destination picker.");
			dialogSimulation.selectionCount++;
			await dialogSimulation.beforeSelection?.();
			send({ type: "native-dialog-response", requestId: message.requestId,
				response: { ok: true, selectedBackupPath: choice } });
			return;
		}
		if (operation === "reveal-local-backup-folder") {
			if (Object.keys(message).sort().join(",") !== "backupPath,operation,requestId,type" ||
				typeof message.backupPath !== "string" || !message.backupPath.startsWith("/")) {
				throw new Error("Backup reveal request had an invalid private path.");
			}
			dialogSimulation.revealPaths.push(message.backupPath);
			send({ type: "native-dialog-response", requestId: message.requestId,
				response: { ok: true, revealed: true } });
			return;
		}
		throw new Error("The bundled Core requested an unexpected native dialog.");
	}
	createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
		let message;
		try { message = JSON.parse(line); }
		catch { failProtocol("Bundled native Core emitted a non-JSON frame."); return; }
		if (!message || typeof message !== "object" || Array.isArray(message)) { failProtocol("Bundled native Core emitted an invalid frame."); return; }
		if (message.kind === "native-core-profile-key-request") {
			if (message.requestId !== "native-core-profile-key-v1") { failProtocol("Unexpected native profile-key request."); return; }
			send({ kind: "native-core-profile-key-response", requestId: message.requestId, ok: true, keyBase64: profileKeyBase64 });
			return;
		}
		if (message.type === "ready") { ready = true; resolveReady(); return; }
		if (message.type === "start-error") { failProtocol("Bundled native Core failed to start its disposable profile."); return; }
		if (message.type === "browser-backend-reset") {
			if (typeof message.requestId !== "string") { failProtocol("Browser reset request lacked an id."); return; }
			send({ type: "browser-backend-reset-response", requestId: message.requestId, ok: true });
			return;
		}
		if (message.type === "native-computer-request") {
			if (typeof message.requestId !== "string" || message.request?.operation !== "native-computer-permissions") {
				if (typeof message.requestId === "string") send({ type: "native-computer-response", requestId: message.requestId, ok: false, error: "Unexpected native computer request." });
				failProtocol("Only synthetic unavailable computer permission status is allowed.");
				return;
			}
			send({ type: "native-computer-response", requestId: message.requestId, ok: true,
				result: { screenRecording: "unavailable", accessibility: "unavailable" } });
			return;
		}
		if (message.type === "native-dialog-request") {
			void respondRequest(message).catch(error => failProtocol(error.message));
			return;
		}
		if (message.type === "response") {
			const item = pending.get(message.id);
			if (item) { pending.delete(message.id); item.resolve(message.response); }
			return;
		}
		if (message.type === "event") return;
		failProtocol(`Unexpected bundled native Core frame: ${String(message.type ?? message.kind ?? "unknown").slice(0, 80)}`);
	});
	async function request(type, request) {
		if (protocolError) throw protocolError;
		const id = `native-local-backup-${++sequence}`;
		const response = new Promise((resolveResponse, rejectResponse) => pending.set(id, { resolve: resolveResponse, reject: rejectResponse }));
		send({ type, id, request });
		return timeout(Promise.race([response, exited.then(() => { throw new Error("Native desktop Core host exited during request."); })]), 90_000, "Native local backup protocol request timed out.");
	}
	async function waitReady() {
		await timeout(Promise.race([readyPromise, exited.then(() => { throw new Error("Native desktop Core host exited before ready."); })]), 90_000, "Native desktop Core host did not become ready.");
		assert.equal(ready, true);
		assert.equal(protocolError, undefined);
	}
	async function stop() {
		if (child.exitCode !== null || child.signalCode !== null) return await exited;
		const corePids = directCorePids({ child });
		send({ type: "shutdown" });
		const result = await timeout(exited, 20_000, "Native desktop Core host did not shut down cleanly.");
		assert.deepEqual(result, { code: 0, signal: null });
		await waitForPidsGone(corePids);
		for (const sensitive of [profileKeyBase64, apiSecret])
			assert(!stderrText.includes(sensitive), "The disposable native Core emitted fixture key or credential text.");
		return result;
	}
	return { child, request, stop, waitReady, exited, protocolError: () => protocolError, ready: () => ready };
}

function assertNoFixtureSecrets(value, paths) {
	const encoded = JSON.stringify(value);
	for (const sensitive of [profileKeyBase64, apiSecret, seededContent, seededPrivateState, modelMarker, browserMarker, projectMarker, ...paths])
		assert(!encoded.includes(sensitive), "Backup response metadata disclosed fixture data or a local path.");
}

function assertCreatedReceipt(response) {
	assert.equal(response?.ok, true, "Native local backup request failed.");
	assert.deepEqual(Object.keys(response.localBackupCreated ?? {}).sort(), ["backupId", "bytes", "coreStatus", "createdAt", "files", "scope", "verified"].sort());
	const backup = response.localBackupCreated;
	assert.match(backup.backupId, /^[a-f0-9-]{36}$/i);
	assert(Number.isFinite(Date.parse(backup.createdAt)));
	assert(Number.isSafeInteger(backup.files) && backup.files > 0);
	assert(Number.isSafeInteger(backup.bytes) && backup.bytes > 0);
	assert.equal(backup.verified, true);
	assert.equal(backup.scope, "native-core-data");
	assert.equal(backup.coreStatus, "ready");
	return backup;
}

async function verifyBackupTree(path, fixture) {
	const manifestPath = join(path, "kestrel-native-core-backup.json");
	const manifestBytes = await readFile(manifestPath);
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	assert.equal(manifest.format, "native-core-data");
	assert.equal(manifest.version, 1);
	assert.equal(manifest.compatibility, "This backup is for the same Mac and original Kestrel profile; the original profile Keychain identity is required.");
	assert.equal(manifest.limitations, "This is a data backup only and does not claim restore readiness. Keys, Chromium data, and provider CLI caches are excluded.");
	assert(!JSON.stringify(manifest).includes(fixture.profilePath));
	assert(!JSON.stringify(manifest).includes(fixture.profileKeyBase64));
	assert(!JSON.stringify(manifest).includes(fixture.apiSecret));
	const paths = manifest.files.map(file => file.path);
	assert(paths.includes("database/kestrel.sqlite"));
	assert(paths.includes("provider-accounts.json"));
	assert(paths.includes("native-runtime-preferences.json"));
	assert(paths.includes("computer-use.json"));
	assert(paths.includes("secure/credentials/openai.bin"));
	assert(!paths.some(value => /(?:^|\/)(?:database\.key|database-key\.bin|local-models|Local State|History|Cookies|Default|project)(?:\/|$)/i.test(value)));
	assert(!paths.some(value => value.includes(".native-backup-receipts")));
	assert(!paths.some(value => value.startsWith("secure/credentials/") && value.includes("database-key")));
	let fileBytes = 0;
	for (const file of manifest.files) {
		assert(typeof file.path === "string" && !file.path.startsWith("/") && file.path.split("/").every(part => part && part !== "." && part !== ".."));
		const contents = await readFile(join(path, ...file.path.split("/")));
		assert.equal(contents.length, file.size);
		assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256);
		assert(!contents.includes(Buffer.from(fixture.profileKeyBase64)));
		assert(!contents.includes(Buffer.from(fixture.apiSecret)));
		if (file.path !== "database/kestrel.sqlite") {
			for (const marker of [fixture.seededContent, fixture.seededPrivateState, fixture.modelMarker, fixture.browserMarker, fixture.projectMarker])
				assert(!contents.includes(Buffer.from(marker)));
		}
		fileBytes += contents.length;
	}
	assert.equal(paths.length, fixture.backup.files);
	assert.equal(fileBytes, fixture.backup.bytes);
	assert(!manifestBytes.includes(Buffer.from(fixture.profileKeyBase64)));
	assert(!manifestBytes.includes(Buffer.from(fixture.apiSecret)));
	return { manifest, paths };
}

try {
	const runtime = spawnSync(executable, ["-e", "process.stdout.write(JSON.stringify({electron:typeof process.versions.electron}))"], { encoding: "utf8", timeout: 10_000 });
	assert.equal(runtime.status, 0);
	assert.equal(JSON.parse(runtime.stdout).electron, "undefined");
	await mkdir(profile, { mode: 0o700 });
	await mkdir(destination, { mode: 0o700 });
	await mkdir(project, { mode: 0o700 });
	await mkdir(join(profile, "Default"), { mode: 0o700 });
	await mkdir(join(coreRoot, "database"), { recursive: true, mode: 0o700 });
	await mkdir(join(coreRoot, "local-models"), { mode: 0o700 });
	await chmod(coreRoot, 0o700);
	await writeFile(join(profile, "Default/History"), browserMarker, { mode: 0o600 });
	await writeFile(join(profile, "Default/Cookies"), browserMarker, { mode: 0o600 });
	await writeFile(join(profile, "Local State"), browserMarker, { mode: 0o600 });
	await writeFile(join(project, "project.txt"), projectMarker, { mode: 0o600 });
	await writeFile(join(coreRoot, "local-models/model.fixture"), modelMarker, { mode: 0o600 });
	await writePrivateJson(join(coreRoot, "provider-accounts.json"), { version: 3, accounts: [], retiredLegacyAccountIds: [] });
	await writePrivateJson(join(coreRoot, "native-runtime-preferences.json"), { version: 1, subscriptions: {} });
	await writePrivateJson(join(coreRoot, "computer-use.json"), { version: 1, enabled: false });

	const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
	const { CredentialBroker, PlaintextSecretProtection } = await tsImport("../apps/desktop/src/main/credential-broker.ts", import.meta.url);
	const seeded = new KestrelDatabase(databasePath, profileKey);
	try {
		seeded.saveRuntimeSession({ id: fixtureSessionId, title: fixtureSessionTitle, allowedTools: [], status: "active", checkpoints: [], createdAt, updatedAt: createdAt });
		seeded.saveRuntimeMessage({ id: fixtureMessageId, sessionId: fixtureSessionId, role: "user", content: seededContent, createdAt });
		seeded.setPrivateState("generated-native-backup-setting", { value: seededPrivateState });
	} finally { seeded.close(); }
	const sourceBroker = new CredentialBroker(coreRoot, new PlaintextSecretProtection(), { keyProvider: async () => Buffer.from(profileKey) });
	await sourceBroker.setCredential("openai", apiSecret);
	const sourceEnvironment = await sourceBroker.providerEnvironment({});
	assert.equal(sourceEnvironment.OPENAI_API_KEY, apiSecret);
	delete sourceEnvironment.OPENAI_API_KEY;
	await assert.rejects(readFile(join(coreRoot, "secure/database-key.bin")), { code: "ENOENT" });
	await assert.rejects(readFile(join(coreRoot, "database.key")), { code: "ENOENT" });
	phase("generated-fixture-database-credential-and-allowlisted-settings-prepared-with-memory-only-key");

	const dialogSimulation = { selectionQueue: [null, destination], selectionCount: 0, revealPaths: [] };
	const first = startHost(dialogSimulation); states.push(first);
	await first.waitReady();
	let corePid = await waitForCorePid(first);
	phase("bundled-standalone-node-native-desktop-core-and-real-agent-core-ready-with-synthetic-permissions");
	const listed = await first.request("request", { type: "runtime-list-sessions" });
	assert.equal(listed.ok, true);
	assert(listed.sessions.some(session => session.id === fixtureSessionId && session.title === fixtureSessionTitle));
	const liveCreated = await first.request("request", { type: "runtime-create-session", title: "Generated live Core backup fixture", kind: "conversation" });
	assert.equal(liveCreated.ok, true);
	assert.equal(typeof liveCreated.session?.id, "string");
	const liveSessionId = liveCreated.session.id;
	phase("real-core-runtime-create-session-completed-over-private-protocol");

	const cancelled = await first.request("host-request", { type: "create-local-backup" });
	assert.deepEqual(cancelled, { ok: true, cancelled: true });
	assert.equal(dialogSimulation.selectionCount, 1);
	assert.deepEqual(await readdir(destination), []);
	assert.deepEqual(directCorePids(first), [corePid], "Picker cancellation must not stop or restart Core.");
	const afterCancel = await first.request("request", { type: "runtime-list-sessions" });
	assert(afterCancel.sessions.some(session => session.id === fixtureSessionId));
	assert(afterCancel.sessions.some(session => session.id === liveSessionId));
	phase("picker-cancellation-created-no-files-and-left-the-same-core-process-available");

	const beforeBackupCorePid = corePid;
	let pickerEntered, releasePicker;
	const pickerReady = new Promise(resolve => { pickerEntered = resolve; });
	const pickerRelease = new Promise(resolve => { releasePicker = resolve; });
	dialogSimulation.beforeSelection = async () => { pickerEntered(); await pickerRelease; };
	const creatingBackup = first.request("host-request", { type: "create-local-backup" });
	await timeout(pickerReady, 10_000, "Backup picker was not reserved.");
	const deniedDuringBackup = await first.request("request", { type: "runtime-create-session", title: "REJECTED_DURING_BACKUP", kind: "conversation" });
	assert.deepEqual(deniedDuringBackup, { ok: false, error: "A native Core backup is in progress. Try again after it finishes." });
	assert.deepEqual(directCorePids(first), [beforeBackupCorePid]);
	releasePicker(); delete dialogSimulation.beforeSelection;
	const createdResponse = await creatingBackup;
	phase("synchronous-backup-reservation-blocked-concurrent-session-mutation-before-copy");
	const backup = assertCreatedReceipt(createdResponse);
	backupId = backup.backupId;
	assertNoFixtureSecrets(backup, [temporary, profile, destination, project]);
	assert.equal(dialogSimulation.selectionCount, 2);
	const entries = await readdir(destination);
	const backupNames = entries.filter(name => name.startsWith("Kestrel-Native-Core-"));
	assert.equal(backupNames.length, 1);
	firstBackupPath = join(destination, backupNames[0]);
	assert.equal((await stat(firstBackupPath)).mode & 0o777, 0o700);
	const receiptBytes = await readFile(join(coreRoot, ".native-backup-receipts", `${backupId}.json`));
	for (const secret of [profileKeyBase64, apiSecret, temporary, profile, destination, firstBackupPath, seededContent, seededPrivateState])
		assert(!receiptBytes.includes(Buffer.from(secret)), "Encrypted reveal receipt leaked plaintext, a key, or a path.");
	const metadataJson = JSON.stringify(createdResponse);
	for (const secret of [profileKeyBase64, apiSecret, temporary, profile, destination, firstBackupPath, seededContent, seededPrivateState])
		assert(!metadataJson.includes(secret), "Native backup response metadata leaked plaintext, a key, or a path.");
	phase("real-native-local-backup-host-published-via-bundled-native-peer-with-pathless-metadata");

	const { manifest, paths } = await verifyBackupTree(firstBackupPath, {
		profilePath: profile,
		profileKeyBase64,
		apiSecret,
		seededContent,
		seededPrivateState,
		modelMarker,
		browserMarker,
		projectMarker,
		backup,
	});
	assert(paths.includes("secure/credentials/openai.bin"));
	const copiedDb = new KestrelDatabase(join(firstBackupPath, "database/kestrel.sqlite"), profileKey);
	try {
		assert(copiedDb.listRuntimeMessages(fixtureSessionId).some(message => message.id === fixtureMessageId && message.content === seededContent));
		assert.deepEqual(copiedDb.getPrivateState("generated-native-backup-setting"), { value: seededPrivateState });
		assert(copiedDb.listRuntimeSessions().some(session => session.id === liveSessionId));
	} finally { copiedDb.close(); }
	const copiedBroker = new CredentialBroker(firstBackupPath, new PlaintextSecretProtection(), { keyProvider: async () => Buffer.from(profileKey) });
	const copiedEnvironment = await copiedBroker.providerEnvironment({});
	assert.equal(copiedEnvironment.OPENAI_API_KEY, apiSecret);
	delete copiedEnvironment.OPENAI_API_KEY;
	const rawDatabase = await readFile(join(firstBackupPath, "database/kestrel.sqlite"));
	assert(!rawDatabase.includes(Buffer.from(seededContent)));
	assert(!rawDatabase.includes(Buffer.from(seededPrivateState)));
	assert(!rawDatabase.includes(Buffer.from(profileKeyBase64)));
	assert(!JSON.stringify(manifest).includes(profile));
	phase("manifest-hashes-encrypted-SQLite-private-state-and-credential-decrypted-with-fixture-key-and-exclusions-verified");

	corePid = await waitForCorePid(first, beforeBackupCorePid);
	assert.notEqual(corePid, beforeBackupCorePid, "Successful backup must stop and restart the bundled Agent Core process.");
	const afterBackupSessions = await first.request("request", { type: "runtime-list-sessions" });
	assert(afterBackupSessions.sessions.some(session => session.id === fixtureSessionId));
	assert(afterBackupSessions.sessions.some(session => session.id === liveSessionId));
	assert(!afterBackupSessions.sessions.some(session => session.title === "REJECTED_DURING_BACKUP"));
	assert.equal(backup.coreStatus, "ready");
	phase("core-clean-stop-restart-confirmed-by-new-child-and-post-backup-runtime-request");

	const badUuid = await first.request("host-request", { type: "reveal-created-local-backup", backupId: "not-a-uuid" });
	assert.equal(badUuid.ok, false);
	const unknownReceipt = await first.request("host-request", { type: "reveal-created-local-backup", backupId: randomUUID() });
	assert.equal(unknownReceipt.ok, false);
	assert.equal(dialogSimulation.revealPaths.length, 0);
	phase("invalid-and-unknown-receipt-ids-rejected-before-native-reveal");

	const firstReveal = await first.request("host-request", { type: "reveal-created-local-backup", backupId });
	assert.deepEqual(firstReveal, { ok: true });
	assert.deepEqual(dialogSimulation.revealPaths, [firstBackupPath]);
	assertNoFixtureSecrets(firstReveal, [temporary, profile, destination, project, firstBackupPath]);
	phase("in-memory-reveal-uses-validated-path-and-returns-no-path");
	assert.deepEqual(await first.stop(), { code: 0, signal: null });
	phase("first-native-desktop-core-and-agent-core-shutdown-cleanly");

	const second = startHost(dialogSimulation); states.push(second);
	await second.waitReady();
	const restartedSessions = await second.request("request", { type: "runtime-list-sessions" });
	assert.equal(restartedSessions.ok, true);
	assert(restartedSessions.sessions.some(session => session.id === fixtureSessionId));
	assert(restartedSessions.sessions.some(session => session.id === liveSessionId));
	const persistedReveal = await second.request("host-request", { type: "reveal-created-local-backup", backupId });
	assert.deepEqual(persistedReveal, { ok: true });
	assert.deepEqual(dialogSimulation.revealPaths.at(-1), firstBackupPath);
	assertNoFixtureSecrets(persistedReveal, [temporary, profile, destination, project, firstBackupPath]);
	phase("same-profile-restart-loaded-encrypted-receipt-and-revealed-the-original-backup");

	const replacement = `${firstBackupPath}.replaced`;
	await rename(firstBackupPath, replacement);
	await mkdir(firstBackupPath, { mode: 0o700 });
	const revealCount = dialogSimulation.revealPaths.length;
	const replacedReveal = await second.request("host-request", { type: "reveal-created-local-backup", backupId });
	assert.equal(replacedReveal.ok, false);
	assert.equal(dialogSimulation.revealPaths.length, revealCount, "A replaced directory must not reach the native reveal callback.");
	phase("receipt-refused-a-replaced-directory-before-native-reveal");
	assert.deepEqual(await second.stop(), { code: 0, signal: null });
	phase("second-native-desktop-core-and-agent-core-shutdown-cleanly");

	// Test-only offline recovery to the SAME generated profile path and key.
	// Preserve its original Core folder; this does not expose a product restore
	// command, migrate a foreign profile, or exercise a production Keychain.
	const preservedCore = join(profile, "generated-original-core-preserved");
	await rename(coreRoot, preservedCore);
	await mkdir(coreRoot, { mode: 0o700 });
	for (const file of manifest.files) {
		const target = join(coreRoot, ...file.path.split("/"));
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await copyFile(join(replacement, ...file.path.split("/")), target, constants.COPYFILE_EXCL);
		await chmod(target, 0o600);
	}
	const recovered = startHost(dialogSimulation); states.push(recovered);
	await recovered.waitReady();
	const restoredSessions = await recovered.request("request", { type: "runtime-list-sessions" });
	assert.equal(restoredSessions.ok, true);
	assert(restoredSessions.sessions.some(session => session.id === fixtureSessionId));
	assert(restoredSessions.sessions.some(session => session.id === liveSessionId));
	const restoredMessages = await recovered.request("request", { type: "runtime-list-messages", sessionId: fixtureSessionId });
	assert.equal(restoredMessages.ok, true);
	assert(restoredMessages.messages.some(message => message.id === fixtureMessageId && message.content === seededContent));
	const restoredCredentials = await recovered.request("host-request", { type: "credential-list" });
	assert.equal(restoredCredentials.ok, true);
	assert(restoredCredentials.credentials.some(credential => credential.id === "openai" && credential.configured));
	assertNoFixtureSecrets(restoredCredentials, [temporary, profile, destination]);
	assert((await readdir(preservedCore)).includes("database"));
	phase("test-only-offline-restore-to-same-generated-profile-path-reopened-session-message-and-encrypted-credential");
	assert.deepEqual(await recovered.stop(), { code: 0, signal: null });
	phase("same-profile-test-only-recovery-owner-shutdown-cleanly-original-preserved");

	result = "passed";
} catch (error) {
	receipt.result = result;
	receipt.error = boundedError(error);
	process.exitCode = 1;
	console.error(receipt.error);
} finally {
	receipt.result = result;
	let cleanupFailed = false;
	for (const host of states) {
		if (host.child.exitCode !== null || host.child.signalCode !== null) continue;
		let corePids = [];
		try { corePids = directCorePids(host); } catch { cleanupFailed = true; }
		try {
			host.child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
			await timeout(host.exited, 10_000, "Graceful Core host cleanup timed out.");
		} catch {
			host.child.kill("SIGTERM");
			try { await timeout(host.exited, 3_000, "Core host did not exit after SIGTERM."); }
			catch {
				host.child.kill("SIGKILL");
				try { await timeout(host.exited, 3_000, "Core host did not exit after SIGKILL."); }
				catch { cleanupFailed = true; }
			}
		}
		for (const pid of corePids) {
			try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") cleanupFailed = true; }
		}
		await waitForPidsGone(corePids, 3_000).catch(() => {
			cleanupFailed = true;
			for (const pid of corePids) { try { process.kill(pid, "SIGKILL"); } catch {} }
		});
	}
	profileKey.fill(0);
	try { await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
	catch { cleanupFailed = true; }
	try {
		receipt.candidateSha256After = await candidateDigest(candidate);
		if (receipt.candidateSha256After !== candidateSha256) {
			receipt.result = "failed";
			receipt.error = "CANDIDATE_CHANGED";
			process.exitCode = 1;
		}
	} catch {
		receipt.result = "failed";
		receipt.error = "CANDIDATE_FINGERPRINT_FAILED";
		process.exitCode = 1;
	}
	if (cleanupFailed) {
		receipt.result = "failed";
		receipt.error = "OWNED_CHILD_CLEANUP_FAILED";
		process.exitCode = 1;
	}
	receipt.phaseCount = receipt.phases.length;
	receipt.finishedAt = new Date().toISOString();
	await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

if (receipt.result === "passed") console.log(`PASS native local backup lifecycle (${receipt.phaseCount} phases)`);
