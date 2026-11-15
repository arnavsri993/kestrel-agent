// Actual native app, production vault, guarded managed runtime/model setup,
// real local Core inference and same-profile restart. No screen interaction.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { validateVaultCanaryCandidate } from "./native-vault-canary-candidate.mjs";
import { chromiumSigningCloneNamespace } from "./native-code-sign-clone.mjs";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { selectNativeBrowserFixtureStorage, prepareNativeBrowserFixtureProfile, nativeBrowserFixtureStorageArgs,
	nativeBrowserFixtureStorageEnv, captureNativeBrowserFixtureStorage, assertNativeBrowserFixtureStopped } from "./native-browser-fixture-storage.mjs";

assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.argv.length, 2);
assert.equal(process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT, "1", "Explicit production-vault fixture opt-in required.");
assert.equal(process.env.KESTREL_TEST_REAL_MANAGED_RUNTIME, "1", "Explicit opt-in required for the pinned runtime and small model download.");
assert(process.env.KESTREL_NATIVE_TEST_APP && process.env.KESTREL_NATIVE_MANAGED_CORE_EVIDENCE);
const root = process.cwd(), supplied = resolve(process.env.KESTREL_NATIVE_TEST_APP);
const { candidate, executable } = await validateVaultCanaryCandidate(supplied, { root });
const cloneNamespace = await chromiumSigningCloneNamespace(candidate);
assert(!candidate.startsWith("/Applications/"));
const evidence = resolve(process.env.KESTREL_NATIVE_MANAGED_CORE_EVIDENCE);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal(await realpath(evidence), evidence); assert.deepEqual(await readdir(evidence), []);
const disk = await statfs(tmpdir()); assert(disk.bavail * disk.bsize >= 3 * 1024 ** 3, "At least 3 GiB free required.");
const model = "qwen3:0.6b";
const expectedRuntime = { version: "0.32.1", sha256: "346d28fe70f3ef3776e42100f5721510aa35fc07f3733f6629dbb117b1cfede9", bytes: 145355166 };
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-chromium-desktop-canary-"))); await chmod(profile, 0o700);
const storage = await selectNativeBrowserFixtureStorage({ candidate, root }); assert.equal(storage.mode, "production-vault");
await prepareNativeBrowserFixtureProfile({ profile, storage });
const receipt = { kind: "native-managed-core-canary", version: 1, result: "failed", startedAt: new Date().toISOString(), candidate,
	candidateSha256: await candidateDigest(candidate), model, runtime: expectedRuntime, phases: [], launches: [], stops: [], progress: [],
	scope: "Generated production-vault native app profile; actual shipped host/Core local setup, pinned official runtime/model download, local inference, restart and owned-process cleanup. No renderer clicks, native-dialog/visible acceptance, external provider, real profile, canonical install or complete retirement-gate claim. Default loopback-port preflight/monitoring cannot atomically exclude a concurrent external listener." };
let current, browser, home, monitor, interrupted, monitorError, output = "", savedSession, replySha256;
const observedProcesses = new Map();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function processes() {
	return execFileSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 ** 2 }).split(/\r?\n/).flatMap(row => {
		const value = row.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
		return value ? [{ pid: +value[1], ppid: +value[2], started: value[3], command: value[4] }] : [];
	});
}
function listenerPids() {
	try { return [...new Set(execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP:11434", "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/).filter(Boolean).map(Number))]; }
	catch (error) { if (error.status === 1) return []; throw error; }
}
assert.deepEqual(listenerPids(), [], "No test started: preserve the existing default-port local service.");
function check() { if (interrupted || monitorError) throw monitorError ?? new Error("Managed Core canary interrupted."); }
async function eventually(fn, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { check(); const result = await fn(); if (result) return result; await delay(150); }
	throw new Error("The generated native managed-Core phase timed out.");
}
async function bounded(promise, timeout) {
	let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The generated native request timed out.")), timeout); })]); }
	finally { clearTimeout(timer); }
}
async function localMetadata(path) {
	observe();
	const response = await fetch(`http://127.0.0.1:11434${path}`, { redirect: "error", signal: AbortSignal.timeout(5000) });
	assert(response.ok && response.body);
	const reader = response.body.getReader(), chunks = []; let length = 0;
	try {
		for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; assert(length <= 1024 * 1024, "Local metadata exceeded its bound."); chunks.push(value); }
	} catch (error) { await reader.cancel().catch(() => {}); throw error; }
	finally { reader.releaseLock(); }
	observe(); return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function observe() {
	if (!current) return;
	const rows = processes(), owned = new Set([current.child.pid]); let changed = true;
	while (changed) { changed = false; for (const row of rows) if (!owned.has(row.pid) && owned.has(row.ppid)) { owned.add(row.pid); changed = true; } }
	for (const row of rows) if (owned.has(row.pid)) observedProcesses.set(`${row.pid}:${row.started}`, row);
	for (const pid of listenerPids()) {
		const row = rows.find(item => item.pid === pid);
		assert(row && owned.has(pid) && row.command.startsWith(join(profile, "native-core/local-runtime/ollama/0.32.1/ollama") + " serve"), "An unexpected local-service owner appeared; cancelling this fixture.");
	}
}
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function request(value, timeout = 45000) {
	check(); const response = await bounded(home.evaluate(value => window.kestrel.request(value), value), timeout);
	assert.equal(response?.ok, true, `Native generated request failed: ${value.type}`); return response;
}
async function start() {
	check(); assertNativeBrowserFixtureStopped(storage); assert.deepEqual(listenerPids(), []);
	// A just-exited Chromium cleanup helper may remove its own clone between
	// inventory and lstat. Retry the full strict preflight only for that ENOENT.
	let checked;
	const deadline = Date.now() + 10000;
	for (;;) {
		try { checked = await validateVaultCanaryCandidate(candidate, { root }); break; }
		catch (error) {
			if (error.code !== "ENOENT" || typeof error.path !== "string" || !error.path.startsWith(`${cloneNamespace}/code_sign_clone.`) || Date.now() >= deadline) throw error;
			await delay(200);
		}
	}
	assert.equal(await candidateDigest(candidate), receipt.candidateSha256);
	output = "";
	const env = nativeBrowserFixtureStorageEnv(storage);
	// All provider CLI paths stay disabled. Explicit local setup is handled by
	// the shipped host, and its service HOME/model store stay inside the fixture.
	const child = spawn(checked.executable, ["--kestrel-chromium-desktop", "--kestrel-cache-path", profile, "--kestrel-durable-profile", "--enable-automation", "--remote-debugging-port=0", ...nativeBrowserFixtureStorageArgs(storage)], { env, stdio: ["ignore", "pipe", "pipe"] });
	current = { child, exit: new Promise(done => child.once("close", (code, signal) => done({ code, signal }))) };
	receipt.launches.push({ pid: child.pid });
	for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-128 * 1024); });
	const endpoint = await eventually(() => {
		assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert(!output.includes("selected=mock"));
		return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
	}, 60000);
	browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
	await eventually(async () => {
		home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
		if (home) return true;
		await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); return false;
	});
	await home.waitForFunction(() => typeof window.kestrel?.request === "function");
	await home.evaluate(() => { window.kestrel.onLocalRuntimeProgress(event => {
		window.__generatedManagedProgress ??= [];
		const item = { stage: event.stage, ...(event.percent === undefined ? {} : { percent: Math.floor(event.percent) }) };
		if (window.__generatedManagedProgress.length < 2000 && JSON.stringify(window.__generatedManagedProgress.at(-1)) !== JSON.stringify(item)) window.__generatedManagedProgress.push(item);
	}); });
	const status = await request({ type: "subscription-cli-status" }); assert(status.subscriptionClis.every(item => !item.detected && !item.enabled));
	observe(); monitor = setInterval(() => { try { observe(); } catch (error) { monitorError = error; void home.evaluate(() => window.kestrel.request({ type: "local-runtime-cancel" })).catch(() => {}); } }, 1000);
}
async function stop() {
	clearInterval(monitor); monitor = undefined;
	if (!current) return;
	observe(); const owned = current;
	await browser?.close().catch(() => {}); browser = undefined;
	if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGTERM");
	let outcome = await bounded(owned.exit, 20000).catch(() => null), forced = false;
	if (!outcome) { forced = true; owned.child.kill("SIGKILL"); outcome = await bounded(owned.exit, 5000).catch(() => null); }
	assert(outcome, "Owned native app termination is unconfirmed; fixture preserved."); current = undefined;
	receipt.stops.push({ ...outcome, forced }); assert.deepEqual({ ...outcome, forced }, { code: 0, signal: null, forced: false });
	const deadline = Date.now() + 10000;
	for (;;) {
		const rows = processes();
		const remaining = [...observedProcesses.values()].filter(item => rows.some(row => row.pid === item.pid && row.started === item.started && row.command === item.command));
		if (!remaining.length) break;
		assert(Date.now() < deadline, "An observed owned native/local runner process survived shutdown."); await delay(100);
	}
	// Chromium's signing-clone cleanup helper may begin after our final child
	// snapshot. Require complete bundle absence rather than a single snapshot.
	const bundleDeadline = Date.now() + 10000;
	for (;;) {
		try { assertNativeBrowserFixtureStopped(storage); break; }
		catch (error) { if (!/selected candidate process is still running/.test(error.message) || Date.now() >= bundleDeadline) throw error; await delay(100); }
	}
	assert.deepEqual(listenerPids(), []);
}
const signalHandler = signal => { interrupted = signal; if (current?.child.exitCode === null) current.child.kill("SIGTERM"); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => signalHandler(signal));
try {
	const response = await fetch("https://registry.ollama.ai/v2/library/qwen3/manifests/0.6b", { redirect: "error", signal: AbortSignal.timeout(10000) });
	assert(response.ok); const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length <= 256 * 1024);
	const manifest = JSON.parse(bytes); assert.equal(manifest.schemaVersion, 2);
	const descriptors = [manifest.config, ...manifest.layers];
	for (const item of descriptors) assert(Number.isSafeInteger(item.size) && item.size > 0 && /^sha256:[a-f0-9]{64}$/.test(item.digest));
	const advertisedBytes = descriptors.reduce((sum, item) => sum + item.size, 0); assert(advertisedBytes <= 600 * 1024 ** 2);
	receipt.modelManifest = { sha256: hash(bytes), advertisedBytes };
	await start(); phase("fresh-production-vault-native-app-and-no-existing-default-service");
	const setup = await request({ type: "local-runtime-bootstrap", model, consent: true }, 25 * 60 * 1000);
	assert.equal(setup.localRuntime?.verifiedModel, model); assert(setup.localRuntime.verifiedAt);
	receipt.progress = await home.evaluate(() => window.__generatedManagedProgress ?? []);
	for (const stage of ["installing-runtime", "starting-runtime", "downloading-model", "verifying-model", "ready"]) assert(receipt.progress.some(item => item.stage === stage), `Missing actual setup phase: ${stage}`);
	const marker = JSON.parse(await readFile(join(profile, "native-core/local-runtime/ollama/0.32.1/workstrand-install.json"), "utf8"));
	assert.equal(marker.version, expectedRuntime.version); assert.equal(marker.sha256, expectedRuntime.sha256); assert.equal(marker.bytes, expectedRuntime.bytes);
	const version = await localMetadata("/api/version"), tags = await localMetadata("/api/tags");
	assert.equal(version.version, expectedRuntime.version);
	const installed = tags.models?.find(item => item.name === model); assert(installed && installed.digest === receipt.modelManifest.sha256);
	receipt.runtimeApiVersion = version.version; receipt.installedModelDigest = installed.digest;
	phase("native-host-download-verification-and-guarded-Core-route-commit");
	const selected = (await request({ type: "runtime-create-session", title: "Generated production local inference", kind: "conversation" })).session;
	assert(selected?.id); savedSession = selected.id;
	const tools = (await request({ type: "runtime-discover-tools", sessionId: savedSession })).tools; assert(Array.isArray(tools));
	for (const tool of tools) await request({ type: "runtime-set-approval-rule", toolName: tool.name, decision: "deny", scope: "session", sessionId: savedSession });
	const prompt = `Reply only with LOCAL_NATIVE_${randomUUID().replaceAll("-", "")}. Do not call tools.`;
	const result = await request({ type: "runtime-run-agent", sessionId: savedSession, message: prompt, model,
		providerIds: ["ollama"], providerModels: { ollama: model }, maximumTurns: 1, reasoningEffort: "none", streamId: "native-managed-core-canary" }, 180000);
	assert.equal(result.run?.status, "completed");
	const messages = (await request({ type: "runtime-list-messages", sessionId: savedSession })).messages;
	const reply = messages?.findLast(item => item.role === "assistant" && typeof item.content === "string" && item.content.trim()); assert(reply);
	assert(!messages.some(item => item.role === "tool" || item.toolCalls?.length));
	const executions = await request({ type: "runtime-list-executions", sessionId: savedSession }); assert.deepEqual(executions.executions, []);
	replySha256 = hash(Buffer.from(reply.content)); receipt.replySha256 = replySha256; receipt.replyChars = reply.content.length;
	observe(); assert([...observedProcesses.values()].some(item => /(?:^|[\s/])llama-server(?:\s|$)/.test(item.command)), "Actual managed model runner not observed.");
	phase("real-native-Core-local-response-with-no-tools-and-live-owned-runner");
	await stop(); receipt.firstStorage = await captureNativeBrowserFixtureStorage({ profile, storage });
	const database = await readFile(join(profile, "native-core/database/kestrel.sqlite")); assert(!database.includes(Buffer.from(reply.content)) && !database.includes(Buffer.from(prompt)));
	phase("clean-native-stop-reaps-server-runner-and-encrypted-response-on-disk");
	await start();
	const status = await request({ type: "local-model-status" }); assert.equal(status.localRuntime?.verifiedModel, model); assert.equal(status.localRuntime?.source, "managed"); assert(status.ollamaAvailable);
	assert.equal((await localMetadata("/api/version")).version, expectedRuntime.version);
	assert.equal((await localMetadata("/api/tags")).models?.find(item => item.name === model)?.digest, receipt.installedModelDigest);
	const persisted = (await request({ type: "runtime-list-messages", sessionId: savedSession })).messages;
	assert(persisted.some(item => item.role === "assistant" && hash(Buffer.from(item.content)) === replySha256));
	phase("same-profile-native-restart-restores-managed-route-and-decrypts-real-response");
	await stop(); receipt.finalStorage = await captureNativeBrowserFixtureStorage({ profile, storage });
	assert.equal(receipt.firstStorage.vaultSha256, receipt.finalStorage.vaultSha256);
	receipt.candidateSha256After = await candidateDigest(candidate); assert.equal(receipt.candidateSha256After, receipt.candidateSha256);
	check(); phase("second-clean-stop-and-unchanged-vault-candidate-and-default-port"); receipt.result = "passed";
} catch (error) {
	receipt.error = { name: error.name, message: error.message };
	process.exitCode = 1; console.error(`Managed native Core canary failed: ${error.message}`);
} finally {
	try { await stop(); } catch (error) { receipt.result = "failed"; receipt.cleanupError = error.message; process.exitCode = 1; }
	clearInterval(monitor);
	receipt.observedProcesses = [...observedProcesses.values()];
	if (receipt.result === "passed") {
		try { await rm(profile, { recursive: true }); receipt.profileCleanup = "generated profile and downloaded runtime/model removed"; }
		catch { receipt.result = "failed"; receipt.profileCleanup = "generated profile cleanup failed"; receipt.profile = profile; process.exitCode = 1; }
	} else { receipt.profileCleanup = "failed generated profile retained"; receipt.profile = profile; }
	receipt.completedAt = new Date().toISOString(); await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
	console.log(`Managed native Core ${receipt.result}; receipt: ${join(evidence, "receipt.json")}`);
}
