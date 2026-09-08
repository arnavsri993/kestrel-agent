import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import {
	openKestrelDestination,
	selectSettingsSection,
} from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-model-routing-test-"));
const screenshotPath = process.env.KESTREL_ROUTING_SCREENSHOT;
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];
const builtMain = resolve("apps/desktop/out/main/index.js");
const testEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]]],
	),
);
let application;

try {
	if (!packagedExecutable && !existsSync(builtMain))
		throw new Error(
			"Desktop build is missing. Run `pnpm build:desktop` before `pnpm test:desktop-model-routing`.",
		);
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		timeout: 30_000,
		env: {
			...testEnvironment,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
		},
	});
	const page = await application.firstWindow({ timeout: 30_000 });
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
	await selectSettingsSection(page, "models", "Models");
	await page.getByText("How Kestrel chooses models", { exact: true }).waitFor();

	const modes = page.locator(".routing-mode-grid [role=radio]");
	await modes.first().waitFor();
	assert.equal(await modes.count(), 6);
	assert.equal(
		await page
			.getByRole("radio", { name: /Balanced/ })
			.getAttribute("aria-checked"),
		"true",
	);
	await page.getByRole("radio", { name: /Local first/ }).click();
	await page.waitForFunction(() =>
		[...document.querySelectorAll(".routing-mode-grid [role=radio]")].some(
			(element) =>
				element.textContent?.includes("Local first") &&
				element.getAttribute("aria-checked") === "true",
		),
	);
	assert.equal(
		await page
			.getByRole("radio", { name: /Local first/ })
			.getAttribute("aria-checked"),
		"true",
	);
	assert.match(
		await page.locator(".routing-registry-summary").innerText(),
		/configured model endpoint/,
	);
	if (screenshotPath) {
		mkdirSync(dirname(resolve(screenshotPath)), { recursive: true });
		await page.screenshot({ path: resolve(screenshotPath), fullPage: true });
	}
	await page.locator(".routing-advanced > summary").click();
	await page.getByLabel("Allow automatic escalation").uncheck();
	await page.getByLabel("Maximum escalations").fill("1");
	await page.getByLabel("Use independent verification").uncheck();
	await page.getByLabel("Preferred provider IDs").fill("openai, local");
	await page.getByLabel("Avoided provider IDs").fill("untrusted");
	await page.getByLabel("Maximum parallel agents").fill("3");
	await page.getByRole("button", { name: "Save advanced limits" }).click();
	assert.equal(
		await page.getByLabel("Maximum parallel agents").inputValue(),
		"3",
	);
	assert.equal(await page.getByLabel("Allow automatic escalation").isChecked(), false);
	assert.equal(await page.getByLabel("Maximum escalations").inputValue(), "1");
	assert.equal(
		await page.getByLabel("Use independent verification").isChecked(),
		false,
	);
	assert.equal(
		await page.getByLabel("Preferred provider IDs").inputValue(),
		"openai, local",
	);
	assert.equal(
		await page.getByLabel("Avoided provider IDs").inputValue(),
		"untrusted",
	);

	await openKestrelDestination(page, "Work");
	await page.getByText("Override automatic routing", { exact: true }).waitFor();
	assert.match(
		await page.locator(".work-card-note").first().innerText(),
		/capability, cost, privacy, and your routing preference/,
	);
	assert.equal(runtimeErrors.length, 0, runtimeErrors.join("\n"));
	console.log("Desktop intelligent model routing UI passed.");
} finally {
	if (application) await application.close();
	rmSync(root, { recursive: true, force: true });
}
