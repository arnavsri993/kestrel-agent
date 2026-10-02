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
import {
	openKestrelDestination,
	selectSettingsSection,
} from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "workstrand-readiness-test-"));
const userData = join(root, "user-data");
const backupParent = join(root, "backups");
const codexFixture = join(root, "fake-codex-app-server");
const codexFixtureCapture = join(root, "fake-codex-app-server.jsonl");
const testHome = join(root, "home");
const testCodexHome = join(root, "codex-home");
const testTempDirectory = join(root, "tmp");
const pluginRoot = join(userData, "plugins", "readiness-test", "1.0.0");
const testEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]]],
	),
);
let application;

try {
	mkdirSync(backupParent, { recursive: true });
	mkdirSync(testHome, { recursive: true });
	mkdirSync(testCodexHome, { recursive: true });
	mkdirSync(testTempDirectory, { recursive: true });
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
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("scripts/fixtures/fake-codex-app-server.mjs"))} ${JSON.stringify(`--kestrel-test-capture=${codexFixtureCapture}`)} "$@"\n`,
		{ mode: 0o700 },
	);
	chmodSync(codexFixture, 0o700);
	application = await electron.launch({
		args: [resolve("apps/desktop/out/main/index.js")],
		env: {
			...testEnvironment,
			HOME: testHome,
			USER: "kestrel-readiness-test",
			LOGNAME: "kestrel-readiness-test",
			CODEX_HOME: testCodexHome,
			TMPDIR: testTempDirectory,
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_CODEX_PATH: codexFixture,
		KESTREL_DISABLE_UPDATES: "1",
		KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
		KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
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
	const settingsTab = await page.evaluate(() =>
		window.kestrel.request({
			type: "browser-create-tab",
			input: "kestrel://settings",
			active: true,
		}),
	);
	if (!settingsTab.ok)
		throw new Error("Could not open the disposable Settings tab.");
	await page.locator("#new-tab-title").waitFor({ state: "detached" });

	await openKestrelDestination(page, "Settings");
	await selectSettingsSection(page, "extensions", "Plugins");
	const readinessPlugin = page
		.locator("article.setting-row")
		.filter({ hasText: "Readiness Test" });
	await readinessPlugin.getByRole("button", { name: "Enable" }).click();
	await readinessPlugin.getByText("Dashboard panels active").waitFor();
	await openKestrelDestination(page, "Extensions");
	await page
		.getByRole("button", { name: "Open readiness", exact: true })
		.click();
	await page.locator("h1").filter({ hasText: "Readiness" }).waitFor();
	await page
		.getByRole("heading", { name: "What can work right now" })
		.waitFor();
	await page
		.getByText(
			"Checks the configured provider or local model. It does not send a project prompt.",
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
	await selectSettingsSection(page, "connections", "Connections");
	await page.getByLabel("More connection settings").selectOption("models");
	await page.getByRole("heading", { name: "Model provider", exact: true }).waitFor();
	const chatGptConnection = page
		.locator(".oauth-connection")
		.filter({ has: page.getByText("ChatGPT", { exact: true }) });
	await chatGptConnection.waitFor();
	await chatGptConnection
		.getByRole("button", { name: "Enable model route" })
		.click();
	await chatGptConnection
		.getByRole("button", { name: "Disable model route" })
		.waitFor();
	const codexAccountEndpointId = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-providers",
		});
		if (!response.ok || !response.providerAccounts)
			throw new Error("The account-aware provider catalog is unavailable.");
		const account = response.providerAccounts.find(
			(candidate) =>
				candidate.providerId === "codex" &&
				candidate.authTransport === "oauth" &&
				candidate.enabled,
		);
		if (!account)
			throw new Error("The enabled Codex account is missing from the provider catalog.");
		return account.endpointId;
	});
	await page.waitForFunction(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-providers",
		});
		return (
			response.ok &&
			"providerAccounts" in response &&
			response.providerAccounts.some(
				(account) =>
					account.providerId === "codex" &&
					account.models.some((model) => model.id === "gpt-6-sol") &&
					account.models.some((model) => model.id === "gpt-6-luna"),
			)
		);
	});

	// Exercise a real visible agent turn with the disposable fixture. This is
	// deliberately account-free: the fixture returns an owned response and the
	// protocol capture below proves Kestrel still requested read-only/no-network
	// execution for both automatic routing and selected model routes.
	await openKestrelDestination(page, "Agent");
	await page.getByRole("button", { name: "Start a task", exact: true }).click();
	const prompt = page.locator("#runtime-prompt");
	await prompt.waitFor();
	await page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	);
	async function runFixtureTurn(input, response) {
		await page.waitForFunction(() => {
			const status = document.querySelector(".composer-status")?.textContent ?? "";
			return !status.includes("Another chat is running");
		});
		await prompt.fill(input);
		assert.equal(await prompt.inputValue(), input);
		await page.waitForFunction(() => {
			const button = document.querySelector(
				'button[aria-label="Send message"]',
			);
			return Boolean(button && !button.disabled);
		});
		await prompt.press("Enter");
		try {
			await page.getByText(input, { exact: true }).last().waitFor();
			await page.getByText(response, { exact: true }).waitFor();
		} catch (error) {
			const diagnostic = await page.evaluate(() => ({
				error: document.querySelector(".chat-error")?.textContent?.trim() ?? null,
				outcome: document.querySelector(".runtime-outcome")?.textContent?.trim() ?? null,
				status: document.querySelector(".composer-status")?.textContent?.trim() ?? null,
				model: document
					.querySelector(".model-selector-trigger")
					?.getAttribute("aria-label"),
			}));
			const capture = existsSync(codexFixtureCapture)
				? readFileSync(codexFixtureCapture, "utf8")
				: "(fixture received no requests)";
			throw new Error(
				`Fixture agent turn did not render ${response}: ${JSON.stringify({ diagnostic, capture })}`,
				{ cause: error },
			);
		}
		await page.waitForFunction(
			() => ![...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Stop"),
		);
	}
	await runFixtureTurn(
		"Return the fixture response without changing files or using the network.",
		"Fixture read-only response 1.",
	);

	const modelSelector = page.locator(".model-selector-trigger").first();
	await modelSelector.click();
	const modelDialog = page.getByRole("dialog", {
		name: "Choose a provider, account, model, and thinking level",
	});
	await modelDialog.waitFor();
	const modelColumn = modelDialog.locator(
		'.model-selector-column[aria-label="Model"]',
	);
	await modelColumn.getByRole("button", { name: /^GPT-6 Sol/ }).waitFor();
	await modelColumn.getByRole("button", { name: /^GPT-6 Luna/ }).waitFor();
	await modelColumn.getByRole("button", { name: /^GPT-6 Luna/ }).click();
	const thinkingColumn = modelDialog.locator(
		'.model-selector-column[aria-label="Thinking level"]',
	);
	await thinkingColumn.getByRole("button", { name: /^Max/ }).waitFor();
	assert.equal(
		await thinkingColumn.getByRole("button", { name: /^Ultra/ }).count(),
		0,
		"GPT-6 Luna must not advertise GPT-6 Sol's Ultra reasoning level.",
	);
	await thinkingColumn.getByRole("button", { name: /^Max/ }).click();
	await modelDialog.waitFor({ state: "detached" });
	await runFixtureTurn(
		"Return the fixture response without changing files or using the network.",
		"Fixture read-only response 2.",
	);

	await modelSelector.click();
	await modelDialog.waitFor();
	await modelDialog
		.locator('.model-selector-column[aria-label="Model"]')
		.getByRole("button", { name: /^GPT-6 Sol/ })
		.click();
	await thinkingColumn.getByRole("button", { name: /^Ultra/ }).waitFor();
	await thinkingColumn.getByRole("button", { name: /^Ultra/ }).click();
	await modelDialog.waitFor({ state: "detached" });
	await runFixtureTurn(
		"Return the fixture response without changing files or using the network.",
		"Fixture read-only response 3.",
	);

	const capturedCodexRequests = readFileSync(codexFixtureCapture, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const capturedCodexClientRequests = capturedCodexRequests
		.filter((record) => record.direction === "in")
		.map((record) => record.value);
	const turnRequests = capturedCodexClientRequests.filter(
		(request) =>
			request.method === "turn/start" &&
			JSON.stringify(request.params?.input ?? []).includes(
				"Return the fixture response without changing files or using the network.",
			),
	);
	assert.equal(turnRequests.length, 3);
	for (const request of turnRequests) {
		assert.equal(request.params?.approvalPolicy, "never");
		assert.deepEqual(request.params?.sandboxPolicy, {
			type: "readOnly",
			networkAccess: false,
		});
	}
	assert.ok(
		["gpt-6-sol", "gpt-6-luna"].includes(turnRequests[0]?.params?.model),
		"Automatic routing must choose one fixture-advertised model.",
	);
	assert.deepEqual(
		turnRequests.slice(1).map((request) => ({
			model: request.params?.model,
			effort: request.params?.effort,
		})),
		[
			{ model: "gpt-6-luna", effort: "max" },
			{ model: "gpt-6-sol", effort: "ultra" },
		],
	);
	await openKestrelDestination(page, "Extensions");
	await page
		.getByRole("button", { name: "Open readiness", exact: true })
		.click();
	await page
		.locator(".ui-page-frame-eyebrow")
		.getByText("Ready for work", { exact: true })
		.waitFor();
	await page.getByRole("button", { name: "Verify model access" }).click();
	await page.getByText(codexAccountEndpointId, { exact: true }).waitFor();
	const codexCheck = page
		.locator(".model-check-panel")
		.getByRole("listitem")
		.filter({ hasText: codexAccountEndpointId });
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
