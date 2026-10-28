import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

// This launcher deliberately owns a unique disposable profile by default. It
// must never fall back to the Electron profile. Opt into a durable isolated
// profile with --durable (still never the Electron Application Support path).
const extensionWorkbench = process.argv.includes("--extensions");
const durableProfile = process.argv.includes("--durable");
if (extensionWorkbench) {
	console.log("Opening the native Chromium extension workbench. Its temporary profile is deleted on exit; Kestrel data and accounts are not connected.");
}
const profile = durableProfile
	? join(homedir(), "Library", "Application Support", "Kestrel Native", "Development")
	: await mkdtemp(join(tmpdir(), "kestrel-native-chromium-dev-"));
if (durableProfile) {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(profile, { recursive: true, mode: 0o700 });
	console.log(`Using durable isolated native profile at ${profile}`);
}
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
				: [
						"--kestrel-chromium-desktop",
						...(durableProfile ? ["--kestrel-durable-profile"] : []),
					]),
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
	if (!durableProfile) await rm(profile, { recursive: true, force: true });
}
