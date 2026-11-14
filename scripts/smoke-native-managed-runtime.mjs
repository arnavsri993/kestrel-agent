#!/usr/bin/env node
// Exercise LocalRuntimeManager against an actual pinned Ollama release and a
// fresh, private model store. This is not evidence for the bundled Core path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, chmod, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { LocalRuntimeManager, MANAGED_OLLAMA_MANIFEST } from "../apps/desktop/src/main/local-runtime-manager.ts";

const OPT_IN = "KESTREL_TEST_REAL_MANAGED_RUNTIME";
assert.equal(process.env[OPT_IN], "1", `Set ${OPT_IN}=1 to acknowledge a pinned runtime download (~145 MB) and qwen3:0.6b download (~523 MB). Nothing has been launched.`);
assert.equal(process.platform, "darwin", "This managed runtime canary requires macOS. Nothing has been launched.");
assert.equal(process.arch, "arm64", "This pinned managed runtime canary requires Apple Silicon. Nothing has been launched.");
const suppliedCandidate = process.env.KESTREL_NATIVE_TEST_APP?.trim();
assert(suppliedCandidate, "Set KESTREL_NATIVE_TEST_APP to the exact disposable candidate for before/after fingerprinting. Nothing has been launched.");
const candidate = await realpath(resolve(suppliedCandidate));
assert(!candidate.startsWith("/Applications/"), "Use a disposable candidate outside /Applications.");

const EXPECTED_RUNTIME = Object.freeze({
	version: "0.32.1",
	url: "https://github.com/ollama/ollama/releases/download/v0.32.1/ollama-darwin.tgz",
	bytes: 145_355_166,
	sha256: "346d28fe70f3ef3776e42100f5721510aa35fc07f3733f6629dbb117b1cfede9",
	fileName: "ollama-darwin.tgz",
	binaryPath: "ollama",
});
const MODEL = "qwen3:0.6b";
const MODEL_MAX_BYTES = 600 * 1024 * 1024;
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;
const TOTAL_DEADLINE_MS = 20 * 60_000;
const MAX_METADATA_BYTES = 1_000_000;
assert.deepEqual({
	version: MANAGED_OLLAMA_MANIFEST.version,
	url: MANAGED_OLLAMA_MANIFEST.url,
	bytes: MANAGED_OLLAMA_MANIFEST.bytes,
	sha256: MANAGED_OLLAMA_MANIFEST.sha256,
	fileName: MANAGED_OLLAMA_MANIFEST.fileName,
	binaryPath: MANAGED_OLLAMA_MANIFEST.binaryPath,
}, EXPECTED_RUNTIME, "The manager's production pin changed; review this canary before any download.");

function run(command, args, timeout = 5_000) {
	return execFileSync(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function listenerPids(port) {
	try {
		return [...new Set(run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split(/\s+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
	} catch (error) {
		if (error && typeof error === "object" && "status" in error && error.status === 1) return [];
		throw error;
	}
}
async function boundedBytes(response, label, maxBytes = MAX_METADATA_BYTES) {
	assert(response.ok, `${label} returned HTTP ${response.status}.`);
	const advertised = Number(response.headers.get("content-length"));
	assert(!Number.isFinite(advertised) || advertised <= maxBytes, `${label} exceeded its ${maxBytes}-byte metadata bound.`);
	assert(response.body, `${label} returned an empty body.`);
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			assert(length <= maxBytes, `${label} exceeded its ${maxBytes}-byte metadata bound.`);
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks, length);
}
async function boundedJson(response, label, maxBytes = MAX_METADATA_BYTES) {
	const bytes = await boundedBytes(response, label, maxBytes);
	return JSON.parse(bytes.toString("utf8"));
}
async function externalState() {
	const response = await fetch("http://127.0.0.1:11434/api/tags", { redirect: "error", signal: AbortSignal.timeout(3_000) });
	const payload = await boundedJson(response, "The existing external Ollama model listing");
	assert(Array.isArray(payload.models), "The external Ollama model listing is malformed.");
	const models = payload.models.map(item => {
		assert(typeof item?.name === "string" && item.name.length > 0 && typeof item.digest === "string" && /^[a-f0-9]{64}$/i.test(item.digest), "The external Ollama listing omitted a stable name or digest.");
		return { name: item.name, digest: item.digest.toLowerCase() };
	}).sort((a, b) => a.name.localeCompare(b.name) || a.digest.localeCompare(b.digest));
	assert.equal(new Set(models.map(item => item.name)).size, models.length, "The external Ollama listing contains duplicate model names.");
	const pids = listenerPids(11434);
	assert(pids.length > 0 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0), "No stable pre-existing Ollama listener was found on 127.0.0.1:11434; refusing to proceed.");
	return { pids, models };
}
async function officialModelManifest() {
	const url = "https://registry.ollama.ai/v2/library/qwen3/manifests/0.6b";
	const response = await fetch(url, {
		redirect: "error",
		headers: { accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" },
		signal: AbortSignal.timeout(10_000),
	});
	assert.equal(new URL(response.url).origin, "https://registry.ollama.ai", "The model manifest came from an unexpected registry.");
	const bytes = await boundedBytes(response, "The official Qwen3 model manifest", 256 * 1024);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const optionalDigestHeader = response.headers.get("ollama-content-digest") ?? response.headers.get("docker-content-digest");
	if (optionalDigestHeader) {
		const headerDigest = optionalDigestHeader.toLowerCase().replace(/^sha256:/, "");
		assert.match(headerDigest, /^[a-f0-9]{64}$/, "The official registry returned a malformed manifest digest header.");
		assert.equal(headerDigest, digest, "The official registry digest header did not match the exact manifest response bytes.");
	}
	const manifest = JSON.parse(bytes.toString("utf8"));
	assert.equal(manifest.schemaVersion, 2, "The official model manifest schema is unsupported.");
	assert(Number.isSafeInteger(manifest.config?.size) && manifest.config.size > 0 && /^sha256:[a-f0-9]{64}$/.test(manifest.config.digest ?? ""), "The official model manifest has an invalid config descriptor.");
	assert(Array.isArray(manifest.layers) && manifest.layers.length > 0, "The official model manifest has no layers.");
	const layerBytes = manifest.layers.reduce((total, layer) => {
		assert(Number.isSafeInteger(layer?.size) && layer.size > 0 && /^sha256:[a-f0-9]{64}$/.test(layer?.digest ?? ""), "The official model manifest contains an invalid layer descriptor.");
		return total + layer.size;
	}, Number.isSafeInteger(manifest.config?.size) && manifest.config.size > 0 ? manifest.config.size : 0);
	assert(layerBytes > 0 && layerBytes <= MODEL_MAX_BYTES, `The official qwen3:0.6b manifest advertises ${layerBytes} bytes, above the ${MODEL_MAX_BYTES}-byte canary limit.`);
	return { digest, advertisedBytes: layerBytes, mediaType: response.headers.get("content-type") ?? "", registryDigestHeader: optionalDigestHeader ?? null };
}
function processSnapshot() {
	const lines = run("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="]).split(/\r?\n/);
	return lines.flatMap(line => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
	});
}
function processIdentity(pid) {
	try {
		const started = run("/bin/ps", ["-p", String(pid), "-o", "lstart="], 2_000);
		const command = run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], 2_000);
		return started && command ? { started, command } : null;
	} catch (error) { if (error && typeof error === "object" && "status" in error && error.status === 1) return null; throw error; }
}

function sameProcess(pid, expected) {
	if (!expected) return false;
	const actual = processIdentity(pid);
	return actual?.started === expected.started && actual?.command === expected.command;
}

async function captureServerIdentity(child, executable) {
	if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return null;
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
		const identity = processIdentity(child.pid);
		if (identity && (identity.command === executable || identity.command.startsWith(`${executable} `))) {
			return { pid: child.pid, ...identity };
		}
		await delay(20);
	}
	return null;
}

function descendantsOf(rootPid, rootIdentity) {
	if (!sameProcess(rootPid, rootIdentity)) return [];
	const all = processSnapshot();
	const byParent = new Map();
	for (const item of all) {
		const children = byParent.get(item.ppid) ?? [];
		children.push(item); byParent.set(item.ppid, children);
	}
	const result = [];
	const seen = new Set([rootPid]);
	const queue = [rootPid];
	while (queue.length) for (const child of byParent.get(queue.shift()) ?? []) {
		if (seen.has(child.pid)) continue;
		seen.add(child.pid);
		const identity = processIdentity(child.pid);
		if (!identity || identity.command !== child.command || !sameProcess(child.pid, identity)) continue;
		result.push({ ...child, ...identity });
		queue.push(child.pid);
	}
	return result;
}

function observeOwnedTree(child, identity) {
	if (!child || child.exitCode !== null || child.signalCode !== null || !identity || child.pid !== identity.pid || !sameProcess(child.pid, identity)) return [];
	const snapshot = processSnapshot();
	return [
		{ pid: child.pid, ppid: snapshot.find(item => item.pid === child.pid)?.ppid ?? null, ...identity },
		...descendantsOf(child.pid, identity),
	];
}
async function waitUntil(predicate, message, timeoutMs = 4_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (predicate()) return;
		await delay(100);
	}
	assert(predicate(), message);
}
async function privatePort() {
	const server = createServer();
	server.unref();
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	assert(address && typeof address !== "string", "Could not reserve a private loopback port.");
	assert(address.port !== 11434, "The private canary must never use Ollama's default 11434 port.");
	await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
	assert.equal(listenerPids(address.port).length, 0, "The chosen private loopback port is unexpectedly occupied.");
	return address.port;
}
async function assertProcessesGone(processes) {
	await waitUntil(() => processes.every(item => !sameProcess(item.pid, item)), "An owned Ollama server or runner descendant survived stop().", 5_000);
}
async function snapshotOwnedTree(child, identity) {
	assert(child && Number.isSafeInteger(child.pid) && child.pid > 0, "The managed runtime did not expose a child PID.");
	assert(identity, "The owned Ollama server's start-time and executable identity was not captured at spawn.");
	const tree = observeOwnedTree(child, identity);
	receipt.observedProcessTrees ??= [];
	receipt.observedProcessTrees.push({ at: new Date().toISOString(), processes: tree });
	assert(tree.length > 0, "The owned Ollama server PID is not live.");
	// The pinned v0.32.1 GGUF engine launches the upstream llama-server binary;
	// older releases used an `ollama runner` command.
	const runners = tree.slice(1).filter(item => /(?:^|[\s/])(?:runner|llama-server)(?:\s|$)/i.test(item.command));
	assert(runners.length > 0, "No live Ollama runner descendant was observed after real model inference; runner cleanup is not proven.");
	return tree;
}
function inside(root, path) {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

const baseline = await externalState();
const modelPin = await officialModelManifest();
const disk = await statfs(tmpdir());
const freeBytes = disk.bavail * disk.bsize;
assert(freeBytes >= MIN_FREE_BYTES, `Only ${freeBytes} free bytes are available under ${tmpdir()}; at least ${MIN_FREE_BYTES} are required.`);
const candidateSha256 = await candidateDigest(candidate);
const port = await privatePort();
const origin = `http://127.0.0.1:${port}`;
await mkdir(resolve(".tmp"), { recursive: true });
const evidence = await mkdtemp(resolve(".tmp/native-managed-runtime-evidence-"));
await chmod(evidence, 0o700);
const root = await mkdtemp(join(tmpdir(), "kestrel-managed-runtime-canary-"));
await chmod(root, 0o700);

const receipt = {
	version: 1,
	startedAt: new Date().toISOString(),
	scope: "actual LocalRuntimeManager managed Ollama vendor/runtime lifecycle; not bundled Core/default-port proof",
	candidate,
	candidateSha256,
	model: MODEL,
	modelRegistry: { origin: "https://registry.ollama.ai", ...modelPin },
	runtimeManifest: EXPECTED_RUNTIME,
	private: { root, origin, freeBytesAtStart: freeBytes },
	externalBefore: baseline,
	phases: [],
	progress: [],
	limitations: [
		"This canary exercises LocalRuntimeManager directly, not the native Core provider route or bundled app behavior.",
		"Ollama registry model metadata is pinned and bounded; the model's content is not independently re-hashed by this script.",
	],
};
let manager;
let spawnedChild;
let spawnedIdentityPromise;
let spawnedIdentity;
let spawnEnvironment;
let deadlineExceeded = false;
let budgetExceeded = false;
let failure;
let timeout;
const ownedTrees = [];
const trackedProgress = new Set();
const providerCredentialName = /(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL)/i;
const allowedSpawnEnvironment = new Set(["PATH", "HOME", "TMPDIR", "OLLAMA_HOST", "OLLAMA_MODELS", "OLLAMA_KEEP_ALIVE", "OLLAMA_CONTEXT_LENGTH", "OLLAMA_NO_CLOUD"]);
const progress = event => {
	const { updatedAt: _updatedAt, message: _message, ...safeEvent } = event;
	receipt.progress.push(safeEvent);
	if (receipt.progress.length > 2_000) receipt.progress.shift();
	if (event.stage) trackedProgress.add(event.stage);
	if (event.stage === "downloading-runtime" && (event.totalBytes !== EXPECTED_RUNTIME.bytes || (event.downloadedBytes ?? 0) > EXPECTED_RUNTIME.bytes)) budgetExceeded = true;
	if (event.stage === "downloading-model" && ((event.totalBytes ?? 0) > MODEL_MAX_BYTES || (event.downloadedBytes ?? 0) > MODEL_MAX_BYTES)) budgetExceeded = true;
	if (budgetExceeded) manager?.cancel();
};

const { spawn: realSpawn } = await import("node:child_process");
function makeRealManager() {
	const deps = {
		origin,
		spawn: ((file, args, options) => {
			assert(!spawnedChild || spawnedChild.exitCode !== null, "The manager attempted to start multiple owned Ollama servers at once.");
			assert(inside(root, file), "The manager attempted to start a binary outside the private runtime root.");
			assert.equal(file, join(root, "local-runtime", "ollama", EXPECTED_RUNTIME.version, EXPECTED_RUNTIME.binaryPath));
			assert.deepEqual(args, ["serve"]);
			assert.equal(options?.cwd, join(root, "local-runtime", "ollama", EXPECTED_RUNTIME.version));
			const env = options?.env;
			assert(env && typeof env === "object", "The manager did not provide a scrubbed Ollama environment.");
			for (const key of Object.keys(env)) {
				assert(allowedSpawnEnvironment.has(key), `The manager passed unexpected environment variable ${key} to Ollama.`);
				assert(!providerCredentialName.test(key), `Provider-like environment variable ${key} was passed to Ollama.`);
			}
			assert.equal(env.OLLAMA_HOST, `127.0.0.1:${port}`);
			assert.equal(env.OLLAMA_MODELS, join(root, "local-models"));
			assert.equal(env.HOME, join(root, "local-runtime-home"));
			assert.equal(env.OLLAMA_NO_CLOUD, "1");
			assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
			for (const path of [env.HOME, env.OLLAMA_MODELS]) assert(inside(root, path), `${path} escaped the private root.`);
			spawnEnvironment = { ...env };
			spawnedChild = realSpawn(file, args, options);
			spawnedIdentityPromise = captureServerIdentity(spawnedChild, file).catch(() => null);
			spawnedIdentity = null;
			void spawnedIdentityPromise.then(identity => { spawnedIdentity = identity; });
			return spawnedChild;
		}),
	};
	return new LocalRuntimeManager(root, progress, deps);
}

async function verifyPrivateListener(child) {
	assert(child?.pid, "The managed Ollama server was not spawned.");
	await waitUntil(() => listenerPids(port).length > 0, "The owned Ollama server did not bind its private loopback port.", 5_000);
	assert.deepEqual(listenerPids(port), [child.pid], "The private Ollama port is not owned solely by the manager's server PID.");
}

try {
	manager = makeRealManager();
	timeout = setTimeout(() => { deadlineExceeded = true; manager?.cancel(); }, TOTAL_DEADLINE_MS);
	const first = await manager.bootstrap(MODEL);
	assert(!deadlineExceeded, "The managed-runtime canary exceeded its 20-minute total deadline.");
	assert(!budgetExceeded, "The managed-runtime canary exceeded a pinned runtime or model download budget.");
	assert(first.managedRuntime && first.ollamaAvailable && first.source === "managed", "The real managed runtime did not reach its live managed state.");
	assert.equal(first.runtimeVersion, EXPECTED_RUNTIME.version, "The running runtime version did not match the pinned vendor manifest.");
	assert.equal(first.verifiedModel, MODEL, "The manager did not complete and record a real model chat response.");
	assert(trackedProgress.has("verifying-model") && trackedProgress.has("ready"), "The manager did not report a live model verification and ready state.");
	assert(spawnedChild && !(spawnedChild instanceof Promise), "The real Ollama child process was not captured.");
	await verifyPrivateListener(spawnedChild);
	const runtimeVersion = await boundedJson(await fetch(`${origin}/api/version`, { redirect: "error", signal: AbortSignal.timeout(5_000) }), "Private managed Ollama version");
	assert.equal(runtimeVersion.version, EXPECTED_RUNTIME.version, "The actual private server version did not match the pinned release.");
	receipt.runtimeApiVersion = runtimeVersion.version;
	const firstTree = await snapshotOwnedTree(spawnedChild, spawnedIdentityPromise ? await spawnedIdentityPromise : spawnedIdentity);
	ownedTrees.push(firstTree);
	receipt.phases.push({ phase: "pinned-runtime-installed-model-pulled-and-live-chat-verified", passed: true, runtimeVersion: first.runtimeVersion, verifiedModel: first.verifiedModel, ownedProcessTree: firstTree, spawnEnvironment });
	const privateTags = await boundedJson(await fetch(`${origin}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(5_000) }), "Private managed Ollama model listing");
	const installed = privateTags.models?.filter(item => item?.name === MODEL || item?.name === `${MODEL}:latest`) ?? [];
	assert.equal(installed.length, 1, "The private managed Ollama store does not contain exactly the requested model tag.");
	assert.match(installed[0].digest ?? "", /^[a-f0-9]{64}$/i, "The private model tag has no stable content digest.");
	const installedDigest = installed[0].digest.toLowerCase();
	assert.equal(installedDigest, modelPin.digest, "The installed model digest does not match the official registry manifest digest.");
	receipt.privateModel = { name: installed[0].name, digest: installedDigest, size: installed[0].size };
	const modelShow = await boundedJson(await fetch(`${origin}/api/show`, {
		method: "POST", redirect: "error", headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: MODEL }), signal: AbortSignal.timeout(5_000),
	}), "Private managed Ollama model descriptor", 256 * 1024);
	assert(Array.isArray(modelShow.capabilities), "The private model descriptor omitted its capabilities list.");
	const capabilities = [...new Set(modelShow.capabilities.filter(item => typeof item === "string"))].sort();
	assert(capabilities.includes("completion") && capabilities.includes("tools"), "The private model did not report both completion and tool capabilities.");
	receipt.privateModel.capabilities = capabilities;
	await manager.stop();
	await assertProcessesGone(firstTree);
	assert.deepEqual(listenerPids(port), [], "The first managed runtime left its private port listening after stop().");
	receipt.phases.push({ phase: "first-stop-reaped-owned-server-and-runner", passed: true, processes: firstTree.map(({ pid, ppid, command, started }) => ({ pid, ppid, command, started })) });

	manager = makeRealManager();
	spawnedChild = undefined;
	spawnedIdentityPromise = undefined;
	spawnedIdentity = undefined;
	const restarted = await manager.bootstrap(MODEL);
	assert(!deadlineExceeded && !budgetExceeded, "The canary deadline or download budget was exceeded on restart.");
	assert(restarted.managedRuntime && restarted.ollamaAvailable && restarted.source === "managed", "The installed runtime did not restart from its private root.");
	assert.equal(restarted.verifiedModel, MODEL, "The installed model did not remain available after restart.");
	await verifyPrivateListener(spawnedChild);
	const restartTree = await snapshotOwnedTree(spawnedChild, spawnedIdentityPromise ? await spawnedIdentityPromise : spawnedIdentity);
	ownedTrees.push(restartTree);
	const verificationPath = join(root, "local-runtime", "last-verification.json");
	const priorVerification = await readFile(verificationPath);
	assert(JSON.parse(priorVerification.toString("utf8")).model === MODEL, "The prior verification marker is not valid for the selected model.");
	receipt.phases.push({ phase: "private-root-restart-preserved-runtime-model-and-verification", passed: true, ownedProcessTree: restartTree });

	let commitReached = false;
	await assert.rejects(manager.bootstrap(MODEL, { commit: async signal => {
		commitReached = true;
		manager.cancel();
		signal.throwIfAborted();
	} }), /cancel|abort/i);
	assert(commitReached, "The cancellation retry did not reach the post-verification commit boundary.");
	assert.deepEqual(await readFile(verificationPath), priorVerification, "The canceled retry did not preserve the prior valid verification marker.");
	receipt.phases.push({ phase: "cancelled-retry-restored-prior-valid-verification", passed: true });
	const secondTree = await snapshotOwnedTree(spawnedChild, spawnedIdentityPromise ? await spawnedIdentityPromise : spawnedIdentity);
	await manager.stop();
	await assertProcessesGone(secondTree);
	assert.deepEqual(listenerPids(port), [], "The canceled retry left its private port listening after stop().");
	receipt.phases.push({ phase: "cancel-stop-reaped-owned-server-and-runner", passed: true, processes: secondTree.map(({ pid, ppid, command, started }) => ({ pid, ppid, command, started })) });

	assert(trackedProgress.has("downloading-runtime") && trackedProgress.has("verifying-runtime") && trackedProgress.has("installing-runtime") && trackedProgress.has("starting-runtime") && trackedProgress.has("downloading-model"), "The canary did not observe every expected real install stage.");
	const after = await externalState();
	assert.deepEqual(after, baseline, "The pre-existing Ollama listener PIDs or model name/digest metadata changed during the canary.");
	receipt.externalAfter = after;
	receipt.phases.push({ phase: "external-11434-listener-and-model-digests-unchanged", passed: true });
	assert.equal(await candidateDigest(candidate), candidateSha256, "The candidate bundle changed during the canary.");
	receipt.candidateSha256After = candidateSha256;
	receipt.phases.push({ phase: "candidate-fingerprint-unchanged", passed: true });
	receipt.result = "passed";
} catch (error) {
	failure = error;
	receipt.result = "failed";
	receipt.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
	clearTimeout(timeout);
	if (spawnedIdentityPromise) {
		try { spawnedIdentity = await spawnedIdentityPromise; } catch { spawnedIdentity = null; }
	}
	const observed = observeOwnedTree(spawnedChild, spawnedIdentity);
	if (observed.length && !ownedTrees.some(tree => tree[0]?.pid === observed[0]?.pid)) ownedTrees.push(observed);
	let remainingOwned = [];
	if (manager) {
		try { await manager.stop(); } catch (error) { receipt.cleanupError = String(error); }
	}
	for (const tree of ownedTrees) for (const processInfo of tree) {
		if (!processInfo.started) continue;
		if (sameProcess(processInfo.pid, processInfo)) remainingOwned.push(processInfo);
	}
	if (remainingOwned.length) {
		receipt.result = "failed";
		receipt.stopLeftOwnedProcesses = remainingOwned.map(({ pid, ppid, command, started }) => ({ pid, ppid, command, started }));
		receipt.failure ??= "manager.stop() left one or more start-time-verified owned processes alive; no such cleanup is counted as a pass.";
		// Best-effort cleanup is restricted to exact captured descendants whose
		// process start time still matches; the observed stop failure remains a
		// failure in the receipt even if this cleanup succeeds.
		const ownedServerPids = new Set(ownedTrees.map(tree => tree[0]?.pid).filter(Number.isSafeInteger));
		for (const item of remainingOwned) {
			if (ownedServerPids.has(item.pid)) continue;
			if (!sameProcess(item.pid, item)) continue;
			try { process.kill(item.pid, "SIGTERM"); } catch { /* already exited */ }
		}
		await delay(500);
		for (const item of remainingOwned) {
			if (ownedServerPids.has(item.pid)) continue;
			if (!sameProcess(item.pid, item)) continue;
			try { process.kill(item.pid, "SIGKILL"); } catch { /* already exited */ }
		}
		await delay(250);
		remainingOwned = [];
		for (const tree of ownedTrees) for (const processInfo of tree) {
			if (processInfo.started && sameProcess(processInfo.pid, processInfo)) remainingOwned.push(processInfo);
		}
		if (remainingOwned.length) receipt.ownedProcessesStillLiveAfterBestEffort = remainingOwned.map(({ pid, ppid, command, started }) => ({ pid, ppid, command, started }));
	}
	try { receipt.candidateSha256After = await candidateDigest(candidate); }
	catch (error) { receipt.candidateHashError = String(error); receipt.result = "failed"; }
	try { receipt.externalAfter = await externalState(); }
	catch (error) { receipt.externalAfterError = String(error); receipt.result = "failed"; }
	if (receipt.externalBefore && receipt.externalAfter && JSON.stringify(receipt.externalAfter) !== JSON.stringify(receipt.externalBefore)) {
		receipt.externalStateChanged = true;
		receipt.result = "failed";
	}
	if (receipt.candidateSha256After && receipt.candidateSha256After !== receipt.candidateSha256) {
		receipt.candidateChanged = true;
		receipt.result = "failed";
	}
	if (remainingOwned.length === 0 && listenerPids(port).length === 0) {
		try { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); receipt.privateRootRemoved = true; }
		catch (error) { receipt.privateRootRemovalError = String(error); receipt.result = "failed"; }
	} else receipt.privateRootPreservedForInspection = root;
	try { await mkdir(dirname(evidence), { recursive: true }); } catch {}
	try { await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); }
	catch (error) { receipt.receiptWriteError = String(error); receipt.result = "failed"; }
}

if (failure || receipt.result !== "passed") {
	console.error(`Managed-runtime canary ${receipt.result}. Receipt: ${join(evidence, "receipt.json")}`);
	if (failure) throw failure;
	throw new Error(receipt.failure ?? "Managed-runtime canary did not pass.");
}
console.log(`Managed-runtime lifecycle canary passed. Receipt: ${join(evidence, "receipt.json")}`);
