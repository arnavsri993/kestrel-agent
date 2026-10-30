// Private Core/host protocol integration in an owned fixture. Picker replies
// are simulated here; only the separate on-screen test proves a Cocoa panel.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Supply an explicit disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "This fixture must not use an installed app.");
const fingerprint = await candidateDigest(candidate);
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-context-dialog-"));
const workspace = join(profile, "workspace");
await mkdir(workspace, { mode: 0o700 }); await mkdir(join(profile, "native-core"), { mode: 0o700 });
await writeFile(join(workspace, "README.md"), "Owned native picker protocol fixture.\n", { mode: 0o600 });
await writeFile(join(profile, "outside.txt"), "Never selected.\n", { mode: 0o600 });
const root = await realpath(workspace), file = join(root, "README.md");
await writeFile(join(profile, "native-core/workspace-grants.json"), JSON.stringify([{ path: root, name: "Native picker fixture" }]), { mode: 0o600 });
const resources = join(candidate, "Contents/Resources");
const child = spawn(join(resources, "agent-core/node/bin/node"), [join(resources, "native-desktop-core.mjs"), "--profile-root", profile, "--durable-profile"], { env: { ...process.env, KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let output = "", ready = false, mode = "select", sequence = 0, held, cancelled = false;
const pending = new Map(), dialogs = [];
const receipt = { at: new Date().toISOString(), candidateSha256: fingerprint, simulatedPickerReplies: true, phases: [] };
const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
child.stderr.on("data", chunk => { output += chunk; });
function write(value) { child.stdin.write(JSON.stringify(value) + "\n"); }
createInterface({ input: child.stdout }).on("line", line => {
	try {
		const message = JSON.parse(line);
		if (message.type === "ready") ready = true;
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
try {
	await wait(() => ready, "Native Core did not become ready.");
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
	mode = "hold"; const waiting = request({ type: "select-context-files", workspaceRoot: root }, true).catch(() => undefined);
	await wait(() => held, "The owned pending picker did not start.");
	write({ type: "shutdown" });
	const result = await Promise.race([exit, delay(15_000, undefined, { ref: false }).then(() => { throw new Error("Pending picker prevented shutdown: " + output); })]);
	assert.deepEqual(result, { code: 0, signal: null }, output); assert(cancelled, "Shutdown must cancel the private picker.");
	for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ ok: false, error: "Fixture owner stopped." }); } pending.clear(); await waiting;
	assert(!(await readdir(join(profile, "native-core"))).some(name => name.startsWith("composer-attachments-")));
	assert.equal(await candidateDigest(candidate), fingerprint);
	receipt.phases.push({ phase: "private-Core-pending-picker-cancellation-and-generated-context-cleanup", passed: true });
	await mkdir(".tmp/native-context-dialog-evidence", { recursive: true });
	await writeFile(".tmp/native-context-dialog-evidence/receipt.json", JSON.stringify(receipt, null, 2));
	console.log("Native private context picker protocol, cancellation, file ownership and shutdown passed. Cocoa UI was not exercised.");
} finally {
	if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
	for (const item of pending.values()) clearTimeout(item.timer);
	await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
