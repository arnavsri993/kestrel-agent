import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const app = process.env.KESTREL_NATIVE_TEST_APP
	? resolve(process.env.KESTREL_NATIVE_TEST_APP)
	: await buildNativeChromiumHost();
const executable = join(app, "Contents", "MacOS", "Kestrel");
const profile = await mkdtemp(
	join(tmpdir(), "kestrel-native-isolated-automation-"),
);

let pageHits = 0;
let actHits = 0;
const server = createServer((request, response) => {
	if (request.url === "/native-isolated-automation-smoke") {
		pageHits += 1;
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(`<!doctype html>
<title>Kestrel isolated automation</title>
<button id="smoke-act" type="button">Act</button>
<script>
document.getElementById("smoke-act").addEventListener("click", () => {
  fetch("/native-isolated-act-ok").catch(() => {});
});
</script>`);
		return;
	}
	if (request.url === "/native-isolated-act-ok") {
		actHits += 1;
		response.writeHead(204);
		response.end();
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
const pageUrl = `http://127.0.0.1:${address.port}/native-isolated-automation-smoke`;

let output = "";
const child = spawn(
	executable,
	[
		"--kestrel-cache-path",
		profile,
		"--kestrel-ephemeral-core",
		"--kestrel-smoke-isolated-automation",
		"--kestrel-smoke-isolated-automation-url",
		pageUrl,
		"--kestrel-exit-after-ready-ms",
		"45000",
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
						`Timed out waiting for isolated automation smoke: ${output}`,
					),
				),
			90_000,
		);
		const check = () => {
			if (
				output.includes("KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_OK") &&
				output.includes("KESTREL_NATIVE_CHROMIUM_CORE_READY")
			) {
				clearTimeout(timeout);
				resolvePromise();
			}
			if (output.includes("KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_FAILED")) {
				clearTimeout(timeout);
				rejectPromise(
					new Error(`Isolated automation smoke failed: ${output}`),
				);
			}
		};
		child.stdout.on("data", check);
		child.stderr.on("data", check);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		child.once("exit", (code) => {
			if (output.includes("KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_OK")) {
				clearTimeout(timeout);
				resolvePromise();
				return;
			}
			clearTimeout(timeout);
			rejectPromise(
				new Error(`Native Chromium host exited ${code}: ${output}`),
			);
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
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_ISOLATED_AUTOMATION_OK/);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_AUTOMATION_SESSION_CREATED id=native-browser-/,
	);
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_AUTOMATION_ACT_OK/);
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_AUTOMATION_SCREENSHOT_OK/);
	assert.doesNotMatch(
		output,
		/Native Chromium browser backend operation is not migrated yet/,
	);
	assert.equal(
		pageHits > 0,
		true,
		"isolated create→navigate through the Core relay must load the smoke page in a hidden CEF session.",
	);
	assert.equal(
		actHits > 0,
		true,
		"isolated act(click) through the Core relay must dispatch on the inspected button.",
	);
	console.log(
		"Native Chromium isolated automation: Core relay create→navigate→snapshot→act→screenshot→close on CEF sessions.",
	);
} finally {
	if (child.exitCode === null) child.kill("SIGTERM");
	try {
		await new Promise((resolvePromise) => {
			if (child.exitCode !== null) {
				resolvePromise();
				return;
			}
			child.once("exit", () => resolvePromise());
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 2_000);
		});
	} catch {
		/* ignore shutdown races */
	}
	await new Promise((resolvePromise) => server.close(resolvePromise));
	await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(
		() => undefined,
	);
}
