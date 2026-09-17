import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const app = await buildNativeChromiumHost();
const resources = join(app, "Contents", "Resources");
const node = join(resources, "agent-core", "node", "bin", "node");
const relay = join(resources, "native-core-relay.mjs");
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-core-relay-"));
let child;
let output = "";

function waitFor(messages, predicate, description) {
	return new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(
			() =>
				rejectPromise(
					new Error(
						"Timed out waiting for " + description + ": " + output,
					),
				),
			20_000,
		);
		const check = () => {
			const match = messages.find(predicate);
			if (!match) return;
			clearTimeout(timeout);
			resolvePromise(match);
		};
		check();
		const interval = setInterval(() => {
			check();
			if (messages.some(predicate)) clearInterval(interval);
		}, 10);
	});
}

try {
	child = spawn(node, [relay, "--profile-root", profile], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	const messages = [];
	child.stdout.on("data", (chunk) => {
		output += chunk;
		for (const line of chunk.trim().split("\n")) {
			if (!line) continue;
			messages.push(JSON.parse(line));
		}
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const ready = await waitFor(
		messages,
		(message) => message.type === "ready",
		"the native Core relay",
	);
	assert.equal(ready.type, "ready");
	child.stdin.write(
		JSON.stringify({
			type: "request",
			id: "unsupported-host-request",
			request: { type: "browser-get-state" },
		}) + "\n",
	);
	const unsupported = await waitFor(
		messages,
		(message) =>
			message.type === "response" &&
			message.id === "unsupported-host-request",
		"the native Core rejection for an unsupported host request",
	);
	assert.equal(unsupported.response?.ok, false);
	assert.match(unsupported.response?.error ?? "", /unsupported request/);
	child.stdin.write(
		JSON.stringify({
			type: "request",
			id: "snapshot",
			request: { type: "snapshot" },
		}) + "\n",
	);
	const snapshot = await waitFor(
		messages,
		(message) => message.type === "response" && message.id === "snapshot",
		"the native Core snapshot",
	);
	assert.equal(snapshot.response?.ok, true);
	assert.ok(snapshot.response?.snapshot);
	child.stdin.write(
		JSON.stringify({
			type: "request",
			id: "sessions",
			request: { type: "runtime-list-sessions" },
		}) + "\n",
	);
	const sessions = await waitFor(
		messages,
		(message) => message.type === "response" && message.id === "sessions",
		"the native Core session list",
	);
	assert.equal(sessions.response?.ok, true);
	child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
	const exitCode = await new Promise((resolvePromise) => {
		child.once("exit", (code) => resolvePromise(code));
	});
	assert.equal(exitCode, 0, output);
	console.log(
		"Native Chromium Core relay: standalone Node Core bootstrap, snapshot, sessions, and orderly shutdown passed.",
	);
} finally {
	if (child && child.exitCode === null) child.kill("SIGTERM");
	await rm(profile, { recursive: true, force: true });
}
