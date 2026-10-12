import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

// This launcher deliberately owns a unique disposable profile. It must never
// fall back to the Electron profile, a home-directory default, or a persistent
// native profile while credential/profile migration is still deferred.
const extensionWorkbench = process.argv.includes("--extensions");
if (extensionWorkbench) {
	console.log("Opening the native Chromium extension workbench. Its temporary profile is deleted on exit; Kestrel data and accounts are not connected.");
}
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-chromium-dev-"));
let child;

async function stopChild() {
	if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
}

const forwardSignal = () => {
	void stopChild();
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);

try {
	const app = await buildNativeChromiumHost();
	const executable = join(app, "Contents", "MacOS", "Kestrel");
	child = spawn(
		executable,
		[
			"--kestrel-cache-path",
			profile,
			...(extensionWorkbench
				? ["--kestrel-extension-workbench"]
				: ["--kestrel-ephemeral-core", "--kestrel-renderer"]),
		],
		{ stdio: "inherit" },
	);
	const exitCode = await new Promise((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("exit", (code, signal) => {
			if (signal) {
				rejectPromise(new Error(`Native Chromium Kestrel ended from ${signal}.`));
				return;
			}
			resolvePromise(code ?? 1);
		});
	});
	process.exitCode = exitCode;
} finally {
	process.off("SIGINT", forwardSignal);
	process.off("SIGTERM", forwardSignal);
	await stopChild();
	await rm(profile, { recursive: true, force: true });
}
