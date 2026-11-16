import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isNativeDevSource, runNativeDevLoop, stopNativeDevProcess } from "../../../scripts/dev-native-chromium-host.mjs";

async function until(predicate) {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "lifecycle operation timed out");
		await delay(5);
	}
}

function fixture(overrides = {}) {
	const signals = new EventEmitter();
	const events = [];
	let change;
	let closeCount = 0;
	let nextId = 0;
	const loop = runNativeDevLoop({
		signals, debounceMs: 15, log: () => {},
		subscribe: (callback) => { change = callback; return () => { closeCount++; }; },
		build: async () => { events.push("build"); return "/same/app"; },
		launch: () => {
			const id = ++nextId;
			events.push(`launch ${id}`);
			return { id, done: new Promise(() => {}) };
		},
		stop: async (child) => { if (child) { events.push(`stop ${child.id}`); await delay(10); events.push(`stopped ${child.id}`); } },
		...overrides,
	});
	return { signals, events, loop, change: () => change(), closeCount: () => closeCount };
}

test("source filter includes native, renderer, Core, scripts and manifests; ignores generated outputs", () => {
	for (const path of ["apps/native-chromium-host/src/main.mm", "apps/desktop/src/renderer/App.tsx", "packages/core/src/index.ts", "scripts/build-native-ui.mjs", "package.json"]) assert.equal(isNativeDevSource(path), true, path);
	for (const path of [".tmp/app/file", "release/Kestrel.app", "node_modules/foo", "packages/core/dist/file.js", "apps/desktop/out/main.js", "apps/desktop/build/agent-core-sidecar.cjs", "scripts/foo.mjs.tmp", "apps/foo/.cache/output", ".git/index", undefined]) assert.equal(isNativeDevSource(path), false, String(path));
});

test("debounces changes and completes shutdown before rebuilding", async () => {
	const f = fixture();
	await until(() => f.events.includes("launch 1"));
	f.change(); f.change(); f.change();
	await until(() => f.events.includes("launch 2"));
	assert.deepEqual(f.events.slice(0, 6), ["build", "launch 1", "stop 1", "stopped 1", "build", "launch 2"]);
	f.signals.emit("SIGINT");
	assert.equal(await f.loop, 0);
	assert.equal(f.closeCount(), 1);
	assert.equal(f.signals.listenerCount("SIGINT"), 0);
	assert.deepEqual(f.events.slice(-2), ["stop 2", "stopped 2"]);
});

test("initial build failure remains watchable and recovers on edit", async () => {
	let attempts = 0;
	const f = fixture({ build: async () => { if (++attempts === 1) throw new Error("compile failed"); return "/app"; } });
	await until(() => attempts === 1);
	f.change();
	await until(() => f.events.includes("launch 1"));
	f.signals.emit("SIGTERM");
	assert.equal(await f.loop, 0);
	assert.equal(attempts, 2);
});

test("SIGTERM during build prevents launch and unsubscribes watcher", async () => {
	let finish;
	const f = fixture({ build: () => new Promise((resolve) => { finish = resolve; }) });
	await until(() => finish);
	f.change();
	f.signals.emit("SIGTERM");
	finish("/app");
	assert.equal(await f.loop, 0);
	assert.equal(f.events.filter((event) => event.startsWith("launch")).length, 0);
	assert.equal(f.closeCount(), 1);
});

test("once mode reports initial build failure and never subscribes", async () => {
	const f = fixture({ once: true, subscribe: () => { assert.fail("unexpected watcher"); }, build: async () => { throw new Error("failure"); } });
	assert.equal(await f.loop, 1);
	assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("once mode preserves child exit status as failure", async () => {
	const f = fixture({ once: true, launch: () => ({ done: Promise.resolve({ code: 5 }) }) });
	assert.equal(await f.loop, 1);
});

test("real detached native-like process gets graceful shutdown before stop resolves", async () => {
	const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 60)); process.send("ready"); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	try {
		await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
		await stopNativeDevProcess(child, { graceMs: 1_000 });
		assert.equal(child.exitCode, 0);
		assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); }
});

test("failed native host shutdown refuses success so its profile is preserved", async () => {
	const child = spawn(process.execPath, ["-e", 'process.send("ready"); setTimeout(() => process.exit(7), 50);'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	try {
		await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
		await delay(100);
		await assert.rejects(stopNativeDevProcess(child, { graceMs: 1_000 }), { code: "NATIVE_DEV_STOP_FAILED" });
		await stopNativeDevProcess(child, { graceMs: 1_000, requireCleanExit: false });
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); }
});

test("changes arriving during build queue one serial rebuild", async () => {
	let finish;
	let attempts = 0;
	const f = fixture({ build: async () => { attempts++; if (attempts === 1) await new Promise((resolve) => { finish = resolve; }); return "/same/app"; } });
	await until(() => finish);
	f.change(); f.change();
	await delay(35);
	assert.equal(attempts, 1);
	finish();
	await until(() => f.events.includes("launch 2"));
	assert.equal(attempts, 2);
	assert.deepEqual(f.events.slice(0, 4), ["launch 1", "stop 1", "stopped 1", "launch 2"]);
	f.signals.emit("SIGTERM");
	await f.loop;
});

test("process-group cleanup shuts down surviving native-like helpers", async () => {
	const source = `
		const { spawn } = require("node:child_process");
		const helper = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => process.exit(0)); process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
		helper.once("message", () => process.send({ helper: helper.pid }));
		process.on("SIGTERM", () => { helper.once("exit", () => process.exit(0)); });
		setInterval(() => {}, 1000);
	`;
	const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	try {
		const { helper } = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
		await stopNativeDevProcess(child, { graceMs: 100 });
		assert.throws(() => process.kill(helper, 0), { code: "ESRCH" });
		assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
	} finally { if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }
});
