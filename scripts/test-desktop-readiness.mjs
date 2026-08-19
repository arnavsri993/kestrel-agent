import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "workstrand-readiness-test-"));
const userData = join(root, "user-data");
const backupParent = join(root, "backups");
const codexFixture = join(root, "fake-codex-app-server");
const pluginRoot = join(userData, "plugins", "readiness-test", "1.0.0");
let application;

try {
	mkdirSync(backupParent, { recursive: true });
	mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
	writeFileSync(
		join(pluginRoot, ".codex-plugin", "plugin.json"),
		JSON.stringify({
			name: "readiness-test",
			version: "1.0.0",
			description: "Test-only contextual entry point for readiness.",
			interface: {
				displayName: "Readiness Test",
				shortDescription: "Opens readiness through the extension surface.",
				capabilities: ["Read status"],
				defaultPrompt: [],
			},
			dashboard: "./dashboard.json",
		}),
	);
	writeFileSync(
		join(pluginRoot, "dashboard.json"),
		JSON.stringify({
			version: 1,
			title: "Readiness test",
			description: "Exercise the contextual readiness entry point.",
			navigationLabel: "Readiness Test",
			panels: [
				{
					id: "readiness",
					title: "Readiness",
					description: "Open the built-in readiness surface.",
					actions: [{ label: "Open readiness", page: "readiness" }],
				},
			],
		}),
	);
	writeFileSync(
		codexFixture,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("scripts/fixtures/fake-codex-app-server.mjs"))} "$@"\n`,
		{ mode: 0o700 },
	);
	chmodSync(codexFixture, 0o700);
	application = await electron.launch({
		args: [resolve("apps/desktop/out/main/index.js")],
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_CODEX_PATH: codexFixture,
		},
	});
	const page = await application.firstWindow();
	const runtimeErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();

	await openKestrelDestination(page, "Settings");
	await page.getByRole("button", { name: /^Agent Plugins/ }).click();
	const readinessPlugin = page
		.locator("article.setting-row")
		.filter({ hasText: "Readiness Test" });
	await readinessPlugin.getByRole("button", { name: "Enable" }).click();
	await readinessPlugin.getByText("Dashboard panels active").waitFor();
	await openKestrelDestination(page, "Extensions");
	await page
		.getByRole("button", { name: "Open readiness", exact: true })
		.click();
	await page
		.getByRole("heading", { name: /Needs attention|Ready for work/ })
		.waitFor();
	await page
		.getByRole("heading", { name: "What can work right now" })
		.waitFor();
	await page
		.getByText(
			"This contacts only the configured provider or local model service.",
			{ exact: false },
		)
		.waitFor();
	await page.getByRole("button", { name: "Run checks" }).focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	assert.notEqual(
		await page
			.getByRole("button", { name: "Run checks" })
			.evaluate((element) => getComputedStyle(element).outlineStyle),
		"none",
	);
	await page.setViewportSize({ width: 760, height: 760 });
	assert.equal(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		),
		false,
	);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ width: 1320, height: 860 });
	await openKestrelDestination(page, "Settings");
	const subscriptionSetting = page.locator(".subscription-setting");
	await subscriptionSetting
		.getByText("ChatGPT plan through Codex", { exact: true })
		.waitFor();
	await subscriptionSetting.getByRole("button", { name: "Enable" }).click();
	await subscriptionSetting.getByRole("button", { name: "Disable" }).waitFor();
	await openKestrelDestination(page, "Extensions");
	await page
		.getByRole("button", { name: "Open readiness", exact: true })
		.click();
	await page.getByRole("heading", { name: "Ready for work" }).waitFor();
	await page.getByRole("button", { name: "Verify model access" }).click();
	await page.getByText("codex-subscription", { exact: true }).waitFor();
	const codexCheck = page
		.locator(".model-check-panel")
		.getByRole("listitem")
		.filter({ hasText: "codex-subscription" });
	await codexCheck.waitFor();
	const codexCheckText = await codexCheck.innerText();
	assert.match(
		codexCheckText,
		/account reachable/,
		`Codex readiness probe failed: ${codexCheckText}`,
	);

	await application.evaluate(async ({ dialog }, destination) => {
		dialog.showOpenDialog = async () => ({
			canceled: false,
			filePaths: [destination],
		});
	}, backupParent);
	await page.getByRole("button", { name: "Choose backup folder" }).click();
	await page.getByText("Hashes verified", { exact: false }).waitFor();

	const backupNames = readdirSync(backupParent).filter(
		(name) => !name.endsWith(".partial"),
	);
	assert.equal(backupNames.length, 1);
	const backupPath = join(backupParent, backupNames[0]);
	assert.equal(
		existsSync(join(backupPath, "database", "kestrel.sqlite")),
		true,
	);
	assert.equal(
		existsSync(join(backupPath, "secure", "database-key.bin")),
		true,
	);
	assert.equal(existsSync(join(backupPath, "runtime-preferences.json")), true);
	const manifest = JSON.parse(
		readFileSync(join(backupPath, "manifest.json"), "utf8"),
	);
	assert.equal(manifest.format, "workstrand-local-backup");
	assert.equal(manifest.version, 1);
	assert.ok(
		manifest.files.some(
			(file) =>
				file.path === "database/kestrel.sqlite" &&
				/^[a-f0-9]{64}$/.test(file.sha256),
		),
	);
	assert.ok(
		manifest.files.some(
			(file) =>
				file.path === "secure/database-key.bin" &&
				/^[a-f0-9]{64}$/.test(file.sha256),
		),
	);
	assert.ok(
		manifest.files.some(
			(file) =>
				file.path === "runtime-preferences.json" &&
				/^[a-f0-9]{64}$/.test(file.sha256),
		),
	);
	await page.getByText("Verified backup created", { exact: false }).waitFor();
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		"Desktop readiness diagnostics and verified local backup passed.\n",
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
