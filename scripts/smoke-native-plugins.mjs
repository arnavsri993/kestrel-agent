#!/usr/bin/env node
// Private bundled-Core protocol coverage using only generated plugin fixtures.
// This does not start Kestrel's UI or touch the installed app/profile.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";

const supplied = process.env.KESTREL_NATIVE_TEST_APP?.trim();
assert(supplied, "Set KESTREL_NATIVE_TEST_APP to an explicit disposable candidate. Nothing was launched.");
const candidate = await realpath(resolve(supplied));
assert(!candidate.startsWith("/Applications/"), "Use a disposable candidate outside /Applications.");
assert.notEqual(candidate, "/Applications/Kestrel.app", "The canonical Kestrel app cannot be used as the candidate.");
const resources = join(candidate, "Contents/Resources");
const bundledNode = join(resources, "agent-core/node/bin/node");
const coreEntry = join(resources, "native-desktop-core.mjs");
await Promise.all([lstat(bundledNode), lstat(coreEntry)]);
const initialCandidateDigest = await candidateDigest(candidate);
const bundledNodeRealPath = await realpath(bundledNode);
await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
const evidence = await mkdtemp(join(process.cwd(), ".tmp/native-plugin-core-evidence-"));
const receipt = {
	at: new Date().toISOString(), candidate, candidateSha256Before: initialCandidateDigest, candidateSha256After: null,
	scope: "private bundled native Core protocol with a fresh generated profile and synthetic native-dialog replies",
	syntheticPickerReplies: true, cocoaOrPhysicalUiTested: false, phases: [], result: "running",
};

const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-plugins-")));
await chmod(profile, 0o700);
const fixtures = join(profile, "generated-fixtures");
await mkdir(fixtures, { mode: 0o700 });
const keyPair = generateKeyPairSync("ed25519");
const keyId = "native.smoke.publisher";
const publisherDocument = join(fixtures, "publisher.json");
await writeFile(publisherDocument, JSON.stringify({
	keyId,
	publicKey: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
}), { mode: 0o600 });

function lengthPrefix(length) {
	const bytes = Buffer.allocUnsafe(8);
	bytes.writeBigUInt64BE(BigInt(length));
	return bytes;
}

async function listBundleFiles(root, current = root, files = []) {
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const path = join(current, entry.name);
		const metadata = await lstat(path);
		assert(!metadata.isSymbolicLink(), "Generated fixture bundles must not contain links.");
		if (metadata.isDirectory()) await listBundleFiles(root, path, files);
		else {
			assert(metadata.isFile(), "Generated fixture bundles must contain regular files only.");
			const relativePath = relative(root, path).split(sep).join("/").normalize("NFC");
			files.push({ path, relativePath });
		}
	}
	return files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
}

async function signBundle(bundleRoot) {
	const hash = createHash("sha256").update("kestrel-plugin-bundle-v1\0");
	for (const file of await listBundleFiles(bundleRoot)) {
		if (file.relativePath === ".codex-plugin/signature.json") continue;
		const pathBytes = Buffer.from(file.relativePath, "utf8");
		const contents = await readFile(file.path);
		hash.update(lengthPrefix(pathBytes.byteLength));
		hash.update(pathBytes);
		hash.update(lengthPrefix(contents.byteLength));
		hash.update(contents);
	}
	const digest = hash.digest("hex");
	await writeFile(join(bundleRoot, ".codex-plugin/signature.json"), JSON.stringify({
		algorithm: "ed25519", keyId, digest,
		signature: sign(null, Buffer.from(digest, "hex"), keyPair.privateKey).toString("base64"),
	}), { mode: 0o600 });
	return digest;
}

async function makeBundle(version) {
	const bundleRoot = join(fixtures, `plugin-${version}`);
	await mkdir(join(bundleRoot, ".codex-plugin"), { recursive: true, mode: 0o700 });
	await mkdir(join(bundleRoot, "skills", "native-plugin-canary"), { recursive: true, mode: 0o700 });
	await mkdir(join(bundleRoot, "mcp"), { recursive: true, mode: 0o700 });
	await writeFile(join(bundleRoot, ".codex-plugin/plugin.json"), JSON.stringify({
		name: "native-plugin-canary", version, description: "Generated native plugin boundary fixture.",
		mcpServers: "./.mcp.json", skills: "./skills",
	}), { mode: 0o600 });
	await writeFile(join(bundleRoot, ".mcp.json"), JSON.stringify({ mcpServers: {
		owned: { command: "node", args: ["./mcp/server.mjs"] },
	} }), { mode: 0o600 });
	await writeFile(join(bundleRoot, "mcp/server.mjs"), `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned-native-smoke',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo generated fixture text and report the bundled runtime.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:String(m.params.arguments.text)}],structuredContent:{text:String(m.params.arguments.text),nodeExecutable:process.execPath}};if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});\n`, { mode: 0o600 });
	await writeFile(join(bundleRoot, "skills/native-plugin-canary/SKILL.md"), "---\nname: native-plugin-canary\ndescription: Generated skill used by the native plugin smoke test.\n---\n\nOnly generated fixture instructions.\n", { mode: 0o600 });
	await writeFile(join(bundleRoot, "skills/native-plugin-canary/reference.md"), "Generated resource canary.\n", { mode: 0o600 });
	await signBundle(bundleRoot);
	return bundleRoot;
}

const bundleV1 = await makeBundle("1.0.0");
const bundleV2 = await makeBundle("2.0.0");
let child;
let childExit;
let ready = false;
let stderr = "";
let sequence = 0;
let dialogHandler;
const pending = new Map();
const dialogRequests = new Map();
const cancelledDialogs = new Set();
const protectedKeyBase64 = randomBytes(32).toString("base64");
function recordPhase(phase, details = {}) { receipt.phases.push({ phase, passed: true, ...details }); }

function write(message) {
	assert(child?.stdin.writable && child.exitCode === null && child.signalCode === null, "The disposable bundled Core is unavailable.");
	child.stdin.write(JSON.stringify(message) + "\n");
}

function startCore() {
	ready = false;
	child = spawn(bundledNode, [coreEntry, "--profile-root", profile, "--durable-profile"], {
		env: {
			...process.env,
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	childExit = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
	child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-24_000); });
	createInterface({ input: child.stdout }).on("line", line => {
		let message;
		try { message = JSON.parse(line); }
		catch (error) { stderr += `\nInvalid Core stdout JSON: ${String(error)}`; child.kill("SIGTERM"); return; }
		if (message.kind === "native-core-profile-key-request") {
			assert.equal(message.requestId, "native-core-profile-key-v1");
			write({ kind: "native-core-profile-key-response", requestId: message.requestId, ok: true, keyBase64: protectedKeyBase64 });
		} else if (message.type === "ready") ready = true;
		else if (message.type === "response") {
			const item = pending.get(message.id);
			if (!item) return;
			pending.delete(message.id);
			clearTimeout(item.timer);
			item.resolve(message.response);
		} else if (message.type === "browser-backend-reset") {
			write({ type: "browser-backend-reset-response", requestId: message.requestId, ok: true });
		} else if (message.type === "native-dialog-request") {
			dialogRequests.set(message.requestId, message.operation);
			if (dialogHandler) void Promise.resolve(dialogHandler(message));
		} else if (message.type === "native-dialog-cancel") cancelledDialogs.add(message.requestId);
		else if (message.type === "start-error") stderr += `\nCore start error: ${message.error}`;
	});
}

async function waitFor(check, label, timeoutMs = 30_000) {
	for (const end = Date.now() + timeoutMs; Date.now() < end;) {
		assert(child && child.exitCode === null && child.signalCode === null, `${label}; Core exited: ${stderr}`);
		if (check()) return;
		await delay(25);
	}
	assert.fail(`${label}; timed out: ${stderr}`);
}

function beginRequest(request, host = false, timeoutMs = 90_000) {
	const id = `plugin-smoke-${++sequence}`;
	const promise = new Promise((resolveRequest, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Bundled Core request ${request.type} timed out: ${stderr}`));
		}, timeoutMs);
		pending.set(id, { resolve: resolveRequest, reject, timer });
		write({ type: host ? "host-request" : "request", id, request });
	});
	return { id, promise };
}

function request(requestBody, host = false, timeoutMs = 90_000) {
	return beginRequest(requestBody, host, timeoutMs).promise;
}

async function withPicker(operation, selection, action) {
	dialogHandler = async message => {
		assert.equal(message.operation, operation, `Unexpected native picker operation: ${message.operation}`);
		const response = typeof selection === "function" ? await selection(message) : selection;
		write({ type: "native-dialog-response", requestId: message.requestId, response });
	};
	try { return await action(); }
	finally { dialogHandler = undefined; }
}

async function cleanStop() {
	assert(child && child.exitCode === null && child.signalCode === null, `Core exited before clean shutdown: ${stderr}`);
	write({ type: "shutdown" });
	const result = await Promise.race([
		childExit,
		delay(15_000, undefined, { ref: false }).then(() => { throw new Error(`Bundled Core did not stop cleanly: ${stderr}`); }),
	]);
	assert.deepEqual(result, { code: 0, signal: null }, stderr);
	child = undefined;
}

async function assertNoPublisherTrust() {
	const response = await request({ type: "plugin-get-publishers" }, true);
	assert(response.ok && Array.isArray(response.pluginPublishers) && response.pluginPublishers.length === 0, "A cancelled picker changed publisher trust.");
}

try {
	startCore();
	await waitFor(() => ready, "Bundled native Core did not become ready.");

	// Cancel a genuinely pending private picker through the Core host-cancel path.
	const cancelledImport = beginRequest({ type: "plugin-import-publisher" }, true);
	await waitFor(() => [...dialogRequests.values()].includes("select-plugin-publisher"), "The generated publisher picker did not open.");
	const cancelledDialogId = [...dialogRequests].find(([, operation]) => operation === "select-plugin-publisher")?.[0];
	assert(cancelledDialogId, "Missing picker cancellation id.");
	write({ type: "host-cancel", id: cancelledImport.id });
	await waitFor(() => cancelledDialogs.has(cancelledDialogId), "Core did not cancel the pending native publisher picker.");
	const cancelledResult = await cancelledImport.promise;
	assert.equal(cancelledResult.ok, false, `The pending publisher picker should report cancellation: ${JSON.stringify(cancelledResult)}`);
	await assertNoPublisherTrust();
	recordPhase("cancel-pending-generated-publisher-picker-without-trust-mutation");

	// The only selected key material is the generated public Ed25519 document.
	const imported = await withPicker("select-plugin-publisher", { ok: true, selectedContextPaths: [publisherDocument] },
		() => request({ type: "plugin-import-publisher" }, true));
	assert(imported.ok && imported.pluginPublishers?.some(item => item.keyId === keyId), `Generated publisher import failed: ${JSON.stringify(imported)}`);
	recordPhase("import-generated-public-publisher-key");

	const installed = await withPicker("select-plugin-bundle", { ok: true, selectedWorkspacePath: bundleV1 },
		() => request({ type: "plugin-install-bundle" }, true));
	assert(installed.ok && installed.pluginMutation?.action === "install" && installed.pluginMutation.name === "native-plugin-canary", `Generated signed plugin install failed: ${JSON.stringify(installed)}`);
	let plugins = await request({ type: "plugin-list" });
	assert(plugins.ok && plugins.plugins?.length === 1 && plugins.plugins[0].name === "native-plugin-canary" && plugins.plugins[0].enabled === false,
		`Newly installed plugin was not disabled: ${JSON.stringify(plugins)}`);
	recordPhase("install-signed-plugin-disabled-by-default", { version: "1.0.0" });

	const enabled = await request({ type: "plugin-set-enabled", name: "native-plugin-canary", enabled: true });
	assert(enabled.ok && enabled.plugins?.some(item => item.name === "native-plugin-canary" && item.enabled), `Explicit plugin enable failed: ${JSON.stringify(enabled)}`);
	const sessions = await request({ type: "runtime-list-sessions" });
	const mainSession = sessions.sessions?.find(item => item.title === "Main session") ?? sessions.sessions?.[0];
	assert(sessions.ok && mainSession?.id, `Could not find the disposable Core session: ${JSON.stringify(sessions)}`);
	const activation = await request({ type: "runtime-call-tool", sessionId: mainSession.id, toolName: "skills.activate",
		input: { name: "native-plugin-canary" }, approvalStatus: "approved", idempotencyKey: "native-plugin-smoke-skill" });
	assert(activation.ok && activation.execution?.status === "verified" && JSON.stringify(activation.execution.output).includes("Only generated fixture instructions."),
		`The owned plugin skill did not activate: ${JSON.stringify(activation)}`);
	recordPhase("explicit-enable-and-skill-activation");

	const connected = await request({ type: "plugin-connect-mcp", name: "native-plugin-canary" });
	assert(connected.ok && connected.plugins?.some(item => item.name === "native-plugin-canary" && item.mcpConnected),
		`The owned echo MCP server did not connect: ${JSON.stringify(connected)}`);
	const toolName = "mcp.native-plugin-canary.owned.echo";
	const denied = await request({ type: "runtime-call-tool", sessionId: mainSession.id, toolName,
		input: { text: "owned echo canary" }, idempotencyKey: "native-plugin-smoke-blocked" });
	assert(denied.ok && denied.execution?.status === "blocked", `The ordinary echo call should require approval: ${JSON.stringify(denied)}`);
	const approved = await request({ type: "runtime-call-tool", sessionId: mainSession.id, toolName,
		input: { text: "owned echo canary" }, approvalStatus: "approved", idempotencyKey: "native-plugin-smoke-approved" });
	assert(approved.ok && approved.execution?.status === "verified" && approved.execution.output?.structuredContent?.text === "owned echo canary",
		`The approved owned echo call failed: ${JSON.stringify(approved)}`);
	assert.equal(await realpath(approved.execution.output.structuredContent.nodeExecutable), bundledNodeRealPath,
		"The owned echo process must run with the candidate's bundled Node executable.");
	const disconnected = await request({ type: "plugin-disconnect-mcp", name: "native-plugin-canary" });
	assert(disconnected.ok && disconnected.plugins?.some(item => item.name === "native-plugin-canary" && !item.mcpConnected),
		`The owned MCP child did not disconnect: ${JSON.stringify(disconnected)}`);
	recordPhase("owned-bundled-node-mcp-echo-blocked-approved-and-disconnected", { mcpRuntime: "candidate bundled Node" });
	console.log("Passed: generated publisher import, signed install, disabled-by-default state, explicit enable, skill activation, owned MCP echo approval, and disconnect.");

	await cleanStop();
	startCore();
	await waitFor(() => ready, "Bundled native Core did not restart with the disposable profile.");
	plugins = await request({ type: "plugin-list" });
	assert(plugins.ok && plugins.plugins?.some(item => item.name === "native-plugin-canary" && item.version === "1.0.0" && item.enabled),
		`Restart did not preserve the installed and explicitly enabled plugin: ${JSON.stringify(plugins)}`);
	recordPhase("restart-preserves-installed-and-enabled-plugin", { version: "1.0.0" });
	const restoredSkill = await request({ type: "runtime-call-tool", sessionId: mainSession.id, toolName: "skills.activate",
		input: { name: "native-plugin-canary" }, approvalStatus: "approved", idempotencyKey: "native-plugin-smoke-restart-skill" });
	assert(restoredSkill.ok && restoredSkill.execution?.status === "verified" && JSON.stringify(restoredSkill.execution.output).includes("Only generated fixture instructions."),
		`The enabled plugin skill did not survive restart: ${JSON.stringify(restoredSkill)}`);

	// Damage only the generated v2 source. A rejected update must preserve the installed v1 bundle.
	const signaturePath = join(bundleV2, ".codex-plugin/signature.json");
	const signature = JSON.parse(await readFile(signaturePath, "utf8"));
	signature.signature = Buffer.alloc(64, 0).toString("base64");
	await writeFile(signaturePath, JSON.stringify(signature), { mode: 0o600 });
	const rejectedUpdate = await withPicker("select-plugin-bundle", { ok: true, selectedWorkspacePath: bundleV2 },
		() => request({ type: "plugin-update-bundle" }, true));
	assert.equal(rejectedUpdate.ok, false, "A generated bundle with a tampered signature must be rejected.");
	plugins = await request({ type: "plugin-list" });
	assert(plugins.ok && plugins.plugins?.some(item => item.name === "native-plugin-canary" && item.version === "1.0.0" && item.enabled),
		`Rejected signature update changed the installed plugin: ${JSON.stringify(plugins)}`);
	recordPhase("tampered-generated-signature-rejected-with-installed-plugin-preserved");
	console.log("Passed: restart preserves plugin activation state; tampered generated signature update is rejected without replacing v1.");

	await cleanStop();
	assert.equal(await candidateDigest(candidate), initialCandidateDigest, "The disposable candidate changed during the Core smoke run.");
	receipt.result = "passed";
	console.log("Native signed plugin private-Core smoke passed. No GUI/Cocoa picker was exercised; picker replies were generated protocol fixtures.");
	} catch (error) {
	receipt.result = "failed";
	receipt.failure = String(error);
	throw error;
} finally {
	if (child && child.exitCode === null && child.signalCode === null) {
		try {
			write({ type: "shutdown" });
			await Promise.race([childExit, delay(12_000, undefined, { ref: false }).then(() => { throw new Error("Core shutdown timed out"); })]);
		} catch {
			child.kill("SIGTERM");
			await Promise.race([childExit, delay(3_000, undefined, { ref: false })]);
		}
		if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await childExit; }
	}
	for (const item of pending.values()) clearTimeout(item.timer);
	await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
	try { receipt.candidateSha256After = await candidateDigest(candidate); }
	catch (error) { receipt.candidateSha256AfterError = String(error); }
	await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
	console.log(`Native plugin smoke receipt: ${join(evidence, "receipt.json")}`);
}
