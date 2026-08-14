import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "workstrand-external-secret-ui-"));
const helperPath = join(root, "credential-helper");
const screenshotPath = resolve(
	"artifacts/screenshots/desktop/setup-revised/settings-external-secrets.png",
);
writeFileSync(
	helperPath,
	"#!/bin/sh\nprintf 'OPENAI_API_KEY=test-external-openai-key\\nUNSUPPORTED_PRIVATE_VALUE=ignored\\n'\n",
	{ mode: 0o700 },
);
chmodSync(helperPath, 0o700);
mkdirSync(resolve("artifacts/screenshots/desktop/setup-revised"), {
	recursive: true,
});
let application;

try {
	application = await electron.launch({
		args: [resolve("apps/desktop/out/main/index.js")],
		env: { ...process.env, KESTREL_TEST_USER_DATA: join(root, "user-data") },
	});
	const page = await application.firstWindow();
	const runtimeErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
	await page.reload();
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("heading", { name: "Accounts and access" }).waitFor();

	const external = page.locator(".external-secret-setting");
	await external
		.getByText("External secret sources", { exact: true })
		.waitFor();
	assert.match(await external.textContent(), /Optional for advanced setups/);
	await external.getByText("Command helper", { exact: true }).click();
	await external.getByLabel("Run this exact executable at startup").check();
	await external.getByLabel("Executable path").fill(helperPath);
	await external
		.getByRole("button", { name: "Sync and verify" })
		.last()
		.click();
	await external.getByText("verified", { exact: true }).last().waitFor();
	await external.getByText(/1 supported credentials resolved/).waitFor();
	const providers = await page.evaluate(() =>
		window.kestrel.request({ type: "runtime-list-providers" }),
	);
	assert.equal(providers.ok, true);
	assert.ok(
		"providers" in providers &&
			providers.providers?.some((provider) => provider.id === "openai"),
	);

	if (process.env.WORKSTRAND_TEST_REAL_BWS === "1") {
		await external
			.getByText("Bitwarden Secrets Manager", { exact: true })
			.click();
		await external
			.getByRole("button", { name: "Install verified CLI" })
			.click();
		await external
			.getByRole("button", { name: "Verified CLI installed" })
			.waitFor({ timeout: 150_000 });
		await external
			.getByText(/Verified Bitwarden CLI installed locally/)
			.waitFor();
	}

	await page.setViewportSize({ width: 1320, height: 900 });
	await external.scrollIntoViewIfNeeded();
	await page.screenshot({ path: screenshotPath, fullPage: true });

	await page.setViewportSize({ width: 640, height: 760 });
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth,
	);
	assert.equal(overflow, false);
	await page.keyboard.press("Tab");
	assert.ok(
		await page.evaluate(
			() =>
				document.activeElement instanceof HTMLElement &&
				document.activeElement.matches(
					"button, input, textarea, select, summary, a",
				),
		),
	);

	await external.getByRole("button", { name: "Remove source" }).last().click();
	await external.getByText(/Command helper configuration removed/).waitFor();
	const providersAfterRemoval = await page.evaluate(() =>
		window.kestrel.request({ type: "runtime-list-providers" }),
	);
	assert.equal(providersAfterRemoval.ok, true);
	assert.ok(
		"providers" in providersAfterRemoval &&
			!providersAfterRemoval.providers?.some(
				(provider) => provider.id === "openai",
			),
	);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		`External secret Settings flow, command allowlist, isolated-core restart, removal, compact reflow, and screenshot passed${process.env.WORKSTRAND_TEST_REAL_BWS === "1" ? " with a real pinned Bitwarden CLI install" : ""}.\n`,
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
