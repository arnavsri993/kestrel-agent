import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { openKestrelDestination, selectSettingsSection } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-settings-disclosures-"));
for (const name of ["home", "codex", "profile"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_SETTINGS_DISCLOSURE_EVIDENCE;
if (evidence) mkdirSync(evidence, { recursive: true });
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE;
const inherited = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
let remoteRequests = 0;
const server = createServer((_request, response) => {
	remoteRequests += 1;
	response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "Owned memory server is unavailable." }));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let application;
let page;
const runtimeErrors = [];
async function section(value, label) {
	await selectSettingsSection(page, value, label);
}
async function keyboardToggle(details) {
	await details.locator("summary").first().focus();
	await page.keyboard.press("Enter");
}
async function compactCapture(name, row) {
	await page.setViewportSize({ width: 800, height: 760 });
	await page.waitForFunction(() => document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-compact"));
	const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
	if (await closeChat.isVisible()) await closeChat.click();
	await page.waitForFunction(() => !document.querySelector(".browser-main-plane")?.inert);
	await row.scrollIntoViewIfNeeded();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	const overflow = await row.evaluate(owner => [...owner.querySelectorAll("input, textarea, select, button, summary")].filter(node => {
		if (!node.checkVisibility()) return false;
		const box = node.getBoundingClientRect(); const bounds = owner.getBoundingClientRect();
		return box.left < bounds.left - 1 || box.right > bounds.right + 1;
	}).map(node => node.tagName));
	assert.deepEqual(overflow, [], `${name} controls must fit their actual settings column`);
	if (evidence) await page.screenshot({ path: join(evidence, `${name}-compact.png`) });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForFunction(() => !document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-compact"));
}
try {
	application = await electron.launch({
		executablePath: executablePath ?? requireFromDesktop("electron"),
		args: [...(executablePath ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
		env: { ...inherited, HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), KESTREL_TEST_USER_DATA: join(root, "profile"),
			KESTREL_REAL_USER_PROFILE: "1", KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" },
	});
	page = await application.firstWindow(); page.setDefaultTimeout(30_000);
	page.on("pageerror", error => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
	await page.reload();
	await page.setViewportSize({ width: 1440, height: 900 });
	await openKestrelDestination(page, "Settings");
	const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
	if (await closeChat.isVisible()) await closeChat.click();

	await section("agent-memory", "Memory & context");
	const honcho = page.locator(".honcho-memory-setting");
	const connection = honcho.locator(".honcho-connection");
	await connection.waitFor();
	assert.equal(await connection.getAttribute("open"), null, "Disabled remote memory setup starts folded");
	assert.equal(await honcho.getByRole("button", { name: "Enable Honcho", exact: true }).isVisible(), false);
	await keyboardToggle(connection);
	const enable = honcho.getByRole("button", { name: "Enable Honcho", exact: true });
	await expect(enable).toBeDisabled();
	const initial = await page.evaluate(() => window.kestrel.request({ type: "honcho-memory-get" }));
	assert.equal(initial.honchoMemoryStatus.configuration.enabled, false);
	assert.equal(await honcho.locator(".honcho-disclosure").textContent(), initial.honchoMemoryStatus.remoteDataDisclosure);
	await honcho.getByRole("button", { name: "Save key", exact: true }).click();
	await expect(honcho.getByRole("alert")).toHaveText("Enter the complete Honcho API key.");
	await keyboardToggle(connection);
	await expect(honcho.getByRole("alert")).toBeVisible();
	await keyboardToggle(connection);
	await honcho.getByLabel(/Honcho API key/).fill("owned-honcho-credential");
	await honcho.getByRole("button", { name: "Save key", exact: true }).click();
	await expect(honcho.getByRole("status").filter({ hasText: "Honcho API key saved" })).toBeVisible();
	assert.equal(await honcho.getByLabel(/Honcho API key/).inputValue(), "", "Protected key entry clears after saving");
	const configuration = honcho.locator(".honcho-configuration");
	await keyboardToggle(configuration);
	await honcho.getByLabel("Server URL", { exact: true }).fill(baseUrl);
	await honcho.getByLabel("Workspace ID", { exact: true }).fill("owned-disclosure-test");
	await keyboardToggle(connection); await keyboardToggle(connection);
	assert.equal(await honcho.getByLabel("Server URL", { exact: true }).inputValue(), baseUrl, "Folding setup must retain unsaved configuration");
	await expect(enable).toBeDisabled();
	const consent = honcho.getByLabel(/I understand that enabling Honcho/);
	await consent.check();
	await expect(enable).toBeEnabled();
	const geometry = await honcho.locator(".honcho-consent").evaluate(label => {
		const input = label.querySelector("input").getBoundingClientRect(); const text = label.querySelector("span").getBoundingClientRect();
		return { display: getComputedStyle(label).display, gap: text.left - input.right, height: input.height, topDifference: Math.abs(input.top - text.top) };
	});
	assert.equal(geometry.display, "flex"); assert(geometry.gap >= 6 && geometry.height <= 16 && geometry.topDifference <= 4);
	await compactCapture("honcho-setup", honcho);
	await enable.click();
	await expect(honcho.getByRole("button", { name: "Save settings", exact: true })).toBeVisible();
	assert.equal(remoteRequests, 0, "Saving configuration must not silently verify or send memory");
	await page.reload(); await openKestrelDestination(page, "Settings"); await section("agent-memory", "Memory & context");
	await expect(connection).toHaveAttribute("open", "");
	await keyboardToggle(configuration);
	assert.equal(await honcho.getByLabel("Workspace ID", { exact: true }).inputValue(), "owned-disclosure-test");
	await honcho.getByRole("button", { name: "Verify connection", exact: true }).click();
	await expect(honcho.getByRole("alert")).toBeVisible();
	assert(remoteRequests > 0, "Explicit verification must reach the owned server");
	await keyboardToggle(connection);
	await expect(honcho.getByRole("alert")).toBeVisible();
	await keyboardToggle(connection);
	await honcho.getByRole("button", { name: "Disable", exact: true }).click();
	await expect(enable).toBeVisible();
	await honcho.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(honcho.getByRole("button", { name: "Save key", exact: true })).toBeVisible();

	await section("agent-privacy", "Privacy & credentials");
	const credentials = page.locator(".credential-setting");
	const add = credentials.locator(".credential-setup");
	await add.waitFor(); assert.equal(await add.getAttribute("open"), null);
	await keyboardToggle(add);
	const catalog = await page.evaluate(() => window.kestrel.request({ type: "credential-list" }));
	const chooser = credentials.getByRole("combobox", { name: "Credential to add", exact: true });
	await expect(chooser).toBeVisible();
	assert.deepEqual(await chooser.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean)), catalog.credentials.filter(item => !item.configured).map(item => item.id), "All unconfigured credential mappings remain available");
	assert.equal(await add.locator(".credential-entry").count(), 0, "Setup starts with a choice instead of many empty forms");
	const target = catalog.credentials.find(item => !item.configured && item.id !== "honcho"); assert(target);
	await chooser.selectOption(target.id);
	const row = credentials.locator(".credential-entry").filter({ hasText: target.label });
	await row.locator("input").fill("owned-disclosure-credential");
	const alternate = catalog.credentials.find(item => !item.configured && item.id !== target.id); assert(alternate);
	await chooser.selectOption(alternate.id);
	assert.equal(await add.locator(".credential-entry").count(), 1);
	await chooser.selectOption(target.id);
	await keyboardToggle(add); await keyboardToggle(add);
	assert.equal(await row.locator("input").inputValue(), "owned-disclosure-credential");
	await compactCapture("credential-setup", credentials);
	await row.getByRole("button", { name: "Save", exact: true }).click();
	await expect(row.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
	assert.equal(await row.locator("input").inputValue(), "");
	await keyboardToggle(add); await expect(row).toBeVisible();
	const saved = await page.evaluate(() => window.kestrel.request({ type: "credential-list" }));
	assert.equal(saved.credentials.find(item => item.id === target.id).configured, true);
	assert(!JSON.stringify(saved).includes("owned-disclosure-credential"), "Credential summaries remain write-only");
	await row.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(row).toHaveCount(0);
	await keyboardToggle(add); await chooser.selectOption(target.id);
	await expect(row.getByRole("button", { name: "Save", exact: true })).toBeVisible();

	await section("agent-diagnostics", "Diagnostics");
	const custom = page.locator(".custom-agent-setting");
	const setup = custom.locator(".custom-agent-setup");
	await setup.waitFor(); assert.equal(await setup.getAttribute("open"), null);
	await keyboardToggle(setup);
	await custom.getByLabel("Agent ID", { exact: true }).fill("owned-disclosure-profile");
	await custom.getByLabel("Name", { exact: true }).fill("Owned disclosure profile");
	await custom.getByRole("textbox", { name: "Instructions", exact: true }).fill("Review owned fixtures only.");
	await custom.getByLabel("Isolate from shared user memory", { exact: true }).check();
	await keyboardToggle(setup); await keyboardToggle(setup);
	assert.equal(await custom.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(), "Review owned fixtures only.");
	await compactCapture("custom-profile", custom);
	await custom.getByRole("button", { name: "Create agent", exact: true }).click();
	await expect(custom.locator(".workspace-grants")).toContainText("Owned disclosure profile · isolated memory");
	await keyboardToggle(setup);
	await expect(custom.locator(".workspace-grants")).toBeVisible();
	const snapshot = await page.evaluate(() => window.kestrel.request({ type: "snapshot" }));
	const profile = snapshot.snapshot.personality.available.find(item => item.id === "owned-disclosure-profile");
	assert.equal(profile.memoryScope, "isolated"); assert.equal(profile.preferredModel, undefined); assert.equal(profile.providerIds, undefined);
	await custom.locator(".workspace-grants").getByRole("button", { name: "Remove", exact: true }).click();
	await expect(custom.locator(".workspace-grants")).toHaveCount(0);
	assert.deepEqual(runtimeErrors, []);
	console.log("Settings disclosures passed: keyboard/draft retention, explicit remote-data consent, configuration persistence, visible failures, write-only credential mappings/save/remove, isolated custom profiles, compact control geometry. Owned disposable profile/mock keychain and HTTP server; no model generation or real user data.");
} catch (error) {
	if (page && evidence) await page.screenshot({ path: join(evidence, "failure.png") });
	throw error;
} finally {
	await application?.close(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true });
}
