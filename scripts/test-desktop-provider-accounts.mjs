import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import {
	openKestrelDestination,
	selectSettingsSection,
} from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-provider-accounts-desktop-"));
const screenshotPath = process.env.KESTREL_PROVIDER_ACCOUNTS_SCREENSHOT;
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
const authorizationHeaders = [];
const server = createServer((request, response) => {
	authorizationHeaders.push(request.headers.authorization ?? "");
	if (request.url === "/v1/models") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				data: [{ id: "local-sim", name: "Local simulation" }],
			}),
		);
		return;
	}
	response.writeHead(404, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: "not found" }));
});

let application;

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function close(server) {
	await new Promise((resolve) => server.close(() => resolve()));
}

async function launch() {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...testEnvironment,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	return page;
}

async function openProviderAccounts(page) {
	await openKestrelDestination(page, "Settings");
	await selectSettingsSection(page, "agent-models", "Models & routing");
	await page.getByText("Provider accounts", { exact: true }).waitFor();
}

async function addLoopbackAccount(page, label, providerId, baseUrl) {
	const form = page.locator(".provider-account-add");
	await form.waitFor();
	await form.locator("select").selectOption("compatible");
	await form.getByLabel("Account label", { exact: true }).fill(label);
	await form.getByLabel("Provider ID", { exact: true }).fill(providerId);
	await form.getByLabel(/Base URL/).fill(baseUrl);
	assert.equal(await form.getByLabel("Protected API key", { exact: true }).count(), 0);
	await form.getByRole("button", { name: "Add account", exact: true }).click();
	await page
		.locator(".provider-account-card")
		.filter({ hasText: label })
		.waitFor();
}

try {
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Provider test server did not expose a port.");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;

	let page = await launch();
	await openProviderAccounts(page);
	await page.getByText("Unsupported subscription connectors", { exact: true }).waitFor();
	await addLoopbackAccount(page, "Personal local", "lab", baseUrl);
	await addLoopbackAccount(page, "Work local", "lab", baseUrl);

	const cards = page.locator(".provider-account-card");
	assert.equal(await cards.count(), 2);
	await page.getByText("Ready", { exact: true }).first().waitFor();
	const runtimeAccounts = await page.evaluate(async () => {
		const response = await window.kestrel.request({ type: "runtime-list-providers" });
		if (!response.ok) throw new Error(response.error);
		return response.providerAccounts ?? [];
	});
	assert.equal(runtimeAccounts.length, 2);
	assert.equal(new Set(runtimeAccounts.map((account) => account.endpointId)).size, 2);
	assert.deepEqual(
		runtimeAccounts.map((account) => account.models.map((model) => model.id)),
		[["local-sim"], ["local-sim"]],
	);
	assert.ok(
		authorizationHeaders.length > 0 && authorizationHeaders.every((value) => value === ""),
		"Loopback compatible discovery must not receive an Authorization header.",
	);

	await openKestrelDestination(page, "Work");
	await page.getByText("Override automatic routing", { exact: true }).waitFor();
	const override = page.locator(".work-routing-override");
	await override.locator("summary").click();
	const selector = override.locator(".model-selector");
	await selector.waitFor({ state: "visible" });
	await selector.getByRole("button", { name: /Model:/ }).click();
	const menu = page.locator(".model-selector-menu");
	await menu.waitFor();
	await menu.getByRole("button", { name: /Lab.*2 accounts/ }).click();
	await menu.getByRole("button", { name: /Personal local/ }).click();
	await menu.getByRole("button", { name: /Local simulation/ }).click();
	await selector.getByRole("button", { name: /Model: Local simulation/ }).waitFor();
	if (screenshotPath) {
		mkdirSync(dirname(resolve(screenshotPath)), { recursive: true });
		await page.screenshot({ path: resolve(screenshotPath), fullPage: true });
	}

	await application.close();
	application = undefined;
	page = await launch();
	await openProviderAccounts(page);
	assert.equal(await page.locator(".provider-account-card").count(), 2);
	assert.equal(await page.getByText("Personal local", { exact: true }).count(), 1);
	assert.equal(await page.getByText("Work local", { exact: true }).count(), 1);
	process.stdout.write(
		`Provider account desktop flow passed against ${packagedExecutable ? "the packaged app" : "the built desktop app"}.\n`,
	);
} finally {
	await application?.close();
	await close(server);
	rmSync(root, { recursive: true, force: true });
}
