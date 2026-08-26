import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-writing-studio-"));
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
const runtimeErrors = [];

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
	const page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
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
	await page.locator("#runtime-prompt").waitFor();

	const initial = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "writing-profile-get",
		});
		if (!response.ok) throw new Error(response.error);
		return response.writingProfile;
	});
	assert.equal(initial?.status, "disabled");

	await openKestrelDestination(page, "Writing Studio");
	await page
		.locator(".browser-tab.active [role='tab'] .browser-tab-title")
		.filter({ hasText: /^Writing Studio$/ })
		.waitFor();
	await page
		.getByRole("heading", {
			name: "Draft like yourself, with your context.",
			exact: true,
		})
		.waitFor();
	await page.locator('[data-app-page="writing"]').waitFor();
	await page.locator(".writing-profile-toggle input").first().waitFor();

	await page.locator(".writing-profile-toggle input").first().click();
	await page.waitForFunction(
		() =>
			(document.querySelector(".writing-profile-toggle input"))?.checked === true,
	);
	await page.locator(".writing-sample-form textarea").fill(
		"I keep project notes concise, and I prefer a warm close.",
	);
	await page.locator(".writing-sample-actions input").first().check();
	await page.getByRole("button", { name: "Add sample", exact: true }).click();
	await page.getByText("Learning", { exact: true }).waitFor();

	const learned = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "writing-profile-get",
		});
		if (!response.ok) throw new Error(response.error);
		return response.writingProfile;
	});
	assert.equal(learned?.status, "learning");
	assert.equal(learned?.sampleCount, 1);
	assert.equal(learned?.exemplarCount, 0);

	await page.getByLabel("Purpose", { exact: true }).fill(
		"Prepare a concise note to a project collaborator about a check-in.",
	);
	await page.getByText("Brief-led draft", { exact: true }).waitFor();

	const preview = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "writing-context-preview",
			purpose: "Prepare a concise note to a project collaborator about a check-in.",
			genre: "email",
			includeSensitive: false,
		});
		if (!response.ok) throw new Error(response.error);
		return response.writingContextPreview;
	});
	assert.equal(preview?.sensitiveIncluded, false);
	assert.equal(preview?.restrictedIncluded, false);
	assert.ok((preview?.memories ?? -1) >= 0);
	assert.ok(preview?.categories.includes("voice-profile"));
	assert.equal(runtimeErrors.length, 0, runtimeErrors.join("\n"));
	process.stdout.write("Writing Studio profile, context preview, and desktop UI smoke test passed.\n");
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
