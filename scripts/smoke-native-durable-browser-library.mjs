import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.KESTREL_NATIVE_TEST_APP
	? resolve(process.env.KESTREL_NATIVE_TEST_APP)
	: await buildNativeChromiumHost();
const executable = join(app, "Contents", "MacOS", "Kestrel");
const profile = await mkdtemp(
	join(tmpdir(), "kestrel-native-durable-browser-library-"),
);
const exitAfterReadyMs = 8_000;

async function runPhase(args, requiredMarkers, label) {
	let output = "";
	const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(
			() =>
				rejectPromise(new Error(`Timed out waiting for ${label}: ${output}`)),
			30_000,
		);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		const check = () => {
			if (requiredMarkers.every((marker) => output.includes(marker))) {
				clearTimeout(timeout);
				resolvePromise();
			}
		};
		child.stdout.on("data", check);
		child.stderr.on("data", check);
		child.once("exit", (code) => {
			if (!requiredMarkers.every((marker) => output.includes(marker))) {
				clearTimeout(timeout);
				rejectPromise(
					new Error(`Native Chromium host exited ${code}: ${output}`),
				);
			}
		});
		check();
	});
	const code = await new Promise((resolvePromise) => {
		if (child.exitCode !== null) {
			resolvePromise(child.exitCode);
			return;
		}
		child.once("exit", (exitCode) => resolvePromise(exitCode));
	});
	assert.equal(code, 0, `${label} exited ${code}: ${output}`);
	return output;
}

try {
	const seedOutput = await runPhase(
		[
			"--kestrel-cache-path",
			profile,
			"--kestrel-ephemeral-core",
			"--kestrel-durable-profile",
			"--kestrel-smoke-durable-library",
			"--kestrel-exit-after-ready-ms",
			String(exitAfterReadyMs),
		],
		[
			"KESTREL_NATIVE_CHROMIUM_HOST_READY",
			"KESTREL_NATIVE_CHROMIUM_DURABLE_PROFILE_ENABLED",
			"KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_WRITE_OK",
		],
		"durable browser library seed",
	);
	assert.match(
		seedOutput,
		/KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_WRITE_OK bookmarks=\d+ history=\d+ downloads=\d+ permissions=\d+/,
	);

	const libraryPath = join(profile, "browser-library.json");
	const persisted = JSON.parse(await readFile(libraryPath, "utf8"));
	assert.equal(persisted.version, 1);
	assert.equal(
		persisted.bookmarks.some(
			(item) => item.url === "https://example.com/kestrel-durable-bookmark",
		),
		true,
	);
	assert.equal(
		persisted.history.some(
			(item) => item.url === "https://example.com/kestrel-durable-history",
		),
		true,
	);
	assert.equal(
		persisted.downloads.some((item) => item.filename === "kestrel-durable.txt"),
		true,
	);
	assert.equal(
		persisted.sitePermissions.some(
			(item) =>
				item.origin === "https://example.com" &&
				item.permission === "notifications" &&
				item.decision === "deny",
		),
		true,
	);

	const restoreOutput = await runPhase(
		[
			"--kestrel-cache-path",
			profile,
			"--kestrel-ephemeral-core",
			"--kestrel-durable-profile",
			"--kestrel-smoke-durable-library-verify",
			"--kestrel-exit-after-ready-ms",
			String(exitAfterReadyMs),
		],
		[
			"KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_LOADED",
			"KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_RESTORE_OK",
		],
		"durable browser library restore",
	);
	assert.match(
		restoreOutput,
		/KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_LOADED bookmarks=\d+ history=\d+ downloads=\d+ permissions=\d+/,
	);
	assert.doesNotMatch(
		restoreOutput,
		/KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_RESTORE_FAILED/,
	);

	console.log(
		"Native Chromium durable browser library: bookmarks, history, downloads, and site permissions survive restart on the isolated profile.",
	);
} finally {
	await rm(profile, { recursive: true, force: true });
}
