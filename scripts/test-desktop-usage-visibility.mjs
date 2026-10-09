import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-usage-visibility-"));
const evidence = resolve(".tmp/usage-visibility");
mkdirSync(evidence, { recursive: true });
const userData = join(root, "profile");
const require = createRequire(resolve("apps/desktop/package.json"));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const preload = join(root, "usage-fixture.cjs");
const rows = ["Alpha", "Beta"].map((name) => ({
	providerId: `codex-subscription-fixture-${name.toLowerCase()}`,
	providerPoolId: "codex-subscription",
	label: `${name} · Codex`,
	status: "ready",
	ordinaryUsageAllowed: true,
	updatedAt: new Date().toISOString(),
	windows: [{ label: "5-hour", usedPercent: 25 }],
}));
// Wrap the bridge before exposure in a disposable profile. Only usage data is
// synthetic; settings writes, reloads and restart persistence use the real IPC.
writeFileSync(preload, `
	const { contextBridge } = require("electron");
	const expose = contextBridge.exposeInMainWorld.bind(contextBridge);
	contextBridge.exposeInMainWorld = (name, bridge) => {
		if (name === "kestrel") {
			const request = bridge.request.bind(bridge);
			bridge = { ...bridge, request: input => input.type === "runtime-provider-usage"
				? Promise.resolve({ ok: true, providerUsage: ${JSON.stringify(rows)} })
				: request(input) };
		}
		return expose(name, bridge);
	};
`);
let application;
let page;
const errors = [];

async function browserState() {
	const response = await page.evaluate(() => window.kestrel.request({ type: "browser-get-state" }));
	assert(response.ok && response.browserState, "Browser state was unavailable.");
	return response.browserState;
}

async function launch(firstRun = false) {
	application = await electron.launch({
		executablePath: packaged ? resolve(packaged) : require("electron"),
		args: packaged ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	page = await application.firstWindow();
	page.on("pageerror", (error) => errors.push(error.message));
	page.setDefaultTimeout(15_000);
	await application.evaluate(({ BrowserWindow }, fixturePreload) => {
		const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes("petOverlay"));
		if (!win) throw new Error("Main window was unavailable.");
		win.webContents.session.setPreloads([fixturePreload]);
		win.setMinimumSize(400, 500);
		win.setSize(1280, 820);
	}, preload);
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	if (firstRun) {
		const state = await browserState();
		const response = await page.evaluate((settings) => window.kestrel.request({
			type: "browser-update-settings",
			settings: { ...settings, newTabWidgets: { version: 1, enabled: ["route-usage"], layouts: {}, routeUsageVisible: [] } },
		}), state.settings);
		assert(response.ok, "Could not configure fixture widget.");
	}
	const response = await page.evaluate(() => window.kestrel.request({ type: "browser-create-tab", active: true }));
	assert(response.ok, "Could not open Home.");
	await page.locator("#new-tab-title").waitFor();
	const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
	if (await closeChat.isVisible()) await closeChat.click();
	await revealWidget();
}

function widget() { return page.locator('[data-kestrel-widget-id="route-usage"]'); }

async function revealWidget() {
	await page.locator(".kestrel-widget-card:visible").first().waitFor();
	for (let attempt = 0; attempt < 12; attempt += 1) {
		if (await widget().isVisible()) {
			await widget().scrollIntoViewIfNeeded();
			return;
		}
		const pager = page.locator(".kestrel-widget-pager:visible");
		if (await pager.count() === 0) break;
		const next = pager.getByRole("button", { name: /next/i }).first();
		if (await next.isDisabled()) break;
		await next.click();
	}
	throw new Error("Codex usage widget was unavailable through the Home pager.");
}

async function controls() {
	await revealWidget();
	await page.waitForFunction(() => {
		const card = document.querySelector('[data-kestrel-widget-id="route-usage"]');
		return card && [...card.querySelectorAll("button")].some((button) =>
			button.textContent.trim() === "Accounts" || /^(Hide|Show) Alpha$/.test(button.getAttribute("aria-label") || button.textContent.trim()),
		);
	});
	const accounts = widget().getByRole("button", { name: "Accounts", exact: true });
	if (await accounts.isVisible()) {
		await accounts.click();
		const dialog = page.getByRole("dialog", { name: "Codex accounts", exact: true });
		await dialog.waitFor();
		return dialog;
	}
	return widget();
}

async function closeControls() {
	const dialog = page.getByRole("dialog", { name: "Codex accounts", exact: true });
	if (await dialog.isVisible()) {
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
	}
}

try {
	await launch(true);
	let panel = await controls();
	await panel.getByRole("button", { name: "Hide Alpha", exact: true }).waitFor();
	await page.screenshot({ path: join(evidence, "before.png"), animations: "disabled" });
	await panel.getByRole("button", { name: "Hide Alpha", exact: true }).click();
	await panel.getByRole("button", { name: "Show Alpha", exact: true }).waitFor();
	await panel.getByRole("button", { name: "Hide Beta", exact: true }).click();
	await panel.getByRole("button", { name: "Show Beta", exact: true }).waitFor();
	assert.equal(await panel.getByRole("button", { name: /^Hide / }).count(), 0, "Hiding the final account must not make accounts reappear.");
	await closeControls();
	await page.screenshot({ path: join(evidence, "all-hidden.png"), animations: "disabled" });
	let settings = (await browserState()).settings.newTabWidgets;
	assert.equal(settings.routeUsageVisibilityConfigured, true);
	assert.deepEqual(settings.routeUsageVisible, []);
	await page.reload();
	panel = await controls();
	await panel.getByRole("button", { name: "Show Alpha", exact: true }).waitFor();
	await panel.getByRole("button", { name: "Show Beta", exact: true }).waitFor();
	await closeControls();
	await application.close();
	application = undefined;
	await launch();
	panel = await controls();
	await panel.getByRole("button", { name: "Show Alpha", exact: true }).waitFor();
	await panel.getByRole("button", { name: "Show Beta", exact: true }).waitFor();
	assert.equal(await panel.getByRole("button", { name: /^Hide / }).count(), 0);
	const showAlpha = panel.getByRole("button", { name: "Show Alpha", exact: true });
	await showAlpha.focus();
	await page.keyboard.press("Enter");
	await panel.getByRole("button", { name: "Hide Alpha", exact: true }).waitFor();
	await panel.getByRole("button", { name: "Show Beta", exact: true }).waitFor();
	settings = (await browserState()).settings.newTabWidgets;
	assert.deepEqual(settings.routeUsageVisible, [rows[0].providerId]);
	await page.screenshot({ path: join(evidence, "restored-one.png"), animations: "disabled" });
	await panel.getByRole("button", { name: "Show Beta", exact: true }).click();
	await panel.getByRole("button", { name: "Hide Beta", exact: true }).waitFor();
	await closeControls();
	settings = (await browserState()).settings.newTabWidgets;
	assert.equal(Boolean(settings.routeUsageVisibilityConfigured), false);
	assert.deepEqual(settings.routeUsageVisible, []);
	assert.deepEqual(errors, [], "Renderer errors occurred.");
	console.log("Usage visibility passed: hide every account, persist through reload and app restart, restore one with keyboard, and restore all to automatic visibility. Synthetic usage; real settings IPC and profile persistence.");
} catch (error) {
	await page?.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
	throw error;
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
