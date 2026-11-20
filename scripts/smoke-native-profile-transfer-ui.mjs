import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { markDisposableNativeTestProfile } from "./native-test-profile.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Set the exact disposable native candidate.");
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert.notEqual(app, await realpath("/Applications/Kestrel.app").catch(() => "/Applications/Kestrel.app"));
const executable = join(app, "Contents/MacOS/Kestrel");
const retryRequested = process.env.KESTREL_TEST_NATIVE_TRANSFER_RETRY === "1";
const evidence = resolve(process.env.KESTREL_NATIVE_PROFILE_UI_EVIDENCE || `.tmp/native-profile-transfer-ui-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 }); assert.equal((await readdir(evidence)).length, 0);
const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-profile-transfer-ui-")));
const profile = join(temporary, "browser"), source = join(temporary, "source");
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
await mkdir(source, { mode: 0o700 }); await mkdir(join(source, "secure"), { mode: 0o700 }); await mkdir(join(source, "database"), { mode: 0o700 });
await writeFile(join(source, ".kestrel-native-transfer-source-test-v1"), "kestrel-transfer-source-test-v1\n", { mode: 0o600 });
const sourceKey = randomBytes(32);
const sourceKeyPath = join(source, "secure/database-key.bin"), sourceDatabase = join(source, "database/kestrel.sqlite");
await writeFile(sourceKeyPath, Buffer.from("kestrel-plaintext-v1\n" + sourceKey.toString("base64")), { mode: 0o600 });
const runTag = randomUUID().slice(0, 8);
const projectId = `custom-${randomUUID()}`;
const projectName = `Owned ${runTag} project to reconnect`;
const projectInstructions = `Generated ${runTag} project instructions; preserve this line exactly.\nSecond generated line.`;
const projectCreatedAt = "2026-11-06T14:00:00.000Z", projectUpdatedAt = "2026-11-06T14:15:00.000Z";
const oldProjectFolder = join(temporary, "old-imported-project-folder"), chosenProjectFolder = join(temporary, "trusted-chosen-project-folder");
for (const directory of [oldProjectFolder, chosenProjectFolder]) await mkdir(directory, { mode: 0o700 });
await writeFile(join(oldProjectFolder, "README.md"), `Generated old imported folder ${runTag}.\n`, { mode: 0o600 });
await writeFile(join(chosenProjectFolder, "README.md"), `Generated chosen project folder ${runTag}.\n`, { mode: 0o600 });
const sourceProject = { id: projectId, path: oldProjectFolder, name: projectName, instructions: projectInstructions,
	createdAt: projectCreatedAt, updatedAt: projectUpdatedAt, order: 0 };
const sourceRegistryPath = join(source, "workspace-grants.json");
await writeFile(sourceRegistryPath, JSON.stringify([sourceProject]), { mode: 0o600 });
await chmod(sourceRegistryPath, 0o600);
const { KestrelDatabase } = await tsImport("../packages/database/src/index.ts", import.meta.url);
const { decryptText } = await tsImport("../packages/encryption/src/index.ts", import.meta.url);
const Sqlite = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const sourceSessionId = randomUUID(), sourceTitle = `Owned ${runTag} imported project conversation`, sourceText = `Generated ${runTag} conversation restored through the native transfer interface.`;
const at = new Date().toISOString();
const seeded = new KestrelDatabase(sourceDatabase, sourceKey);
seeded.saveRuntimeSession({ id: sourceSessionId, title: sourceTitle, kind: "conversation", projectId, workspaceRoot: oldProjectFolder,
	allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
seeded.saveRuntimeMessage({ id: randomUUID(), sessionId: sourceSessionId, role: "user", content: sourceText, createdAt: at });
seeded.setPrivateState("orchestrator.scheduled-jobs", [{ id: "generated-inherited-job", title: "Generated inherited schedule", sessionId: sourceSessionId, model: "fixture", providerIds: ["fixture"], schedule: { kind: "once", nextRunAt: at }, status: "pending", prompt: "Do not automatically run this generated job", createdAt: at, updatedAt: at }]);
seeded.close();
const sourceBefore = await readFile(sourceDatabase), keyBefore = await readFile(sourceKeyPath), sourceRegistryBefore = await readFile(sourceRegistryPath);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), retryRequested,
	scope: "Generated disposable browser/source profiles and test keys only. No real Keychain, user profile, credentials or whole-desktop control.", phases: [] };
let running, browser, currentOperation = "native-app-start";
let interruptedPreparation;
const fixtureClients = [], fixtureKeys = [];
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; });
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function eventually(fn, message, milliseconds = 30000, intervalMs = 100) {
	const end = Date.now() + milliseconds; let last;
	while (Date.now() < end) { if (interrupted) throw new Error("Disposable native UI canary interrupted."); try { last = await fn(); if (last) return last; } catch { } await delay(intervalMs); }
	throw new Error(message);
}
async function start() {
	const state = { output: "" };
	state.child = spawn(executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--kestrel-test-profile-key", "--remote-debugging-port=0"], { stdio: ["ignore", "pipe", "pipe"] });
	state.exited = new Promise(resolveExit => state.child.once("exit", (code, signal) => resolveExit({ code, signal })));
	state.child.stdout.on("data", bytes => { state.output += bytes; }); state.child.stderr.on("data", bytes => { state.output += bytes; });
	running = state;
	const endpoint = await eventually(() => {
		assert.equal(state.child.exitCode, null, "Owned native candidate exited during startup.");
		return state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
	}, "Owned native endpoint missing.");
	state.endpoint = endpoint;
	browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
	let home;
	await eventually(async () => {
		home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
		if (home) return true;
		const session = await browser.newBrowserCDPSession(); const targets = await session.send("Target.getTargets"); await session.detach();
		if (targets.targetInfos.some(target => /chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
		return false;
	}, "Native Home did not open.");
	await home.waitForFunction(() => typeof window.kestrel?.request === "function");
	await home.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
	await home.reload(); await home.locator(".kestrel-sidebar").waitFor();
	const expand = home.getByRole("button", { name: "Expand sidebar", exact: true });
	if (await expand.isVisible()) await expand.click();
	return { state, home };
}
function exactSettingsDocumentUrl(value, extensionHost) {
	try {
		const url = new URL(value);
		return url.protocol === "chrome-extension:" && url.host === extensionHost && url.pathname === "/index.html" && url.searchParams.get("app") === "settings";
	} catch { return false; }
}
async function ownedSettingsDocument(home, state) {
	const extensionHost = new URL(home.url()).host;
	return eventually(async () => {
		let page = browser.contexts().flatMap(context => context.pages()).find(candidate => exactSettingsDocumentUrl(candidate.url(), extensionHost));
		if (page) return page;
		const session = await browser.newBrowserCDPSession();
		let targets;
		try { targets = await session.send("Target.getTargets"); } finally { await session.detach(); }
		if (targets.targetInfos.some(target => exactSettingsDocumentUrl(target.url, extensionHost))) {
			await browser.close();
			browser = await chromium.connectOverCDP(state.endpoint, { noDefaults: true });
			page = browser.contexts().flatMap(context => context.pages()).find(candidate => exactSettingsDocumentUrl(candidate.url(), extensionHost));
			if (page) return page;
		}
		return false;
	}, "Owned candidate Settings document was not attached after the operator's native navigation.", 15_000);
}
async function stop() {
	if (!running) return;
	const current = running; running = undefined;
	if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGTERM");
	assert.deepEqual(await Promise.race([current.exited, delay(15000, undefined, { ref: false }).then(() => { current.child.kill("SIGKILL"); throw Error("Owned native shutdown timed out."); })]), { code: 0, signal: null });
	await browser?.close().catch(() => {}); browser = undefined;
}
async function live(stage, state, metadata = {}) {
	await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage, currentOperation, candidate: app, pid: state.child.pid, source, browserProfile: profile, ...metadata }, null, 2), { mode: 0o600 });
	console.log(stage);
}
async function databaseDirectoryDigest(root) {
	const records = [];
	async function visit(path, relative) {
		const info = await lstat(path); assert(info.uid === process.getuid() && !info.isSymbolicLink());
		const row = { path: relative, mode: info.mode & 0o777, device: info.dev, inode: info.ino, links: info.nlink };
		if (info.isDirectory()) { records.push({ ...row, type: "directory" }); for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative + "/" + name); }
		else { assert(info.isFile()); const digest = createHash("sha256"); for await (const bytes of createReadStream(path)) digest.update(bytes); records.push({ ...row, type: "file", size: info.size, sha256: digest.digest("hex") }); }
	}
	await visit(root, "database"); return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}
try {
	const first = await start();
	const originalTitle = `Owned ${runTag} pre-transfer conversation`;
	const created = await first.home.evaluate(title => window.kestrel.request({ type: "runtime-create-session", title, kind: "conversation" }), originalTitle);
	assert.equal(created.ok, true); const originalId = created.session.id;
	phase("existing-native-conversation-created-before-transfer");
	await live("NATIVE_PROFILE_TRANSFER_UI_READY", first.state, { runTag, originalTitle, sourceTitle, project: { id: projectId, name: projectName } });
	currentOperation = "exercise source folder metadata after native review";
	await eventually(() => first.state.output.includes("KESTREL_NATIVE_CORE_TRANSFER_REVIEW_READY"), "The native reviewed plan was not opened.", 10 * 60_000);
	const reviewedRoot = await lstat(source, { bigint: true });
	try { await chmod(source, 0o500); } finally { await chmod(source, 0o700); }
	const updatedRoot = await lstat(source, { bigint: true });
	for (const field of ["dev", "ino", "mode", "uid", "size", "mtimeNs"]) assert.equal(updatedRoot[field], reviewedRoot[field]);
	assert.notEqual(updatedRoot.ctimeNs, reviewedRoot.ctimeNs);
	assert((await readFile(sourceDatabase)).equals(sourceBefore));
	assert((await readFile(sourceRegistryPath)).equals(sourceRegistryBefore));
	receipt.sourceRootMetadataExercise = { afterNativeReview: true, ctimeOnly: true, databaseAndRegistryBytesUnchanged: true };
	console.log("NATIVE_PROJECT_CTIME_FIXTURE_READY");
	if (retryRequested) {
		await eventually(() => first.state.output.includes("KESTREL_NATIVE_CORE_TRANSFER_REVIEW_READY"), "The first native review was not opened.", 10 * 60_000);
		const children = (await readdir(join(profile, "native-core-profiles"))).filter(name => /^[a-f0-9-]{36}$/i.test(name)); assert.equal(children.length, 1);
		const root = join(profile, "native-core-profiles", children[0]), database = join(root, "native-core/database/kestrel.sqlite");
		const destinationKey = await readFile(join(root, ".kestrel-native-test-core-key-v1")); assert.equal(destinationKey.length, 32); fixtureKeys.push(destinationKey);
		const { writeCoreTransferCrashPreload, launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
		const preload = join(temporary, "before-link-fixture.mjs"); await writeCoreTransferCrashPreload(preload, database, "before-link");
		const workerOptions = { executable: join(app, "Contents/Resources/agent-core/node/bin/node"), entry: join(app, "Contents/Resources/agent-core/service/host-profile-file-transfer.js"), home: temporary };
		const crashed = launchCoreTransferFixture({ ...workerOptions, preload }); fixtureClients.push(crashed);
		const plan = await crashed.request("plan", { sourceDatabasePath: sourceDatabase, destinationDatabasePath: database, sourceKeyBase64: sourceKey.toString("base64") }); assert.equal(plan.ok, true);
		crashed.send("apply", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: destinationKey.toString("base64") });
		assert.deepEqual(await crashed.exited, { code: null, signal: "SIGKILL" }); assert.equal(crashed.errors(), "");
		for (const key of [sourceKey, destinationKey]) assert(!crashed.output().includes(key.toString("base64")));
		const digest = await databaseDirectoryDigest(join(root, "native-core/database"));
		interruptedPreparation = { root, database, digest, destinationKey, workerOptions };
		phase("actual-bundled-worker-crash-leaves-encrypted-preparation-after-native-review");
		await live("NATIVE_PROFILE_TRANSFER_RETRY_FIXTURE_READY", first.state);
		await eventually(() => first.state.output.includes("KESTREL_NATIVE_CORE_TRANSFER_RETRY_READY"), "The native keep-files/start-again choice was not completed.", 10 * 60_000);
		assert.equal(await databaseDirectoryDigest(join(root, "native-core/database")), digest);
		phase("native-error-keeps-interrupted-files-before-opening-a-fresh-source-picker");
		await live("NATIVE_PROFILE_TRANSFER_RETRY_SOURCE_READY", first.state);
	}
	await eventually(async () => {
		const selection = JSON.parse(await readFile(join(profile, "native-core-profile.json"), "utf8"));
		return /^native-core-profiles\/[a-f0-9-]{36}$/i.test(selection.active) && selection.previous === "" && first.state.output.includes("KESTREL_NATIVE_CORE_TRANSFER_SELECTED");
	}, "The native transfer/review/apply interface was not completed.", 10 * 60_000);
	phase("native-picker-review-explicit-acceptance-and-selection-saved");
	const selected = JSON.parse(await readFile(join(profile, "native-core-profile.json"), "utf8")), importedRoot = join(profile, selected.active);
	if (interruptedPreparation) assert.notEqual(importedRoot, interruptedPreparation.root);
	await stop();
	currentOperation = "imported-profile-real-restart";
	const second = await start();
	currentOperation = "pending-api-identity-and-hint-safety";
	const sessions = await second.home.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(sessions.ok && sessions.sessions.some(session => session.id === sourceSessionId) && !sessions.sessions.some(session => session.id === originalId));
	const pendingState = await second.home.evaluate(() => window.kestrel.request({ type: "get-workspace-grants" }));
	assert.equal(pendingState.ok, true);
	assert.deepEqual(pendingState.workspaceGrants, []);
	assert.deepEqual(pendingState.projects, []);
	assert.deepEqual(pendingState.pendingWorkspaceProjects, [{ id: projectId, name: projectName }]);
	assert(!JSON.stringify(pendingState).includes(oldProjectFolder));
	assert(!JSON.stringify(pendingState).includes(projectInstructions));
	const importedSession = sessions.sessions.find(session => session.id === sourceSessionId);
	assert.equal(importedSession.projectId, projectId);
	assert.equal(importedSession.workspaceRoot, undefined);
	currentOperation = "imported-conversation-visible-after-restart";
	await second.home.locator(".kestrel-sidebar").getByText(sourceTitle, { exact: true }).first().click();
	await second.home.getByText(sourceText, { exact: true }).waitFor();
	await second.home.screenshot({ path: join(evidence, "native-transfer-imported-conversation.png") });
	phase("imported-conversation-visible-after-real-app-restart");
	const laterTitle = `Owned ${runTag} post-transfer conversation`;
	const later = await second.home.evaluate(title => window.kestrel.request({ type: "runtime-create-session", title, kind: "conversation" }), laterTitle); assert.equal(later.ok, true);
	currentOperation = "operator-native-project-reconnection-wait";
	await writeFile(join(evidence, "live-state.json"), JSON.stringify({ stage: "NATIVE_PROJECT_RECONNECT_UI_READY", candidate: app,
		currentOperation, pid: second.state.child.pid, project: { id: projectId, name: projectName, createdAt: projectCreatedAt, updatedAt: projectUpdatedAt },
		selectedFolder: chosenProjectFolder }, null, 2), { mode: 0o600 });
	console.log("NATIVE_PROJECT_RECONNECT_UI_READY");
	console.log(`Owned generated project ${projectName} (${projectId}); choose ${chosenProjectFolder} in the native Cocoa folder panel.`);
	const reconnected = await eventually(async () => {
		const [workspace, currentSessions] = await second.home.evaluate(async () => Promise.all([
			window.kestrel.request({ type: "get-workspace-grants" }),
			window.kestrel.request({ type: "runtime-list-sessions" }),
		]));
		if (!workspace.ok || !currentSessions.ok) return false;
		if (workspace.pendingWorkspaceProjects?.some(project => project.id === projectId)) return false;
		const grant = workspace.projects?.find(project => project.id === projectId);
		const session = currentSessions.sessions?.find(value => value.id === sourceSessionId);
		return grant?.path === chosenProjectFolder && session?.projectId === projectId && session?.workspaceRoot === chosenProjectFolder
			? { workspace, currentSessions } : false;
	}, "The operator did not complete the generated project's native folder reconnection.", 10 * 60_000, 1_000);
	currentOperation = "reconnected-project-metadata-and-session-assertions";
	const connectedProject = reconnected.workspace.projects.find(project => project.id === projectId);
	assert.equal(connectedProject.path, chosenProjectFolder);
	assert.equal(connectedProject.name, projectName);
	assert.equal(connectedProject.instructions, projectInstructions);
	assert.equal(connectedProject.createdAt, projectCreatedAt);
	assert.equal(connectedProject.updatedAt, projectUpdatedAt);
	assert.equal(connectedProject.available, true);
	assert(!JSON.stringify(reconnected.workspace).includes(oldProjectFolder));
	assert(!reconnected.workspace.pendingWorkspaceProjects.some(project => project.id === projectId));
	const reconnectedSession = reconnected.currentSessions.sessions.find(session => session.id === sourceSessionId);
	assert.equal(reconnectedSession.projectId, projectId);
	assert.equal(reconnectedSession.workspaceRoot, chosenProjectFolder);
	currentOperation = "owned-settings-document-lookup-after-native-navigation";
	const settingsDocument = await ownedSettingsDocument(second.home, second.state);
	await settingsDocument.locator("#settings-workspace-title").waitFor({ state: "visible", timeout: 15_000 });
	currentOperation = "reconnected-project-settings-screenshot";
	await settingsDocument.screenshot({ path: join(evidence, "native-transfer-project-reconnected.png") });
	phase("operator-used-settings-and-native-Cocoa-picker-to-reconnect-stable-project-with-metadata");
	currentOperation = "previous-profile-rollback-and-restart";
	await live("NATIVE_PROFILE_ROLLBACK_UI_READY", second.state);
	await eventually(async () => {
		const selection = JSON.parse(await readFile(join(profile, "native-core-profile.json"), "utf8"));
		return selection.active === "" && selection.previous === selected.active && second.state.output.includes("KESTREL_NATIVE_CORE_PREVIOUS_SELECTED");
	}, "Previous data profile selection was not completed.", 10 * 60_000);
	await stop();
	const third = await start();
	const restored = await third.home.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(restored.ok && restored.sessions.some(session => session.id === originalId) && !restored.sessions.some(session => session.id === sourceSessionId));
	await third.home.locator(".kestrel-sidebar").getByText(originalTitle, { exact: true }).first().click();
	await third.home.screenshot({ path: join(evidence, "native-transfer-previous-profile-restored.png") });
	phase("previous-native-profile-visible-after-second-selection-and-restart");
	await stop();
	const imported = new Sqlite(join(importedRoot, "native-core/database/kestrel.sqlite"), { readonly: true, fileMustExist: true });
	let importedKey;
	try {
		assert(imported.prepare("SELECT id FROM runtime_sessions WHERE id = ?").get(later.session.id));
		importedKey = await readFile(join(importedRoot, ".kestrel-native-test-core-key-v1"));
		const row = imported.prepare("SELECT value_ciphertext AS ciphertext,value_iv AS iv,value_auth_tag AS authTag FROM private_runtime_state WHERE key='orchestrator.scheduled-jobs'").get();
		assert.equal(JSON.parse(decryptText(row, importedKey))[0].status, "cancelled");
	} finally { imported.close(); importedKey?.fill(0); }
	assert.deepEqual(await readFile(sourceDatabase), sourceBefore); assert.deepEqual(await readFile(sourceKeyPath), keyBefore);
	assert.deepEqual(await readFile(sourceRegistryPath), sourceRegistryBefore);
	phase("new-native-work-retained-scheduled-authority-cancelled-source-bytes-unchanged");
	if (interruptedPreparation) {
		const kept = interruptedPreparation;
		assert.equal(await databaseDirectoryDigest(join(kept.root, "native-core/database")), kept.digest);
		const sameKey = await readFile(join(kept.root, ".kestrel-native-test-core-key-v1")); try { assert.deepEqual(sameKey, kept.destinationKey); } finally { sameKey.fill(0); }
		const { launchCoreTransferFixture } = await tsImport("./native-core-transfer-crash-fixture.ts", import.meta.url);
		const inspector = launchCoreTransferFixture(kept.workerOptions); fixtureClients.push(inspector);
		const reviewed = await inspector.request("inspect-interrupted", { destinationDatabasePath: kept.database }); assert.equal(reviewed.ok, true); assert.equal(reviewed.preview.state, "staged");
		assert.deepEqual(await inspector.stop(), { code: 0, signal: null }); assert.equal(inspector.errors(), "");
		assert.equal(await databaseDirectoryDigest(join(kept.root, "native-core/database")), kept.digest);
		receipt.preservedPreparationSha256 = kept.digest;
		phase("old-interrupted-stage-and-stable-test-key-remain-reviewable-after-successful-separate-transfer");
	}
	receipt.result = "passed";
} catch (error) { receipt.result = "failed"; receipt.failedStage = currentOperation; receipt.error = interrupted ? "UI_CANARY_INTERRUPTED" : error?.code || "Native profile transfer UI canary failed at its next phase."; process.exitCode = 1; }
finally {
	await stop().catch(() => { receipt.result = "failed"; process.exitCode = 1; });
	for (const client of fixtureClients) { if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGKILL"); await client.exited; }
	for (const key of fixtureKeys) key.fill(0);
	sourceKey.fill(0); sourceBefore.fill(0); keyBefore.fill(0);
	await rm(temporary, { recursive: true, force: true });
	receipt.candidateSha256After = await candidateDigest(app);
	if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = "failed"; receipt.candidateChanged = true; process.exitCode = 1; }
	receipt.finishedAt = new Date().toISOString(); await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
