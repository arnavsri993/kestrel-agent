// End-to-end private project-handoff protocol check against a selected native
// candidate. Folder picker replies are simulated over the real Core pipe; this
// does not exercise Cocoa UI or prove Keychain/canonical installation behavior.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Select an explicit native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "Use a disposable candidate, never the installed app.");
const evidence = resolve(process.env.KESTREL_NATIVE_PROJECT_HANDOFF_EVIDENCE || ".tmp/native-project-handoff-evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory.");

const resources = join(candidate, "Contents/Resources");
const node = join(resources, "agent-core/node/bin/node");
const transferEntry = join(resources, "agent-core/service/host-profile-project-transfer.js");
const coreEntry = join(resources, "native-desktop-core.mjs");
const receipt = {
	version: 1,
	startedAt: new Date().toISOString(),
	candidateSha256: await candidateDigest(candidate),
	scope: "Generated profile and independent random keys; actual bundled project-transfer worker and native Core over private pipes. Picker replies are simulated without GUI. This is not Cocoa UI, Keychain, canonical-installation, or user-profile proof.",
	phases: [],
};
const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-project-handoff-")));
await chmod(fixture, 0o700);
const sourceRoot = join(fixture, "source-profile"), profileRoot = join(fixture, "destination-profile");
const coreRoot = join(profileRoot, "native-core"), sourceDatabase = join(sourceRoot, "database/kestrel.sqlite");
const destinationDatabase = join(coreRoot, "database/kestrel.sqlite");
const secondProfileRoot = join(fixture, "second-destination-profile"), secondCoreRoot = join(secondProfileRoot, "native-core");
const secondBrowserRoot = join(fixture, "second-browser-profile");
const importedHint = join(fixture, "old-imported-folder"), selectedFolder = join(fixture, "trusted-new-folder");
const browserRoot = join(fixture, "browser-profile");
for (const directory of [sourceRoot, join(sourceRoot, "database"), profileRoot, coreRoot, join(coreRoot, "database"), secondProfileRoot, secondCoreRoot,
	join(secondCoreRoot, "database"), secondBrowserRoot, importedHint, selectedFolder, browserRoot]) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
}

const sourceKey = randomBytes(32), destinationKey = randomBytes(32), secondDestinationKey = randomBytes(32);
const handoffId = randomUUID(), secondHandoffId = randomUUID();
const timestamp = "2026-11-06T14:00:00.000Z";
const instructions = "Generated private project instructions; preserve line one.\nPreserve line two.";
const projects = [
	{ id: "generated-custom-project", path: importedHint, name: "Generated custom project", instructions, createdAt: timestamp, updatedAt: timestamp, order: 0 },
	{ id: "generated-project-to-remove", path: join(fixture, "old-second-folder"), name: "Generated removable project", instructions: "Second generated instruction.", createdAt: timestamp, updatedAt: timestamp, order: 1 },
];
await mkdir(projects[1].path, { mode: 0o700 });
await writeFile(join(importedHint, "README.md"), "Old imported folder must never be granted.\n", { mode: 0o600 });
await writeFile(join(selectedFolder, "README.md"), "Trusted simulated folder choice.\n", { mode: 0o600 });
await writeFile(join(sourceRoot, "workspace-grants.json"), JSON.stringify(projects), { mode: 0o600 });

const stageNames = [
	"seed-generated-source-database",
	"actual-bundled-plan-apply-verify-profile",
	"initial-Core-pending-metadata-and-no-old-authority",
	"first-reconnect-dialog-cancellation-and-late-choice",
	"host-client-cancellation-and-late-choice",
	"trusted-folder-reconnect-preserves-project-identity-metadata-and-time",
	"Core-restart-retains-reconnected-and-pending-identities",
	"remove-pending-project-does-not-resurrect-after-restart",
	"actual-bundled-second-hop-plan-apply-verify-profile",
	"second-Core-retains-exact-pending-metadata-without-workspace-authority",
];
let stage = stageNames[0], transfer, owner, finalHandoffState;
const ownedChildren = new Set();
const mark = phase => { receipt.phases.push({ phase, passed: true }); console.log(`PASS ${phase}`); };
function own(child) { ownedChildren.add(child); child.once("exit", () => ownedChildren.delete(child)); return child; }
function within(promise, timeoutMs, message) {
	return new Promise((resolveValue, rejectValue) => {
		const timer = setTimeout(() => rejectValue(new Error(message)), timeoutMs);
		promise.then(value => { clearTimeout(timer); resolveValue(value); }, error => { clearTimeout(timer); rejectValue(error); });
	});
}
async function snapshotTree(root) {
	const snapshot = {};
	async function visit(directory) {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name), relative = path.slice(root.length + 1), info = await stat(path);
			if (entry.isDirectory()) await visit(path);
			else {
				assert(entry.isFile(), `Unexpected non-file in generated profile snapshot: ${relative}`);
				const bytes = await readFile(path);
				snapshot[relative] = { sha256: createHash("sha256").update(bytes).digest("hex"), size: info.size, mode: info.mode & 0o777 };
			}
		}
	}
	await visit(root);
	return snapshot;
}
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const C = await tsImport("../packages/shared-types/src/index.ts", import.meta.url);
const { launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
const safeInspect = operation => {
	const database = new KestrelDatabase(destinationDatabase, destinationKey);
	try { return operation(database); } finally { database.close(); }
};

function createOwner({ selectedProfile = profileRoot, selectedBrowser = browserRoot, selectedHandoff = handoffId, profileKey = destinationKey, useHandoff = true } = {}) {
	const args = [coreEntry, "--durable-profile", "--profile-root", selectedProfile, "--browser-profile-root", selectedBrowser,
		...(useHandoff ? ["--project-handoff-id", selectedHandoff] : [])];
	const child = own(spawn(node, args, {
		cwd: fixture,
		env: { HOME: fixture, TMPDIR: fixture, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	}));
	let stderr = "", sequence = 0, readySeen = false;
	const pending = new Map(), waiters = [], backlog = [];
	const exit = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
	const dispatch = message => {
		if (message?.type === "ready") readySeen = true;
		if (message?.kind === "native-core-profile-key-request") {
			child.stdin.write(`${JSON.stringify({ kind: "native-core-profile-key-response", requestId: message.requestId, ok: true, keyBase64: profileKey.toString("base64"), testProfile: true })}\n`);
			return;
		}
		if (message?.type === "response" && typeof message.id === "string") {
			const resolveResponse = pending.get(message.id);
			if (resolveResponse) { pending.delete(message.id); resolveResponse(message.response); return; }
		}
		for (let index = 0; index < waiters.length; index++) {
			if (waiters[index].predicate(message)) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); return; }
		}
		backlog.push(message);
	};
	createInterface({ input: child.stdout }).on("line", line => {
		try { dispatch(JSON.parse(line)); } catch { child.kill("SIGTERM"); }
	});
	child.stderr.on("data", bytes => { stderr += bytes.toString("utf8"); });
	child.stdin.on("error", () => {});
	function take(predicate, timeout = 30_000) {
		const index = backlog.findIndex(predicate);
		if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
		return Promise.race([
			new Promise((resolveMessage, reject) => {
				const waiter = { predicate, resolve: resolveMessage, timer: undefined };
				waiters.push(waiter);
				waiter.timer = setTimeout(() => {
					const position = waiters.indexOf(waiter);
					if (position >= 0) waiters.splice(position, 1);
					reject(new Error("Timed out waiting for private native Core protocol evidence."));
				}, timeout);
			}),
			exit.then(() => { throw new Error("The bundled native Core stopped before producing expected protocol evidence."); }),
		]);
	}
	function request(request, host = false) {
		const id = `generated-${++sequence}`;
		const promise = new Promise(resolveResponse => pending.set(id, resolveResponse));
		child.stdin.write(`${JSON.stringify({ type: host ? "host-request" : "request", id, request })}\n`);
		const bounded = within(promise, 45_000, "Timed out waiting for a private native Core response.").catch(error => { pending.delete(id); throw error; });
		return { id, promise: bounded };
	}
	async function stop() {
		if (child.exitCode === null && child.signalCode === null) {
			child.stdin.write('{"type":"shutdown"}\n');
			child.stdin.end();
		}
		let result;
		try { result = await within(exit, 20_000, "The generated native Core did not stop in time."); }
		catch {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			result = await within(exit, 5_000, "The generated native Core remained alive after its owned shutdown.");
		}
		assert.deepEqual(result, { code: 0, signal: null });
		return { stderrLength: stderr.length };
	}
	return { child, exit, request, take, stop, pending, get readySeen() { return readySeen; } };
}

async function expectStartupRefusal(options) {
	const before = await readFile(options.databasePath);
	const probe = createOwner({ selectedProfile: options.profile, selectedBrowser: options.browser, selectedHandoff: options.handoffId, useHandoff: options.useHandoff });
	try {
		const refused = await probe.take(message => message.type === "start-error", 30_000);
		assert.equal(refused.error, "Kestrel Core could not open the native profile. Existing data was preserved.");
		assert.equal(probe.readySeen, false);
		const result = await within(probe.exit, 15_000, "The rejected generated Core did not exit.");
		assert.equal(result.code, 1); assert.equal(result.signal, null);
		assert.deepEqual(await readFile(options.databasePath), before);
	} finally {
		if (probe.child.exitCode === null && probe.child.signalCode === null) {
			probe.child.stdin.end(); probe.child.kill("SIGTERM");
			await within(probe.exit, 5_000, "A rejected owned Core did not stop.").catch(() => {
				if (probe.child.exitCode === null && probe.child.signalCode === null) probe.child.kill("SIGKILL");
			});
		}
	}
}

try {
	if (!(await stat(node)).isFile() || !(await stat(coreEntry)).isFile() || !(await stat(transferEntry)).isFile())
		throw new Error("The selected candidate is missing its bundled Core or transfer worker.");

	stage = stageNames[0];
	const source = new KestrelDatabase(sourceDatabase, sourceKey);
	try {
		for (const project of projects) {
			const suffix = project.id === projects[0].id ? "connected" : "removed";
			const sessionId = `generated-session-${suffix}`;
			source.saveRuntimeSession(C.RuntimeSessionSchema.parse({ id: sessionId, title: "Generated handoff session", projectId: project.id, workspaceRoot: project.path,
				privacyMode: "private", allowedTools: ["workspace.read"], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp }));
			source.saveRuntimeMessage({ id: `generated-message-${suffix}`, sessionId, role: "user", content: `Generated encrypted message for ${suffix}.`, createdAt: timestamp });
			source.upsertMemoryEntity(C.EntityRecordSchema.parse({ id: `generated-memory-${suffix}`, kind: "project", canonicalName: project.name, aliases: [],
				description: "Generated project entity.", structuredData: { projectId: project.id, path: project.path }, sourceIds: [`project:${project.id}`], confidence: 1,
				sensitivity: "restricted", status: "active", firstSeenAt: timestamp, lastSeenAt: timestamp, createdAt: timestamp, updatedAt: timestamp }));
		}
	} finally { source.close(); }
	const sourceBytes = await readFile(sourceDatabase), registryBytes = await readFile(join(sourceRoot, "workspace-grants.json"));
	mark("seed-generated-source-database");

	stage = stageNames[1];
	transfer = launchCoreTransferFixture({ executable: node, entry: transferEntry, home: fixture, requestTimeoutMs: 60_000 });
	ownedChildren.add(transfer.child); transfer.child.once("exit", () => ownedChildren.delete(transfer.child));
	const planned = await transfer.request("plan-profile", { sourceProfileRoot: sourceRoot, destinationCoreRoot: coreRoot, handoffId, sourceKeyBase64: sourceKey.toString("base64") });
	assert.equal(planned.ok, true);
	assert.equal(planned.preview.projectHandoff.projects, 2);
	assert.equal(planned.preview.projectHandoff.pendingIdentities, 2);
	assert.equal(planned.preview.projectHandoff.registryPresent, true);
	const applied = await transfer.request("apply-profile", { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: destinationKey.toString("base64") });
	assert.equal(applied.ok, true); assert.equal(applied.receipt.activationPerformed, false);
	const verified = await transfer.request("verify-profile", { recoveryId: applied.recoveryId });
	assert.equal(verified.ok, true); assert.equal(verified.recovery.originalReadable, true); assert.equal(verified.recovery.destinationReadable, true);
	assert.deepEqual(await transfer.stop(), { code: 0, signal: null });
	assert.equal(transfer.errors(), "");
	for (const secret of [sourceKey.toString("base64"), destinationKey.toString("base64"), instructions, `Generated encrypted message for connected.`])
		assert(!transfer.output().includes(secret) && !transfer.errors().includes(secret));
	transfer = undefined;
	assert((await readFile(sourceDatabase)).equals(sourceBytes));
	assert((await readFile(join(sourceRoot, "workspace-grants.json"))).equals(registryBytes));
	mark("actual-bundled-plan-apply-verify-profile");

	stage = stageNames[2];
	owner = createOwner();
	await owner.take(message => message.type === "ready", 60_000);
	const listed = owner.request({ type: "get-workspace-grants" }, true);
	const grants = await listed.promise;
	assert.equal(grants.ok, true);
	assert.deepEqual(grants.projects, []); assert.deepEqual(grants.workspaceGrants, []);
	assert.deepEqual(grants.pendingWorkspaceProjects, projects.map(({ id, name }) => ({ id, name })));
	assert(!JSON.stringify(grants).includes(importedHint));
	assert(!JSON.stringify(grants).includes(instructions));
	const sessionsResult = await owner.request({ type: "runtime-list-sessions" }).promise;
	assert.equal(sessionsResult.ok, true);
	for (const id of ["generated-session-connected", "generated-session-removed"]) {
		const session = sessionsResult.sessions.find(value => value.id === id);
		assert.equal(session?.projectId, id.endsWith("connected") ? projects[0].id : projects[1].id);
		assert.equal(session?.workspaceRoot, undefined);
	}
	const denied = await owner.request({ type: "runtime-call-tool", sessionId: "generated-session-connected", toolName: "workspace.read", input: { path: "README.md" } }).promise;
	assert.equal(denied.ok, false);
	mark("initial-Core-pending-metadata-and-no-old-authority");

	// Transfer the still-pending imported profile into a second generated profile
	// before reconnect/removal changes its identity state. This exercises the
	// actual bundled worker twice and ensures pending metadata remains data only.
	await owner.stop(); owner = undefined;
	const firstDestinationSnapshot = await snapshotTree(coreRoot);
	transfer = launchCoreTransferFixture({ executable: node, entry: transferEntry, home: fixture, requestTimeoutMs: 60_000 });
	ownedChildren.add(transfer.child); transfer.child.once("exit", () => ownedChildren.delete(transfer.child));
	const secondPlan = await transfer.request("plan-profile", { sourceProfileRoot: coreRoot, destinationCoreRoot: secondCoreRoot,
		handoffId: secondHandoffId, sourceKeyBase64: destinationKey.toString("base64") });
	assert.equal(secondPlan.ok, true);
	assert.equal(secondPlan.preview.projectHandoff.projects, 2);
	assert.equal(secondPlan.preview.projectHandoff.pendingIdentities, 2);
	const secondApplied = await transfer.request("apply-profile", { planId: secondPlan.planId,
		acceptedPlanSha256: secondPlan.preview.planSha256, approved: true, destinationKeyBase64: secondDestinationKey.toString("base64") });
	assert.equal(secondApplied.ok, true); assert.equal(secondApplied.receipt.activationPerformed, false);
	const secondVerified = await transfer.request("verify-profile", { recoveryId: secondApplied.recoveryId });
	assert.equal(secondVerified.ok, true); assert.equal(secondVerified.recovery.originalReadable, true); assert.equal(secondVerified.recovery.destinationReadable, true);
	assert.deepEqual(await transfer.stop(), { code: 0, signal: null });
	assert.equal(transfer.errors(), "");
	for (const secret of [destinationKey.toString("base64"), secondDestinationKey.toString("base64"), instructions])
		assert(!transfer.output().includes(secret) && !transfer.errors().includes(secret));
	transfer = undefined;
	assert.deepEqual(await snapshotTree(coreRoot), firstDestinationSnapshot, "the first destination source snapshot changed during the second hop");
	mark("actual-bundled-second-hop-plan-apply-verify-profile");

	owner = createOwner({ selectedProfile: secondProfileRoot, selectedBrowser: secondBrowserRoot, selectedHandoff: secondHandoffId, profileKey: secondDestinationKey });
	await owner.take(message => message.type === "ready", 60_000);
	const secondGrants = await owner.request({ type: "get-workspace-grants" }, true).promise;
	assert.equal(secondGrants.ok, true);
	assert.deepEqual(secondGrants.projects, []); assert.deepEqual(secondGrants.workspaceGrants, []);
	assert.deepEqual(secondGrants.pendingWorkspaceProjects, projects.map(({ id, name }) => ({ id, name })));
	const { NativeProjectHandoffFile: SecondHandoffFile } = await tsImport("../apps/desktop/src/main/native-project-handoff-file.ts", import.meta.url);
	const { parseNativeProjectHandoffState: parseSecondHandoff } = await tsImport("../apps/desktop/src/main/native-project-handoff-state.ts", import.meta.url);
	const secondFile = new SecondHandoffFile({ root: secondCoreRoot, key: secondDestinationKey });
	try {
		const secondState = parseSecondHandoff((await secondFile.read(secondHandoffId)).value, secondHandoffId);
		assert.deepEqual(secondState.pendingProjectIds, projects.map(({ id }) => id));
		assert.deepEqual(secondState.projects.map(({ id, pathHint, name, instructions, createdAt, updatedAt }) => ({ id, path: pathHint, name, instructions, createdAt, updatedAt })),
			projects.map(({ id, path, name, instructions, createdAt, updatedAt }) => ({ id, path, name, instructions, createdAt, updatedAt })));
	} finally { secondFile.close(); }
	await owner.stop(); owner = undefined;
	secondDestinationKey.fill(0);
	mark("second-Core-retains-exact-pending-metadata-without-workspace-authority");

	// Resume the first destination's existing reconnect/cancel/removal checks.
	owner = createOwner(); await owner.take(message => message.type === "ready", 60_000);

	stage = stageNames[3];
	const first = owner.request({ type: "reconnect-workspace-project", projectId: projects[0].id }, true);
	const firstDialog = await owner.take(message => message.type === "native-dialog-request" && message.operation === "select-workspace-folder");
	owner.child.stdin.write(`${JSON.stringify({ type: "native-dialog-response", requestId: firstDialog.requestId, response: { ok: true, cancelled: true } })}\n`);
	const firstCancelled = await first.promise;
	assert.equal(firstCancelled.ok, true); assert.equal(firstCancelled.cancelled, true);
	owner.child.stdin.write(`${JSON.stringify({ type: "native-dialog-response", requestId: firstDialog.requestId, response: { ok: true, selectedWorkspacePath: selectedFolder } })}\n`);
	const stillPending = await owner.request({ type: "get-workspace-grants" }, true).promise;
	assert.deepEqual(stillPending.pendingWorkspaceProjects.map(value => value.id), projects.map(value => value.id));
	assert.deepEqual(stillPending.projects, []);
	mark("first-reconnect-dialog-cancellation-and-late-choice");

	stage = stageNames[4];
	const abandoned = owner.request({ type: "reconnect-workspace-project", projectId: projects[0].id }, true);
	const abandonedDialog = await owner.take(message => message.type === "native-dialog-request" && message.operation === "select-workspace-folder");
	owner.child.stdin.write(`${JSON.stringify({ type: "host-cancel", id: abandoned.id })}\n`);
	await owner.take(message => message.type === "native-dialog-cancel" && message.requestId === abandonedDialog.requestId);
	const lostClient = await abandoned.promise;
	assert.equal(lostClient.ok, true); assert.equal(lostClient.cancelled, true);
	owner.child.stdin.write(`${JSON.stringify({ type: "native-dialog-response", requestId: abandonedDialog.requestId, response: { ok: true, selectedWorkspacePath: selectedFolder } })}\n`);
	const afterLoss = await owner.request({ type: "get-workspace-grants" }, true).promise;
	assert.deepEqual(afterLoss.pendingWorkspaceProjects.map(value => value.id), projects.map(value => value.id));
	assert.deepEqual(afterLoss.projects, []);
	mark("host-client-cancellation-and-late-choice");

	stage = stageNames[5];
	stage = "trusted-reconnect-dialog";
	const reconnect = owner.request({ type: "reconnect-workspace-project", projectId: projects[0].id }, true);
	const reconnectDialog = await owner.take(message => message.type === "native-dialog-request" && message.operation === "select-workspace-folder");
	owner.child.stdin.write(`${JSON.stringify({ type: "native-dialog-response", requestId: reconnectDialog.requestId, response: { ok: true, selectedWorkspacePath: selectedFolder } })}\n`);
	stage = "trusted-reconnect-response";
	const connected = await reconnect.promise;
	assert.equal(connected.ok, true);
	stage = "trusted-reconnect-metadata";
	const saved = connected.projects.find(value => value.id === projects[0].id);
	assert.equal(saved.path, selectedFolder); assert.equal(saved.name, projects[0].name); assert.equal(saved.instructions, instructions);
	assert.equal(saved.createdAt, timestamp); assert.equal(saved.updatedAt, timestamp);
	assert.deepEqual(connected.pendingWorkspaceProjects.map(value => value.id), [projects[1].id]);
	assert(!JSON.stringify(connected).includes(importedHint));
	stage = "trusted-reconnect-owned-files";
	const coreEntries = await readdir(coreRoot);
	assert(coreEntries.includes("database") && coreEntries.includes("pending-project-handoff.json") && coreEntries.includes("workspace-grants.json"));
	stage = "trusted-reconnect-session-identity";
	const connectedSession = (await owner.request({ type: "runtime-list-sessions" }).promise).sessions.find(value => value.id === "generated-session-connected");
	assert.equal(connectedSession.projectId, projects[0].id); assert.equal(connectedSession.workspaceRoot, selectedFolder);
	stage = "trusted-reconnect-read-selected-folder";
	const read = await owner.request({ type: "runtime-call-tool", sessionId: "generated-session-connected", toolName: "workspace.read", input: { path: "README.md" } }).promise;
	assert.equal(read.ok, true); assert.equal(read.execution.output.content, "Trusted simulated folder choice.\n");
	stage = "trusted-reconnect-deny-old-folder";
	const forbiddenOldPath = await owner.request({ type: "runtime-call-tool", sessionId: "generated-session-connected", toolName: "workspace.read", input: { path: join(importedHint, "README.md") } }).promise;
	assert.equal(forbiddenOldPath.ok, true);
	assert(["blocked", "failed"].includes(forbiddenOldPath.execution?.status));
	assert.equal(forbiddenOldPath.execution?.output?.content, undefined);
	stage = stageNames[5];
	await owner.stop(); owner = undefined;
	assert((await readFile(sourceDatabase)).equals(sourceBytes));
	assert((await readFile(join(sourceRoot, "workspace-grants.json"))).equals(registryBytes));
	mark("trusted-folder-reconnect-preserves-project-identity-metadata-and-time");

	stage = stageNames[6];
	owner = createOwner(); await owner.take(message => message.type === "ready", 60_000);
	const restarted = await owner.request({ type: "get-workspace-grants" }, true).promise;
	assert.equal(restarted.ok, true);
	assert.deepEqual(restarted.pendingWorkspaceProjects.map(value => value.id), [projects[1].id]);
	assert.deepEqual(restarted.projects.map(value => ({ id: value.id, path: value.path, instructions: value.instructions, createdAt: value.createdAt, updatedAt: value.updatedAt })),
		[{ id: projects[0].id, path: selectedFolder, instructions, createdAt: timestamp, updatedAt: timestamp }]);
	assert(!JSON.stringify(restarted).includes(importedHint));
	const restartSessions = (await owner.request({ type: "runtime-list-sessions" }).promise).sessions;
	assert.equal(restartSessions.find(value => value.id === "generated-session-connected")?.projectId, projects[0].id);
	assert.equal(restartSessions.find(value => value.id === "generated-session-removed")?.workspaceRoot, undefined);
	mark("Core-restart-retains-reconnected-and-pending-identities");

	stage = stageNames[7];
	const removed = await owner.request({ type: "remove-pending-workspace-project", projectId: projects[1].id }, true).promise;
	assert.equal(removed.ok, true); assert.deepEqual(removed.pendingWorkspaceProjects, []);
	assert(!removed.projects.some(value => value.id === projects[1].id));
	stage = "remove-pending-restart";
	await owner.stop(); owner = undefined;
	owner = createOwner(); await owner.take(message => message.type === "ready", 60_000);
	stage = "remove-pending-listed-after-restart";
	const afterRemove = await owner.request({ type: "get-workspace-grants" }, true).promise;
	assert.deepEqual(afterRemove.pendingWorkspaceProjects, []);
	assert.deepEqual(afterRemove.projects.map(value => value.id), [projects[0].id]);
	assert(!JSON.stringify(afterRemove).includes(projects[1].id));
	stage = "remove-pending-sessions-after-restart";
	const afterRemoveSessions = (await owner.request({ type: "runtime-list-sessions" }).promise).sessions;
	assert.equal(afterRemoveSessions.find(value => value.id === "generated-session-removed")?.projectId, undefined);
	await owner.stop(); owner = undefined;
	stage = "remove-pending-persisted-handoff-state";
	const { NativeProjectHandoffFile } = await tsImport("../apps/desktop/src/main/native-project-handoff-file.ts", import.meta.url);
	const { parseNativeProjectHandoffState } = await tsImport("../apps/desktop/src/main/native-project-handoff-state.ts", import.meta.url);
	const handoffFile = new NativeProjectHandoffFile({ root: coreRoot, key: destinationKey });
	try {
		const state = parseNativeProjectHandoffState((await handoffFile.read(handoffId)).value, handoffId);
		finalHandoffState = state;
		assert.deepEqual(state.pendingProjectIds, []);
		assert.deepEqual(state.settledProjectIds, [{ id: projects[0].id, disposition: "connected" }, { id: projects[1].id, disposition: "removed" }]);
	} finally { handoffFile.close(); }
	stage = "remove-pending-project-entity-tombstone";
	safeInspect(database => {
		assert.equal(database.getMemoryEntity("generated-memory-connected")?.canonicalName, projects[0].name);
		assert.equal(database.getMemoryEntity("generated-memory-removed"), undefined);
		assert.equal(database.db.prepare("SELECT status FROM memory_entities WHERE id = ?").get("generated-memory-removed")?.status, "deleted");
	});
	mark("remove-pending-project-does-not-resurrect-after-restart");

	stage = "startup-refusal-wrong-expected-id";
	await expectStartupRefusal({ profile: profileRoot, browser: browserRoot, handoffId: randomUUID(), databasePath: destinationDatabase });
	stage = "startup-refusal-unexpected-manifest-without-id";
	await expectStartupRefusal({ profile: profileRoot, browser: browserRoot, useHandoff: false, databasePath: destinationDatabase });
	stage = "startup-refusal-corrupt-encrypted-manifest";
	const manifestPath = join(coreRoot, "pending-project-handoff.json");
	const originalManifestBytes = await readFile(manifestPath), corruptedManifestBytes = Buffer.from(originalManifestBytes);
	corruptedManifestBytes[Math.floor(corruptedManifestBytes.length / 2)] ^= 1;
	try {
		await writeFile(manifestPath, corruptedManifestBytes, { mode: 0o600 });
		await expectStartupRefusal({ profile: profileRoot, browser: browserRoot, handoffId, databasePath: destinationDatabase });
	} finally { await writeFile(manifestPath, originalManifestBytes, { mode: 0o600 }); }
	assert.deepEqual(await readFile(manifestPath), originalManifestBytes);
	stage = "startup-refusal-missing-expected-manifest";
	const missingProfile = join(fixture, "missing-manifest-profile"), missingCore = join(missingProfile, "native-core"), missingBrowser = join(fixture, "missing-manifest-browser");
	for (const directory of [missingProfile, missingCore, join(missingCore, "database"), missingBrowser]) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
	const missingDatabase = join(missingCore, "database/kestrel.sqlite");
	await copyFile(destinationDatabase, missingDatabase); await chmod(missingDatabase, 0o600);
	await expectStartupRefusal({ profile: missingProfile, browser: missingBrowser, handoffId: randomUUID(), databasePath: missingDatabase });
	stage = "startup-refusal-prepared-handoff-state";
	const preparedProfile = join(fixture, "prepared-manifest-profile"), preparedCore = join(preparedProfile, "native-core"), preparedBrowser = join(fixture, "prepared-manifest-browser");
	for (const directory of [preparedProfile, preparedCore, join(preparedCore, "database"), preparedBrowser]) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
	const preparedDatabase = join(preparedCore, "database/kestrel.sqlite");
	await copyFile(destinationDatabase, preparedDatabase); await chmod(preparedDatabase, 0o600);
	const preparedId = randomUUID();
	const { receipt: _receipt, connection: _connection, ...handoffFields } = finalHandoffState;
	const preparedValue = { ...handoffFields, handoffId: preparedId, state: "prepared", revision: 0, pendingProjectIds: [...handoffFields.reviewedProjectIds], settledProjectIds: [],
		corePlan: { ...handoffFields.corePlan, destination: { ...handoffFields.corePlan.destination, path: preparedDatabase } } };
	parseNativeProjectHandoffState(preparedValue, preparedId);
	const { NativeProjectHandoffFile: PreparedHandoffFile } = await tsImport("../apps/desktop/src/main/native-project-handoff-file.ts", import.meta.url);
	const preparedFile = new PreparedHandoffFile({ root: preparedCore, key: destinationKey });
	try { await preparedFile.create(preparedId, preparedValue); } finally { preparedFile.close(); }
	await expectStartupRefusal({ profile: preparedProfile, browser: preparedBrowser, handoffId: preparedId, databasePath: preparedDatabase });
	mark("startup-refusals-wrong-id-no-id-corrupt-missing-and-prepared-preserve-database");

	assert.equal(await candidateDigest(candidate), receipt.candidateSha256);
	receipt.result = "passed";
} catch {
	receipt.result = "failed";
	receipt.failedStage = stage;
	process.exitCode = 1;
	console.error(`Native project-handoff canary failed at ${stage}.`);
} finally {
	if (owner) {
		try { await owner.stop(); }
		catch { receipt.ownerShutdownFailed = true; receipt.result = "failed"; process.exitCode = 1; }
	}
	if (transfer) {
		try { await transfer.stop(); }
		catch { receipt.transferShutdownFailed = true; receipt.result = "failed"; process.exitCode = 1; }
	}
	receipt.candidateSha256After = await candidateDigest(candidate).catch(() => "unavailable");
	receipt.ownedProcessesRemaining = ownedChildren.size;
	if (ownedChildren.size) {
		const exits = [...ownedChildren].map(child => new Promise(resolveExit => {
			if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
			child.once("exit", resolveExit); child.kill("SIGTERM");
		}));
		await within(Promise.all(exits), 5_000, "An owned canary process did not exit after SIGTERM.").catch(async () => {
			for (const child of ownedChildren) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		});
		receipt.ownedProcessesRemaining = ownedChildren.size;
	}
	if (receipt.ownedProcessesRemaining) { receipt.result = "failed"; process.exitCode = 1; }
	if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; process.exitCode = 1; }
	receipt.finishedAt = new Date().toISOString();
	sourceKey.fill(0); destinationKey.fill(0); secondDestinationKey.fill(0);
	await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
	if (receipt.result === "passed" && !owner && !transfer && !ownedChildren.size) {
		await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
	} else {
		receipt.generatedFixturePath = fixture;
		await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
	}
}
