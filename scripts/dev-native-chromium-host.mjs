import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");

export function isNativeDevSource(filename) {
	if (!filename) return false;
	const parts = String(filename).replaceAll("\\", "/").split("/");
	if (parts.some((part) => [".git", ".tmp", "release", "node_modules", "dist", "out", "coverage", ".cache"].includes(part))) return false;
	if (parts.some((part) => part.endsWith(".tmp") || part.endsWith("~") || part.endsWith(".swp"))) return false;
	if (parts.join("/") === "apps/desktop/build/agent-core-sidecar.cjs") return false;
	return ["apps", "packages", "scripts"].includes(parts[0]) ||
		["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"].includes(parts.join("/"));
}

function groupExists(pid) {
	try { process.kill(-pid, 0); return true; }
	catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function signalGroup(pid, signal) {
	try { process.kill(-pid, signal); }
	catch (error) { if (error.code !== "ESRCH") throw error; }
}

function exited(child) {
	return new Promise((resolveExit) => {
		child.once("error", (error) => resolveExit({ code: 1, error }));
		child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
	});
}

// Give the native host its normal shutdown path first (Core relay + CefShutdown).
// Reap any surviving group members before replacing files or deleting a profile.
export async function stopNativeDevProcess(child, { graceMs = 15_000, requireCleanExit = true } = {}) {
	if (!child?.pid) return;
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	const deadline = Date.now() + graceMs;
	while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
	if (groupExists(child.pid)) signalGroup(child.pid, "SIGTERM");
	const helpersDeadline = Date.now() + Math.min(graceMs, 2_000);
	while (groupExists(child.pid) && Date.now() < helpersDeadline) await delay(25);
	if (groupExists(child.pid)) {
		signalGroup(child.pid, "SIGKILL");
		const killDeadline = Date.now() + 2_000;
		while (groupExists(child.pid) && Date.now() < killDeadline) await delay(25);
		if (groupExists(child.pid)) {
			const error = new Error("Native development process group did not stop; refusing to rebuild or remove its profile.");
			error.code = "NATIVE_DEV_STOP_FAILED";
			throw error;
		}
	}
	if (requireCleanExit && (child.signalCode !== null || child.exitCode !== 0)) {
		const error = new Error(`Native development host did not confirm an orderly shutdown (exit=${child.exitCode ?? "unknown"}, signal=${child.signalCode ?? "none"}); refusing to rebuild or remove its profile.`);
		error.code = "NATIVE_DEV_STOP_FAILED";
		throw error;
	}
}

// Dependency injection keeps lifecycle tests independent of CEF and real profiles.
export async function runNativeDevLoop({ build, launch, subscribe, stop = stopNativeDevProcess, once = false, debounceMs = 250, log = console.error, signals = process }) {
	let child;
	let pending = true;
	let closing = false;
	let timer;
	let wake;
	let failed = false;
	const notify = () => { wake?.(); wake = undefined; };
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(() => { pending = true; notify(); }, debounceMs);
	};
	const shutdown = () => { closing = true; clearTimeout(timer); notify(); };
	const unsubscribe = once ? () => {} : subscribe(changed, (error) => { log(error); failed = true; shutdown(); });
	signals.on("SIGINT", shutdown);
	signals.on("SIGTERM", shutdown);
	try {
		while (!closing) {
			if (!pending) { await new Promise((resolveWake) => { wake = resolveWake; }); continue; }
			pending = false;
			await stop(child);
			child = undefined;
			if (closing) break;
			try {
				// build receives a cancellation hook because synchronous compiler steps
				// run in a separate process group, never in the watcher itself.
				const app = await build({ cancelled: () => closing, signals });
				if (closing) break;
				child = launch(app);
				const current = child;
				current.done.then((result) => {
					if (child !== current || closing) return;
					if (once) { failed = result.code !== 0; shutdown(); }
					else if (result.code !== 0 || result.signal) {
						failed = true;
						log(`Native Chromium exited unexpectedly (${result.signal ?? result.code}); preserving its profile.`);
						shutdown();
					} else log("Native Chromium closed. Waiting for a source change.");
					notify();
				});
			} catch (error) {
				if (error.code === "NATIVE_DEV_STOP_FAILED") throw error;
				if (!closing) log(`Native Chromium build failed: ${error.message}`);
				if (once) { failed = !closing; shutdown(); }
			}
		}
	} finally {
		closing = true;
		clearTimeout(timer);
		unsubscribe();
		try { await stop(child); }
		finally {
			signals.off("SIGINT", shutdown);
			signals.off("SIGTERM", shutdown);
		}
	}
	return failed ? 1 : 0;
}

async function buildInWorker({ cancelled, signals }) {
	const worker = spawn(process.execPath, [script, ...process.argv.slice(2), "--build-worker"], { cwd: root, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
	let finished = false;
	const done = exited(worker).then((result) => { finished = true; return result; });
	let app;
	worker.on("message", (message) => { if (typeof message.app === "string") app = message.app; });
	const abort = () => { signalGroup(worker.pid, "SIGTERM"); };
	signals.on("SIGINT", abort);
	signals.on("SIGTERM", abort);
	try {
		if (cancelled()) abort();
		// A signal handler alone cannot interrupt execFileSync in the worker.
		// Kill its group after the grace period even if the build ignores TERM.
		let cancelDeadline;
		while (!finished) {
			if (cancelled()) {
				cancelDeadline ??= Date.now() + 2_000;
				if (Date.now() >= cancelDeadline) signalGroup(worker.pid, "SIGKILL");
			}
			await Promise.race([done, delay(25)]);
		}
		const result = await done;
		if (result.code !== 0 || !app) throw result.error ?? new Error(`Build worker exited (${result.signal ?? result.code}).`);
		return app;
	} finally {
		signals.off("SIGINT", abort);
		signals.off("SIGTERM", abort);
		// A failed build is recoverable in watch mode. The process-group check
		// still guarantees all compiler descendants are gone before retrying.
		await stopNativeDevProcess(worker, { graceMs: 2_000, requireCleanExit: false });
	}
}

async function main() {
	if (process.argv.includes("--build-worker")) {
		const { buildNativeChromiumHost } = await import("./build-native-chromium-host.mjs");
		const app = await buildNativeChromiumHost();
		process.send?.({ app });
		process.disconnect?.();
		return;
	}
	const extensionWorkbench = process.argv.includes("--extensions");
	const durableProfile = process.argv.includes("--durable");
	const profile = durableProfile
		? join(homedir(), "Library", "Application Support", "Kestrel Native", "Development")
		: await mkdtemp(join(tmpdir(), "kestrel-native-chromium-dev-"));
	await mkdir(profile, { recursive: true, mode: 0o700 });
	console.log(`Using ${durableProfile ? "durable isolated" : "disposable isolated"} native profile at ${profile}`);
	let safelyStopped = false;
	try {
		process.exitCode = await runNativeDevLoop({
			once: process.argv.includes("--once"),
			build: buildInWorker,
			launch: (app) => {
				const child = spawn(join(app, "Contents", "MacOS", "Kestrel"), [
					"--kestrel-cache-path", profile,
					...(extensionWorkbench ? ["--kestrel-extension-workbench"] : ["--kestrel-chromium-desktop", ...(durableProfile ? ["--kestrel-durable-profile"] : [])]),
				], { stdio: "inherit", detached: true });
				child.done = exited(child);
				return child;
			},
			subscribe: (changed, failed) => {
				const watcher = watch(root, { recursive: true }, (_event, filename) => { if (isNativeDevSource(filename)) changed(); });
				watcher.on("error", failed);
				return () => watcher.close();
			},
		});
		safelyStopped = true;
	} finally {
		if (!durableProfile && safelyStopped) await rm(profile, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === script) await main();
