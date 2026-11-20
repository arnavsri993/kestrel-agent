#!/usr/bin/env node
// Exercises the real broker -> Core -> broker -> fake parent private-pipe
// bootstrap. The injected parent key is test-only; no Keychain API is called.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const supplied = process.env.KESTREL_NATIVE_TEST_APP?.trim();
assert(supplied, "Set KESTREL_NATIVE_TEST_APP to a disposable development candidate.");
const candidate = await realpath(resolve(supplied));
assert(!candidate.startsWith("/Applications/"), "The broker protocol canary cannot use an installed app.");
const resources = join(candidate, "Contents", "Resources");
const bundledNode = join(resources, "agent-core", "node", "bin", "node");
const brokerEntry = join(resources, "native-ui-broker.mjs");
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-broker-key-")));
const protectedKeyBase64 = randomBytes(32).toString("base64");
const child = spawn(bundledNode, [brokerEntry, "--profile-root", profile,
	"--browser-pid", String(process.pid), "--durable-profile"], {
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" },
});
let output = "";
let parentReadySent = false;
let keyRequestSeen = false;
let keyResponseSent = false;
let startupInfoSeen = false;
const lines = createInterface({ input: child.stdout });
const exited = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => { output = (output + chunk).slice(-24_000); });
function send(message) {
	assert(child.stdin.writable && child.exitCode === null, "Broker exited before the private key exchange completed.");
	child.stdin.write(JSON.stringify(message) + "\n");
}
const startup = new Promise((resolveStartup, rejectStartup) => {
	const timer = setTimeout(() => rejectStartup(new Error(`Broker did not return startup metadata: ${output}`)), 20_000);
	lines.on("line", line => {
		let message;
		try { message = JSON.parse(line); }
		catch { rejectStartup(new Error("Broker returned invalid JSON.")); return; }
		if (message.extensionRoot && message.extensionId) {
			startupInfoSeen = true;
			clearTimeout(timer);
			assert.equal(parentReadySent, false);
			send({ kind: "native-desktop-parent-ready" });
			parentReadySent = true;
			resolveStartup(message);
			return;
		}
		if (message.kind === "native-core-profile-key-request") {
			assert.equal(startupInfoSeen, true, "Core key request preceded the parent's initial startup read.");
			assert.equal(parentReadySent, true, "Core key request preceded the parent-ready acknowledgment.");
			assert.equal(keyRequestSeen, false, "Broker duplicated the Core key request.");
			assert.equal(message.requestId, "native-core-profile-key-v1");
			keyRequestSeen = true;
			send({ kind: "native-core-profile-key-response", requestId: message.requestId,
				ok: true, keyBase64: protectedKeyBase64 });
			keyResponseSent = true;
		}
	});
	child.once("exit", () => { clearTimeout(timer); rejectStartup(new Error(`Broker exited before startup metadata: ${output}`)); });
});

try {
	const info = await startup;
	assert.equal(typeof info.extensionId, "string");
	const databasePath = join(profile, "native-core", "database", "kestrel.sqlite");
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		assert.equal(child.exitCode, null, `Broker/Core exited during key bootstrap: ${output}`);
		if (keyRequestSeen && keyResponseSent && await stat(databasePath).then(value => value.isFile(), () => false)) break;
		await delay(50);
	}
	assert(keyRequestSeen && keyResponseSent, "Broker did not complete both sides of the protected-key exchange.");
	assert(await stat(databasePath).then(value => value.isFile(), () => false), `Core did not open the durable database: ${output}`);
	child.kill("SIGTERM");
	assert.deepEqual(await Promise.race([exited, delay(10_000).then(() => { throw new Error(`Broker/Core shutdown timed out: ${output}`); })]), { code: 0, signal: null });
	console.log("Native UI broker/Core private key bootstrap passed with a fake parent key; startup ordering and database open were verified. Real Keychain access was not exercised.");
} finally {
	lines.close();
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
	await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
