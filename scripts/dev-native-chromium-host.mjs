import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

// This launcher deliberately owns a unique disposable profile. It must never
// fall back to the Electron profile, a home-directory default, or a persistent
// native profile while credential/profile migration is still deferred.
const nativeBrowser = process.argv.includes("--native-browser");
const extensionWorkbench = process.argv.includes("--extensions");
if (extensionWorkbench) {
	console.log("Opening the native Chromium extension workbench. Its temporary profile is deleted on exit; Kestrel data and accounts are not connected.");
}
if (nativeBrowser && extensionWorkbench) throw new Error("Choose the native shell or extension workbench.");
if (nativeBrowser) console.log("Opening the native Kestrel shell with a separate Chrome extension browser. Both profiles are temporary; no existing Kestrel data is imported.");
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-chromium-dev-"));
let child;

async function stopChild() {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 8_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
    }
  }
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
			...(nativeBrowser ? ["--kestrel-native-browser"] : []),
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
  if (!child || child.exitCode === 0) {
    await rm(profile, { recursive: true, force: true });
  } else {
    console.error(`Native host did not exit cleanly; its temporary profile was preserved at ${profile}.`);
  }
}
