import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-single-instance-smoke-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];
const userData = join(root, "user-data");
const environment = {
	...process.env,
	KESTREL_DISABLE_UPDATES: "1",
	KESTREL_TEST_USER_DATA: userData,
	KESTREL_REAL_USER_PROFILE: "1",
	...(packagedExecutable
		? {}
		: {
				KESTREL_USE_NODE_CORE: "1",
				KESTREL_NODE_EXEC_PATH: process.execPath,
			}),
};

let application;
let secondProcess;

function waitForExit(child, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("The second Kestrel process did not exit after losing the lock."));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolvePromise({ code, signal });
		});
	});
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: environment,
	});
	const page = await application.firstWindow();
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	const firstProcess = application.process();

	secondProcess = spawn(executablePath, launchArgs, {
		env: environment,
		stdio: "ignore",
	});
	const result = await waitForExit(secondProcess, 10_000);
	assert.equal(
		result.code,
		0,
		`The second Kestrel process should quit cleanly, received ${JSON.stringify(result)}.`,
	);
	assert.equal(
		firstProcess.exitCode,
		null,
		"The first Kestrel process exited unexpectedly.",
	);
	assert.equal(
		firstProcess.signalCode,
		null,
		"The first Kestrel process was signaled unexpectedly.",
	);
	assert.equal(
		await page.locator("#runtime-prompt").isVisible(),
		true,
		"The first Kestrel window should remain available after the second launch.",
	);
	process.stdout.write(
		"Single-instance smoke passed: the second launch exited and the first stayed alive.\n",
	);
} finally {
	if (secondProcess && secondProcess.exitCode === null) secondProcess.kill("SIGKILL");
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
