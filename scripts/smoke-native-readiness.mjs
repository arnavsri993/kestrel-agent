// Disposable private-Core protocol canary; it does not launch a window or run inference.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Supply an explicit disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "The canary must not use an installed app.");
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-readiness-")));
const protectedKeyBase64 = randomBytes(32).toString("base64");
const resources = join(candidate, "Contents/Resources");
const child = spawn(join(resources, "agent-core/node/bin/node"), [join(resources, "native-desktop-core.mjs"), "--profile-root", profile, "--browser-profile-root", profile, "--durable-profile"], {
  env: { ...process.env, KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" }, stdio: ["pipe", "pipe", "pipe"],
});
let ready = false, output = "", resolveResponse, permissionRequests = 0, protocolFailure;
let reportProtocolFailure;
const protocolFailureSignal = new Promise(resolve => { reportProtocolFailure = resolve; });
const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
child.stderr.on("data", chunk => { output += chunk; });
createInterface({ input: child.stdout }).on("line", line => {
	let message;
	try { message = JSON.parse(line); }
	catch { failProtocol("unexpected non-JSON stdout frame"); return; }
	if (message.kind === "native-core-profile-key-request") child.stdin.write(JSON.stringify({ kind: "native-core-profile-key-response", requestId: message.requestId, ok: true, keyBase64: protectedKeyBase64 }) + "\n");
	else if (message.type === "ready") ready = true;
	else if (message.type === "response" && message.id === "readiness-canary") resolveResponse?.(message.response);
	else if (message.type === "browser-backend-reset") child.stdin.write(JSON.stringify({ type: "browser-backend-reset-response", requestId: message.requestId, ok: true }) + "\n");
	else if (message.type === "native-computer-request") {
		if (message.request?.operation === "native-computer-permissions" && typeof message.requestId === "string") {
			permissionRequests++;
			child.stdin.write(JSON.stringify({
				type: "native-computer-response",
				requestId: message.requestId,
				ok: true,
				result: { screenRecording: "unavailable", accessibility: "unavailable" },
			}) + "\n");
		} else {
			if (typeof message.requestId === "string") child.stdin.write(JSON.stringify({
				type: "native-computer-response",
				requestId: message.requestId,
				ok: false,
				error: "Unexpected native computer operation in readiness canary.",
			}) + "\n");
			failProtocol(`unexpected native computer operation: ${boundedLabel(message.request?.operation)}`);
		}
	} else failProtocol(`unexpected protocol message: ${boundedLabel(message.type ?? message.kind)}`);
});

function boundedLabel(value) {
	return typeof value === "string" ? value.replace(/[^a-zA-Z0-9_.-]/g, "?").slice(0, 80) || "empty" : "missing";
}

function failProtocol(reason) {
	if (protocolFailure) return;
	protocolFailure = reason.slice(0, 160);
	reportProtocolFailure(protocolFailure);
}
try {
  for (const end = Date.now() + 20_000; !ready && Date.now() < end;) { assert.equal(child.exitCode, null, output); await delay(25); }
  assert.equal(protocolFailure, undefined, `Native Core protocol failure: ${protocolFailure}`);
  assert(ready, `Native Core did not become ready: ${output}`);
  const response = new Promise(resolve => { resolveResponse = resolve; });
  child.stdin.write(JSON.stringify({ type: "host-request", id: "readiness-canary", request: { type: "system-readiness" } }) + "\n");
  const result = await Promise.race([response, protocolFailureSignal.then(reason => { throw new Error(`Native Core protocol failure: ${reason}`); }), delay(20_000, undefined, { ref: false }).then(() => { throw new Error(`Readiness timed out: ${output}`); })]);
  assert.equal(protocolFailure, undefined, `Native Core protocol failure: ${protocolFailure}`);
  assert.equal(permissionRequests, 1, "Readiness must request the owner's synthetic permission status exactly once.");
  assert.equal(result.ok, true);
  assert.equal(result.systemReadiness.readyForLiveWork, false);
  const checks = new Map(result.systemReadiness.checks.map(check => [check.id, check]));
  assert.equal(checks.get("core")?.status, "pass");
  assert.match(checks.get("workspace")?.detail, /No project folder is granted/);
  assert.equal(checks.get("distribution")?.status, "fail");
  assert(checks.get("models") && checks.get("local-model"));
  assert.equal(checks.get("computer-use")?.status, "warning");
  assert.match(checks.get("computer-use")?.detail, /Disabled by default/);
  child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
  assert.deepEqual(await Promise.race([exit, delay(15_000, undefined, { ref: false }).then(() => { throw new Error(`Shutdown timed out: ${output}`); })]), { code: 0, signal: null });
  console.log("Disposable native Core readiness protocol passed with synthetic unavailable permission status; no GUI, OS permission query, inference or canonical profile was used.");
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
