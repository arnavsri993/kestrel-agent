import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
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
	join(tmpdir(), "kestrel-native-browser-backend-"),
);

let pageHits = 0;
const server = createServer((request, response) => {
	if (request.url === "/native-browser-backend-smoke") {
		pageHits += 1;
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			"<!doctype html><title>Kestrel native browser backend</title><p>ok</p>",
		);
		return;
	}
	response.writeHead(404);
	response.end("missing");
});
await new Promise((resolvePromise, rejectPromise) => {
	server.once("error", rejectPromise);
	server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
assert(address && typeof address !== "string");
const pageUrl = `http://127.0.0.1:${address.port}/native-browser-backend-smoke`;

let output = "";
const child = spawn(
	executable,
	[
		"--kestrel-cache-path",
		profile,
		"--kestrel-ephemeral-core",
		"--kestrel-smoke-browser-backend",
		"--kestrel-smoke-browser-backend-url",
		pageUrl,
		"--kestrel-exit-after-ready-ms",
		"20000",
	],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	output += chunk;
});
child.stderr.on("data", (chunk) => {
	output += chunk;
});

try {
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(
			() =>
				rejectPromise(
					new Error(
						`Timed out waiting for native browser backend smoke: ${output}`,
					),
				),
			45_000,
		);
		const check = () => {
			if (
				output.includes("KESTREL_NATIVE_CHROMIUM_BROWSER_BACKEND_OK") &&
				output.includes("KESTREL_NATIVE_CHROMIUM_CORE_READY")
			) {
				clearTimeout(timeout);
				resolvePromise();
			}
		};
		child.stdout.on("data", check);
		child.stderr.on("data", check);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		child.once("exit", (code) => {
			if (
				!output.includes("KESTREL_NATIVE_CHROMIUM_BROWSER_BACKEND_OK")
			) {
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
	assert.equal(code, 0, output);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_BROWSER_BACKEND_OK tabs=[1-9]\d*/,
	);
	assert.doesNotMatch(
		output,
		/Native Chromium browser automation is not migrated yet/,
	);
	assert.equal(
		pageHits > 0,
		true,
		"visible-create through the Core relay must load the smoke page in CEF.",
	);
	console.log(
		"Native Chromium browser backend: Core relay forwards automation to CEF visible tabs (no longer fail-closed).",
	);
} finally {
	if (child.exitCode === null) child.kill("SIGTERM");
	await new Promise((resolvePromise) => server.close(resolvePromise));
	await rm(profile, { recursive: true, force: true });
}
