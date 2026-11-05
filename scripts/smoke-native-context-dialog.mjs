// Private Core/host protocol integration in an owned fixture. Picker replies
// are simulated here; only the separate on-screen test proves a Cocoa panel.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { nativeUnselectedAttachmentCanary } from "./native-provider-canary.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Supply an explicit disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "This fixture must not use an installed app.");
const fingerprint = await candidateDigest(candidate);
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-context-dialog-")));
const workspace = join(profile, "workspace");
await mkdir(workspace, { mode: 0o700 }); await mkdir(join(profile, "native-core"), { mode: 0o700 });
await writeFile(join(workspace, "README.md"), "Owned native picker protocol fixture.\n", { mode: 0o600 });
await writeFile(join(profile, "outside.txt"), "Never selected.\n", { mode: 0o600 });
const root = await realpath(workspace), file = join(root, "README.md");
await writeFile(join(profile, "native-core/workspace-grants.json"), JSON.stringify([{ path: root, name: "Native picker fixture" }]), { mode: 0o600 });
const resources = join(candidate, "Contents/Resources");
const protectedKeyBase64 = randomBytes(32).toString("base64");
const receipt = { at: new Date().toISOString(), candidateSha256: fingerprint, simulatedPickerReplies: true, phases: [] };
const evidence = resolve(process.env.KESTREL_NATIVE_CONTEXT_DIALOG_EVIDENCE || ".tmp/native-context-dialog-evidence");
const imported = process.env.KESTREL_TEST_NATIVE_LEGACY_CONFLICTS === "1"
	? await prepareLegacyConflictProfile().catch(async error => { await rm(profile, { recursive: true, force: true }); throw error; })
	: undefined;
const child = spawn(join(resources, "agent-core/node/bin/node"), [join(resources, "native-desktop-core.mjs"), "--profile-root", profile, "--browser-profile-root", profile, "--durable-profile"], { env: { ...process.env, KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let output = "", ready = false, mode = "select", sequence = 0, held, cancelled = false;
const pending = new Map(), dialogs = [];
let unrelatedServer;
const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
child.stderr.on("data", chunk => { output += chunk; });
function write(value) { child.stdin.write(JSON.stringify(value) + "\n"); }
createInterface({ input: child.stdout }).on("line", line => {
	try {
		const message = JSON.parse(line);
		if (message.kind === "native-core-profile-key-request") write({ kind: "native-core-profile-key-response", requestId: message.requestId, ok: true, keyBase64: protectedKeyBase64 });
		else if (message.type === "ready") ready = true;
		else if (message.type === "response") {
			const item = pending.get(message.id); if (!item) return;
			pending.delete(message.id); clearTimeout(item.timer); item.resolve(message.response);
		} else if (message.type === "browser-backend-reset") write({ type: "browser-backend-reset-response", requestId: message.requestId, ok: true });
		else if (message.type === "native-dialog-cancel") { if (held?.requestId === message.requestId) cancelled = true; }
		else if (message.type === "native-dialog-request") {
			assert.equal(message.operation, "select-context-files"); assert.equal(message.workspaceRoot, root); dialogs.push(message.requestId);
			if (mode === "hold") { held = message; return; }
			write({ type: "native-dialog-response", requestId: message.requestId, response: mode === "cancel" ? { ok: true, cancelled: true } : { ok: true, selectedContextPaths: [mode === "outside" ? join(profile, "outside.txt") : file] } });
		}
	} catch (error) { output += String(error); child.kill("SIGTERM"); }
});
function request(request, host = false) {
	const id = `fixture-${++sequence}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native context protocol timed out: " + output)); }, 20_000);
		pending.set(id, { resolve, timer }); write({ type: host ? "host-request" : "request", id, request });
	});
}
async function wait(check, label) { for (const end = Date.now() + 20_000; Date.now() < end;) { assert.equal(child.exitCode, null, output); if (check()) return; await delay(25); } assert.fail(label + " " + output); }

async function prepareLegacyConflictProfile() {
	const { seedNativeLegacy19Source } = await tsImport("../packages/database/src/legacy-profile-source-fixture.ts", import.meta.url);
	const { launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
	const sourceRoot = join(profile, "generated-legacy-source"), transferHome = join(profile, "generated-transfer-home");
	await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(transferHome, { mode: 0o700 });
	// openNativeCoreProfile(durable:true) opens this exact canonical database.
	const destinationRoot = join(profile, "native-core/database"); await mkdir(destinationRoot, { mode: 0o700 });
	const sourceDatabasePath = join(sourceRoot, "kestrel.sqlite"), destinationDatabasePath = join(destinationRoot, "kestrel.sqlite");
	const sourceKey = randomBytes(32);
	let worker;
	try {
		const generated = seedNativeLegacy19Source(sourceDatabasePath, sourceKey, { conflictingJobs: true });
		const sourceBytes = await readFile(sourceDatabasePath);
		worker = launchCoreTransferFixture({ executable: join(resources, "agent-core/node/bin/node"), entry: join(resources, "agent-core/service/host-profile-file-transfer.js"), home: transferHome });
		const planned = await worker.request("plan", { sourceDatabasePath, destinationDatabasePath, sourceKeyBase64: sourceKey.toString("base64") });
		assert.equal(planned.ok, true, "The bundled worker must recognize the generated legacy conflict profile.");
		assert.deepEqual(planned.preview.legacy, { sourceSchemaVersion: 19, jobAliases: 1, archivedDiagnosticEvents: 1, archivedMemoryJobs: 2, pausedMemoryJobIdentities: 1 });
		const applied = await worker.request("apply", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: protectedKeyBase64 });
		assert.equal(applied.ok, true, "The bundled worker must apply the reviewed generated transfer.");
		assert.equal(applied.receipt.activationPerformed, false);
		const verified = await worker.request("verify-recovery", { recoveryId: applied.recoveryId });
		assert.equal(verified.ok, true); assert.equal(verified.recovery.originalReadable, true); assert.equal(verified.recovery.destinationReadable, true);
		assert((await readFile(sourceDatabasePath)).equals(sourceBytes), "Transfer must preserve every generated source byte.");
		for (const secret of [sourceKey.toString("base64"), protectedKeyBase64, generated.privateMessage, generated.diagnostic])
			assert(!worker.output().includes(secret) && !worker.errors().includes(secret), "The private transfer pipe must not log keys or private fixture contents.");
		receipt.phases.push({ phase: "bundled-worker-legacy-conflict-plan-apply-and-independent-key-recovery", passed: true, ...planned.preview.legacy, activationPerformed: false, sourceBytesUnchanged: true });
		return { generated, sourceDatabasePath, destinationDatabasePath, sourceBytes };
	} finally {
		try { if (worker) { assert.deepEqual(await worker.stop(), { code: 0, signal: null }); assert.equal(worker.errors(), ""); } }
		finally { sourceKey.fill(0); }
	}
}

async function verifyLegacyConflictArchives() {
	const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
	const { LEGACY_PROFILE_SECRET_KEY, parseLegacyProfileSecret } = await tsImport("../packages/database/src/legacy-profile-state.ts", import.meta.url);
	const { readLegacyMemoryJobConflict } = await tsImport("../packages/database/src/legacy-memory-job-conflicts.ts", import.meta.url);
	const key = Buffer.from(protectedKeyBase64, "base64");
	let database, archiveSecret;
	try {
		database = new KestrelDatabase(imported.destinationDatabasePath, key);
		// Inspect only this generated database after its actual bundled owner
		// stops. Guard probes must fail before any database mutation is possible.
		database.db.pragma("query_only=ON");
		archiveSecret = parseLegacyProfileSecret(database.getPrivateState(LEGACY_PROFILE_SECRET_KEY));
		const archive = readLegacyMemoryJobConflict(archiveSecret, imported.generated.job.dedupeKey, name => database.getPrivateState(name));
		assert(archive && !archive.purged, "Both generated conflict archives must survive actual Core startup and work.");
		assert.deepEqual(archive.group.jobIds, [imported.generated.job.id, imported.generated.alias].sort());
		const expectedBudgets = [{ status: "failed", attempts: 3, maxAttempts: 3 }, { status: "pending", attempts: 0, maxAttempts: 3 }];
		for (const field of ["originalPayloadJson", "observedPayloadJson"]) {
			const budgets = archive.jobs.map(item => { const job = JSON.parse(item[field]); return { status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts }; }).sort((left, right) => left.status.localeCompare(right.status));
			assert.deepEqual(budgets, expectedBudgets, "Core must preserve both archived retry budgets.");
		}
		assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM memory_jobs WHERE id IN (?, ?)").get(imported.generated.job.id, imported.generated.alias).count, 0, "Neither archived identity may become a physical runnable job.");
		let guardedIdentities = 0;
		for (const id of [imported.generated.job.id, imported.generated.alias]) {
			assert.equal(database.getMemoryJob(id), undefined);
			assert.throws(() => database.queueMemoryJob({ ...imported.generated.job, id, dedupeKey: "generated-changed-dedupe", status: "pending", attempts: 0 }), /remain paused/); guardedIdentities++;
		}
		assert.throws(() => database.getMemoryJobByDedupeKey(imported.generated.job.dedupeKey), /remain paused/); guardedIdentities++;
		assert((await readFile(imported.sourceDatabasePath)).equals(imported.sourceBytes), "Core and provider work must leave every generated source byte unchanged.");
		receipt.phases.push({ phase: "imported-conflict-archives-and-identity-guards-survive-real-Core-and-unrelated-provider-work", passed: true, archivedMemoryJobs: archive.jobs.length, guardedIdentities, physicalArchivedJobs: 0, originalAndObservedBudgetsPreserved: true, sourceBytesUnchanged: true });
	} finally { database?.close(); archiveSecret?.fill(0); key.fill(0); }
}
try {
	await wait(() => ready, "Native Core did not become ready.");
	if (imported) {
		const sessions = await request({ type: "runtime-list-sessions" }); assert(sessions.ok, sessions.error);
		assert(sessions.sessions?.some(session => session.id === "generated-legacy19-session"), "The real native owner must expose the imported generated conversation.");
		const messages = await request({ type: "runtime-list-messages", sessionId: "generated-legacy19-session" }); assert(messages.ok, messages.error);
		assert(messages.messages?.some(message => message.id === "generated-legacy19-message" && message.content === imported.generated.privateMessage), "The actual owner must decrypt the imported generated message.");
		receipt.phases.push({ phase: "actual-bundled-native-Core-boots-imported-conflict-profile-and-decrypts-conversation", passed: true, importedConversations: 1, importedMessages: 1 });
	}
	const selected = await request({ type: "select-context-files", workspaceRoot: root }, true);
	assert(selected.ok && selected.selectedAttachments?.length === 1, JSON.stringify(selected));
	assert.equal(selected.selectedAttachments[0].path, file);
	assert.equal(selected.selectedAttachments[0].mediaType, "text/markdown");
	assert.equal(selected.selectedAttachments[0].source, undefined);
	mode = "cancel"; const dismissed = await request({ type: "select-context-files", workspaceRoot: root }, true);
	assert(dismissed.ok && dismissed.cancelled, JSON.stringify(dismissed));
	mode = "outside"; assert.equal((await request({ type: "select-context-files", workspaceRoot: root }, true)).ok, false);
	assert.equal(new Set(dialogs).size, 3);
	receipt.phases.push({ phase: "private-Core-picker-response-cancel-and-containment", passed: true });
	const pasted = await request({ type: "create-pasted-text-attachment", text: "Owned generated context.\n" }, true);
	assert(pasted.ok && pasted.selectedAttachments?.[0], JSON.stringify(pasted));
	assert.equal(await readFile(pasted.selectedAttachments[0].path, "utf8"), "Owned generated context.\n");
	const created = await request({ type: "runtime-create-session", title: "Unselected file refusal fixture", kind: "conversation" }); assert(created.ok);
	const refused = await request({ type: "runtime-run-agent", sessionId: created.session.id, message: "Never read an unselected external file.", model: "auto", providerIds: ["auto"], attachments: [{ path: join(profile, "outside.txt"), name: "outside.txt", size: 16, mediaType: "text/plain", source: "external" }] });
	assert.equal(refused.ok, false); assert.match(refused.error, /external files created by this native attachment host/);
	receipt.phases.push({ phase: "private-Core-unselected-external-attachment-refusal", passed: true });
	// Reproduce the canary's original race with real independent HTTP traffic:
	// another account finishes while the unselected attachment is refused.
	let unrelatedCompletions = 0;
	unrelatedServer = createServer(async (incoming, response) => {
		if (incoming.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "native-unrelated-fixture" }] })); return; }
		if (incoming.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
		let input = ""; for await (const chunk of incoming) input += chunk;
		assert(input.includes("NATIVE_INDEPENDENT_COMPLETION")); unrelatedCompletions++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify({ id: "independent", choices: [{ delta: { content: "Independent fixture completed." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise(resolve => unrelatedServer.listen(0, "127.0.0.1", resolve));
	const unrelatedAdded = await request({ type: "provider-account-create", account: { providerId: "native-unrelated-fixture", adapter: "openai-compatible", displayName: "Independent generated traffic", authTransport: "local", enabled: true, baseUrl: `http://127.0.0.1:${unrelatedServer.address().port}/v1`, defaultModel: "native-unrelated-fixture", headers: [] } }, true); assert(unrelatedAdded.ok, unrelatedAdded.error);
	const unrelatedAccount = unrelatedAdded.providerAccounts.find(item => item.providerId === "native-unrelated-fixture"); assert(unrelatedAccount);
	const unrelatedSession = await request({ type: "runtime-create-session", title: "Independent provider traffic", kind: "conversation" }); assert(unrelatedSession.ok, unrelatedSession.error);
	await nativeUnselectedAttachmentCanary({ request: async input => {
		if (input.type === "runtime-run-agent" && input.attachments?.length) {
			const [refused, independent] = await Promise.all([
				request(input),
				request({ type: "runtime-run-agent", sessionId: unrelatedSession.session.id, message: "Reply only NATIVE_INDEPENDENT_COMPLETION. Do not use tools.", model: "native-unrelated-fixture", providerIds: [unrelatedAccount.id], maximumTurns: 1 }),
			]);
			assert(independent.ok, independent.error); assert.equal(independent.run?.status, "completed"); return refused;
		}
		return request(input, input.type.startsWith("provider-account-"));
	}, profile, receipt });
	assert.equal(unrelatedCompletions, 1, "An independent provider completion must occur during the refusal check.");
	const removedUnrelated = await request({ type: "provider-account-remove", accountId: unrelatedAccount.id }, true); assert(removedUnrelated.ok, removedUnrelated.error);
	receipt.phases.push({ phase: "private-Core-attachment-refusal-isolated-from-independent-provider-completion", passed: true, unrelatedCompletions });
	mode = "hold"; const waiting = request({ type: "select-context-files", workspaceRoot: root }, true).catch(() => undefined);
	await wait(() => held, "The owned pending picker did not start.");
	write({ type: "shutdown" });
	const result = await Promise.race([exit, delay(15_000, undefined, { ref: false }).then(() => { throw new Error("Pending picker prevented shutdown: " + output); })]);
	assert.deepEqual(result, { code: 0, signal: null }, output); assert(cancelled, "Shutdown must cancel the private picker.");
	for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ ok: false, error: "Fixture owner stopped." }); } pending.clear(); await waiting;
	assert(!(await readdir(join(profile, "native-core"))).some(name => name.startsWith("composer-attachments-")));
	if (imported) await verifyLegacyConflictArchives();
	assert.equal(await candidateDigest(candidate), fingerprint);
	receipt.candidateSha256After = fingerprint;
	receipt.phases.push({ phase: "private-Core-pending-picker-cancellation-and-generated-context-cleanup", passed: true });
	await mkdir(evidence, { recursive: true });
	await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
	console.log("Native private context picker protocol, cancellation, file ownership and shutdown passed. Cocoa UI was not exercised.");
} finally {
	if (unrelatedServer) { unrelatedServer.closeAllConnections(); await new Promise(resolve => unrelatedServer.close(resolve)); }
	if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
	for (const item of pending.values()) clearTimeout(item.timer);
	await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
