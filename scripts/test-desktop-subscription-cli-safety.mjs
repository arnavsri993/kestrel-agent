import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";
import { withDesktopAgentCoreEnv } from "./desktop-agent-core-env.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-subscription-cli-safety-"));
const home = join(root, "home");
const codexPath = join(root, "codex");
const cursorPath = join(root, "cursor");
const codexStatusMarker = join(home, "codex-status-invoked");
const statusMarker = join(home, "cursor-status-invoked");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];
const testEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap(
		(key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]),
	),
);

mkdirSync(home, { recursive: true });
writeFileSync(
	codexPath,
	`#!/bin/sh
: > "$HOME/codex-status-invoked"
exit 1
`,
	{ mode: 0o700 },
);
chmodSync(codexPath, 0o700);
writeFileSync(
	cursorPath,
		`#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "status" ]; then
  : > "$HOME/cursor-status-invoked"
  printf '{"isAuthenticated":false}\\n'
  exit 0
fi
exit 1
`,
	{ mode: 0o700 },
);
chmodSync(cursorPath, 0o700);

let application;

async function subscriptionStatus(page) {
	const response = await page.evaluate(() =>
		window.kestrel.request({ type: "subscription-cli-status" }),
	);
	if (!response.ok || !("subscriptionClis" in response))
		throw new Error("Could not read subscription CLI status.");
	const cursor = response.subscriptionClis.find((item) => item.id === "cursor");
	if (!cursor) throw new Error("Cursor status was not returned.");
	return cursor;
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: withDesktopAgentCoreEnv({
			...testEnvironment,
			HOME: home,
			USER: "kestrel-test",
			LOGNAME: "kestrel-test",
			KESTREL_CODEX_PATH: codexPath,
			KESTREL_CURSOR_PATH: cursorPath,
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
		}),
	});
	const page = await application.firstWindow();
	await page.waitForLoadState("domcontentloaded");
	await page.waitForFunction(() => Boolean(window.kestrel));

	const disabled = await subscriptionStatus(page);
	assert.equal(disabled.detected, true);
	assert.equal(disabled.enabled, false);
	assert.equal(Object.hasOwn(disabled, "authenticated"), false);
	assert.equal(
		disabled.detail,
		"Cursor CLI found. Enable it to check sign-in and add Cursor Auto to plain-text routing.",
	);
	assert.equal(
		existsSync(statusMarker),
		false,
		"Kestrel must not execute a detected Cursor CLI before the person enables it.",
	);
	assert.equal(
		existsSync(codexStatusMarker),
		true,
		"The disposable test must route Codex status through its fake executable.",
	);
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	await openKestrelDestination(page, "Settings");
	await page
		.locator(".subscription-setting-list")
		.getByText(
			"Cursor CLI found. Enable it to check sign-in and add Cursor Auto to plain-text routing.",
			{ exact: true },
		)
		.waitFor();

	const cursorSetting = page
		.locator(".subscription-setting-list li")
		.filter({ hasText: "Cursor" });
	await cursorSetting.getByRole("button", { name: "Enable" }).click();
	await cursorSetting
		.getByText("Enabled, but Cursor is not signed in. Connect Cursor before running this route.", {
			exact: true,
		})
		.waitFor();
	await cursorSetting
		.getByRole("button", { name: "Sign in with Cursor" })
		.waitFor();
	assert.equal(existsSync(statusMarker), true);
	process.stdout.write(
		`Subscription CLI safety passed against ${packagedExecutable ? "the packaged app" : "the built desktop app"}.\n`,
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
