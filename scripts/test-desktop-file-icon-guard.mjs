import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") {
	process.stdout.write("macOS file-icon guard smoke skipped outside macOS.\n");
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "kestrel-file-icon-guard-"));
const userData = join(root, "user-data");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];

let application;
try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
		},
	});
	await application.firstWindow();

	let timer;
	let size;
	try {
		size = await Promise.race([
			application.evaluate(async ({ app }) => {
				const icon = await app.getFileIcon(app.getPath("exe"), {
					size: "large",
				});
				return icon.getSize();
			}),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("The guarded file-icon request did not resolve.")),
					15_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	assert.deepEqual(size, { width: 32, height: 32 });
	process.stdout.write(
		"macOS file-icon guard smoke passed: a large request completed through the safe 32 px path.\n",
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
