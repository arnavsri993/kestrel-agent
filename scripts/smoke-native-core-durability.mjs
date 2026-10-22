import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const app = process.env.KESTREL_NATIVE_TEST_APP
	? resolve(process.env.KESTREL_NATIVE_TEST_APP)
	: await buildNativeChromiumHost();
const resources = join(app, "Contents", "Resources");
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-core-durability-"));
const children = new Set();
const ownedCorePids = new Set();

function start() {
	const child = spawn(join(resources, "agent-core", "node", "bin", "node"),
		[join(resources, "native-core-relay.mjs"), "--profile-root", profile, "--durable-profile"],
		{ stdio: ["pipe", "pipe", "pipe"] });
	children.add(child);
	const messages = [];
	let output = "";
	const readers = new Set();
	createInterface({ input: child.stdout }).on("line", (line) => {
		try { messages.push(JSON.parse(line)); } catch { output += "Invalid relay JSON\n"; }
		for (const read of readers) read();
	});
	child.stderr.on("data", (chunk) => { output += chunk; });
	child.once("error", (error) => { output += error.message; for (const read of readers) read(); });
	const exited = new Promise((resolveExit) => child.once("exit", (code) => {
		children.delete(child);
		resolveExit(code);
		for (const read of readers) read();
	}));
	function waitFor(predicate) {
		return new Promise((resolveWait, rejectWait) => {
			const finish = (error, result) => {
				clearTimeout(timeout);
				readers.delete(check);
				if (error) rejectWait(error); else resolveWait(result);
			};
			const check = () => {
				const result = messages.find(predicate);
				if (result) finish(undefined, result);
				else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`Native relay exited before response: ${output}`));
			};
			const timeout = setTimeout(() => finish(new Error(`Native relay response timed out: ${output}`)), 20_000);
			readers.add(check);
			check();
		});
	}
	let requestId = 0;
	return {
		ready: () => waitFor((message) => message.type === "ready"),
		async request(request) {
			const id = `durability-${++requestId}`;
			child.stdin.write(JSON.stringify({ type: "request", id, request }) + "\n");
			const message = await waitFor((message) => message.type === "response" && message.id === id);
			assert.equal(message.response?.ok, true, JSON.stringify(message.response));
			return message.response;
		},
		async stop() {
			child.stdin.end(JSON.stringify({ type: "shutdown" }) + "\n");
			assert.equal(await exited, 0, output);
		},
		async closeOutput() {
			child.stdout.destroy();
			child.stdin.write(JSON.stringify({ type: "request", id: "closed-host-pipe", request: { type: "snapshot" } }) + "\n");
			const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			try { assert.equal(await exited, 0, output); } finally { clearTimeout(timer); }
		},
		crash: async () => {
			const processes = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
			assert.equal(processes.status, 0);
			const corePids = processes.stdout.trim().split("\n").flatMap((row) => {
				const [pid, ppid] = row.trim().split(/\s+/).map(Number);
				return ppid === child.pid ? [pid] : [];
			});
			assert.equal(corePids.length, 1, "The relay must own exactly one Node Core.");
			corePids.forEach((pid) => ownedCorePids.add(pid));
			child.kill("SIGKILL");
			await exited;
			for (const pid of corePids) {
				let exited = false;
				for (let attempt = 0; attempt < 100; attempt++) {
					try { process.kill(pid, 0); } catch (error) {
						if (error.code !== "ESRCH") throw error;
						exited = true;
						break;
					}
					await delay(50);
				}
				assert.equal(exited, true, "Core must stop when its relay IPC disconnects.");
				ownedCorePids.delete(pid);
			}
		},
	};
}

try {
	const first = start();
	await first.ready();
	const created = await first.request({ type: "runtime-create-session", title: "Native durable conversation", kind: "conversation" });
	assert.ok(created.session?.id);
	const keyPath = join(profile, "native-core", "database.key");
	const key = await readFile(keyPath);
	await first.stop();
	const second = start();
	await second.ready();
	const restored = await second.request({ type: "runtime-list-sessions" });
	assert.ok(restored.sessions?.some((session) => session.id === created.session.id && session.title === "Native durable conversation"));
	assert.deepEqual(await readFile(keyPath), key);
	await second.crash();
	const recovered = start();
	await recovered.ready();
	const afterCrash = await recovered.request({ type: "runtime-list-sessions" });
	assert.ok(afterCrash.sessions?.some((session) => session.id === created.session.id));
	assert.deepEqual(await readFile(keyPath), key);
	await recovered.closeOutput();
	const final = start();
	await final.ready();
	const afterHostClose = await final.request({ type: "runtime-list-sessions" });
	assert.ok(afterHostClose.sessions?.some((session) => session.id === created.session.id));
	await final.stop();
	console.log("Native Core durability: conversation + database key survive normal restart, relay crash and closed host pipe; no Electron profile or Keychain access.");
} finally {
	for (const child of children) child.kill("SIGTERM");
	for (const pid of ownedCorePids) { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
	await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
