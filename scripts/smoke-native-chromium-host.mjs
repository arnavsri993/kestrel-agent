import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = await buildNativeChromiumHost();
const executable = join(app, "Contents", "MacOS", "Kestrel");
// Older CEF builds started GCM registration shortly after startup, after the
// host-ready marker. Keep each clean-profile instance alive long enough to
// prove that the bundled runtime remains quiet after its UI and Core relay are
// both active.
const backgroundRegistrationObservationMs = 15_000;
const missingProfile = spawnSync(executable, [], {
	encoding: "utf8",
	timeout: 10_000,
});
assert.equal(
	missingProfile.status,
	1,
	`Native Chromium host must reject an implicit profile: ${missingProfile.stdout}${missingProfile.stderr}`,
);
assert.match(
	`${missingProfile.stdout}${missingProfile.stderr}`,
	/requires an explicit isolated profile path/,
);
const directProfile = await mkdtemp(
	join(tmpdir(), "kestrel-native-chromium-direct-profile-"),
);
// The bridge path creates native BrowserViews from an asynchronous CEF
// message-router callback. Exercise it repeatedly so teardown races cannot
// hide behind a one-shot smoke pass.
const bridgeProfiles = await Promise.all(
	Array.from({ length: 3 }, () =>
		mkdtemp(join(tmpdir(), "kestrel-native-chromium-bridge-profile-")),
	),
);
let directUserBrowserRequests = 0;
let bridgeUserBrowserRequests = 0;
const userBrowserServer = createServer((request, response) => {
	if (request.url === "/native-user-browser-direct-smoke") {
		directUserBrowserRequests += 1;
	} else if (request.url === "/native-user-browser-bridge-smoke") {
		bridgeUserBrowserRequests += 1;
	}
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end("<!doctype html><title>Kestrel native browser smoke</title><p>CEF user browser loaded</p>");
});
await new Promise((resolvePromise, rejectPromise) => {
	userBrowserServer.once("error", rejectPromise);
	userBrowserServer.listen(0, "127.0.0.1", resolvePromise);
});
const serverAddress = userBrowserServer.address();
assert(serverAddress && typeof serverAddress !== "string");
const directUserBrowserUrl = `http://127.0.0.1:${serverAddress.port}/native-user-browser-direct-smoke`;
const bridgeUserBrowserUrl = `http://127.0.0.1:${serverAddress.port}/native-user-browser-bridge-smoke`;

function processTree(rootPid) {
	const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
			return match
				? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
				: undefined;
		})
		.filter(Boolean);
	const descendants = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
				descendants.add(row.pid);
				changed = true;
			}
		}
	}
	return rows.filter((row) => descendants.has(row.pid));
}
const activeChildren = new Set();

async function startNativeHost(args, requiredMarkers, label) {
	let output = "";
	const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
	activeChildren.add(child);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	child.once("exit", () => activeChildren.delete(child));
	const isReady = () => requiredMarkers.every((marker) => output.includes(marker));
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(
			() => rejectPromise(new Error(`Timed out waiting for ${label}: ${output}`)),
			20_000,
		);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		child.stdout.on("data", () => {
			if (isReady()) {
				clearTimeout(timeout);
				resolvePromise();
			}
		});
		child.once("exit", (code) => {
			if (!isReady()) {
				clearTimeout(timeout);
				rejectPromise(new Error(`Native Chromium host exited ${code}: ${output}`));
			}
		});
	});
	return {
		child,
		output: () => output,
		waitForExit: () => child.exitCode ?? new Promise((resolvePromise) => {
			child.once("exit", (code) => resolvePromise(code));
		}),
	};
}

function assertHostSecurity(output, label) {
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_HOST_READY pid=\d+ credential_storage=disabled background_networking=disabled/,
		`${label} must avoid Keychain and background networking: ${output}`,
	);
	assert.doesNotMatch(
		output,
		/PHONE_REGISTRATION_ERROR|Registration response error/,
		`${label} must not start background account registration: ${output}`,
	);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY/,
		`${label} must install the local CEF bridge: ${output}`,
	);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_CORE_READY/,
		`${label} must start the standalone Node Core relay: ${output}`,
	);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK/,
		`${label} must receive a real Core snapshot: ${output}`,
	);
}

function assertSandboxedWorkers(child, label) {
	const descendants = processTree(child.pid);
	const chromiumWorkers = descendants.filter((row) =>
		/Kestrel Helper.*--type=(renderer|gpu-process|utility)/.test(row.command),
	);
	assert(
		chromiumWorkers.length > 0,
		`${label} expected a Chromium renderer, GPU, or utility child: ${JSON.stringify(descendants)}`,
	);
	assert(
		chromiumWorkers.every((row) => /--seatbelt-client=\d+/.test(row.command)),
		`${label} expected sandboxed Chromium workers: ${JSON.stringify(chromiumWorkers)}`,
	);
	assert(
		chromiumWorkers.every((row) => !/--(?:kestrel-allow-)?no-sandbox\b/.test(row.command)),
		`${label} must never use the no-sandbox escape hatch: ${JSON.stringify(chromiumWorkers)}`,
	);
}

function assertFullRendererSetupStatus(output) {
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_CREDENTIAL_STATUS_EMPTY/,
		`The native full renderer must receive an empty credential status without Keychain: ${output}`,
	);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_SUBSCRIPTION_CLI_STATUS_EMPTY/,
		`The native full renderer must receive an empty subscription CLI status without an auth probe: ${output}`,
	);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_LOCAL_MODEL_STATUS_DEFERRED/,
		`The native full renderer must receive an explicit deferred local-runtime status: ${output}`,
	);
}

try {
	const direct = await startNativeHost(
		[
			"--kestrel-cache-path",
			directProfile,
			"--kestrel-ephemeral-core",
			"--kestrel-renderer",
			"--kestrel-smoke-user-browser-url",
			directUserBrowserUrl,
			"--kestrel-exit-after-ready-ms",
			String(backgroundRegistrationObservationMs),
		],
		[
			"KESTREL_NATIVE_CHROMIUM_HOST_READY",
			"KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY",
			"KESTREL_NATIVE_CHROMIUM_CORE_READY",
			"KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK",
			"KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK",
		],
		"the full Kestrel renderer smoke",
	);
	let directOutput = direct.output();
	assert.match(
		directOutput,
		/KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK url=http:\/\/127\.0\.0\.1:\d+\/native-user-browser-direct-smoke/,
		`Native Chromium host must load a page through a separate CEF user browser: ${directOutput}`,
	);
	assert.equal(
		directUserBrowserRequests > 0,
		true,
		"The native CEF user browser must make a real request to the local smoke server.",
	);
	assertSandboxedWorkers(direct.child, "The full Kestrel renderer smoke");
	assert.equal(await direct.waitForExit(), 0, direct.output());
	directOutput = direct.output();
	assertHostSecurity(directOutput, "The full Kestrel renderer smoke");
	assertFullRendererSetupStatus(directOutput);

	for (const [index, bridgeProfile] of bridgeProfiles.entries()) {
		const label = `the static-shell bridge browser smoke #${index + 1}`;
		const bridge = await startNativeHost(
		[
			"--kestrel-cache-path",
			bridgeProfile,
			"--kestrel-ephemeral-core",
			"--kestrel-smoke-bridge-user-browser-url",
			bridgeUserBrowserUrl,
			"--kestrel-exit-after-ready-ms",
			String(backgroundRegistrationObservationMs),
		],
		[
			"KESTREL_NATIVE_CHROMIUM_HOST_READY",
			"KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY",
			"KESTREL_NATIVE_CHROMIUM_CORE_READY",
			"KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK",
			"KESTREL_NATIVE_CHROMIUM_BRIDGE_BROWSER_REQUEST_OK",
			"KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK",
		],
		label,
	);
	let bridgeOutput = bridge.output();
	assert.match(
		bridgeOutput,
		/KESTREL_NATIVE_CHROMIUM_BRIDGE_BROWSER_REQUEST_OK/,
		`The local CEF bridge must create the native browser tab: ${bridgeOutput}`,
	);
	assert.match(
		bridgeOutput,
		/KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK url=http:\/\/127\.0\.0\.1:\d+\/native-user-browser-bridge-smoke/,
		`The bridge-created CEF tab must load the local page: ${bridgeOutput}`,
	);
	assert.equal(
		bridgeUserBrowserRequests > 0,
		true,
		"The bridge-created native CEF browser must make a real request to the local smoke server.",
	);
	assertSandboxedWorkers(bridge.child, label);
	assert.equal(await bridge.waitForExit(), 0, bridge.output());
	bridgeOutput = bridge.output();
	assertHostSecurity(bridgeOutput, label);
	}
	console.log("Native Chromium host: bundled CEF, isolated profiles, standalone Node Core relay, full Kestrel renderer, bridge-created user tab, sandbox-default process tree, and orderly shutdown passed.");
} finally {
	for (const child of activeChildren) {
		if (child.exitCode === null) child.kill("SIGTERM");
	}
	await new Promise((resolvePromise) => userBrowserServer.close(resolvePromise));
	await rm(directProfile, { recursive: true, force: true });
	await Promise.all(
		bridgeProfiles.map((profile) => rm(profile, { recursive: true, force: true })),
	);
}
