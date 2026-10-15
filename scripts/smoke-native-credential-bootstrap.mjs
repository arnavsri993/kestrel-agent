import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const app = process.env.KESTREL_NATIVE_TEST_APP
	? resolve(process.env.KESTREL_NATIVE_TEST_APP)
	: await buildNativeChromiumHost();
const executable = join(app, "Contents", "MacOS", "Kestrel");
const profile = await mkdtemp(
	join(tmpdir(), "kestrel-native-credential-bootstrap-"),
);

let output = "";
const child = spawn(
	executable,
	[
		"--kestrel-cache-path",
		profile,
		"--kestrel-durable-profile",
		"--kestrel-smoke-credentials",
		"--kestrel-exit-after-ready-ms",
		"8000",
	],
	{
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			KESTREL_USE_MOCK_KEYCHAIN: "1",
		},
	},
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
						`Timed out waiting for credential bootstrap smoke: ${output}`,
					),
				),
			45_000,
		);
		const check = () => {
			if (
				output.includes("KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_OK") &&
				output.includes("KESTREL_NATIVE_CHROMIUM_HOST_READY")
			) {
				clearTimeout(timeout);
				resolvePromise();
			}
			if (
				output.includes("KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_FAILED")
			) {
				clearTimeout(timeout);
				rejectPromise(
					new Error(`Credential bootstrap smoke failed: ${output}`),
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
			if (
				output.includes("KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_OK")
			) {
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
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_CREDENTIAL_STORAGE mode=profile-sealed/,
	);
	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_CREDENTIAL_BOOTSTRAP_OK mode=profile-sealed/,
	);
	assert.match(
		output,
		/credential_storage=profile-sealed chromium_keychain=mock/,
	);
	assert.doesNotMatch(output, /KESTREL_USE_REAL_KEYCHAIN/);
	console.log(
		"Native Chromium credential bootstrap: profile-sealed set/list/remove without Keychain prompts.",
	);
} finally {
	if (child.exitCode === null) child.kill("SIGTERM");
	await rm(profile, { recursive: true, force: true });
}
