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
async function checkDelayedSettingsNavigation() {
	await page.locator(".honcho-memory-setting").scrollIntoViewIfNeeded();
	let navigationSettled = false;
	let navigationError;
	const navigation = openKestrelDestination(page, "Settings", {
		beforeSelect: () => application.evaluate(() => {
			globalThis.__kestrelChannelFixture.blockNextTabSelection = true;
		}),
	}).then(
		() => { navigationSettled = true; },
		(error) => { navigationSettled = true; navigationError = error; },
	);
	await expect.poll(() => application.evaluate(() => globalThis.__kestrelChannelFixture.pendingTabSelections.length)).toBe(1);
	await new Promise(done => setImmediate(done));
	assert.equal(navigationSettled, false, "Settings navigation must not resolve while its tab selection is still blocked");
	await application.evaluate(() => {
		globalThis.__kestrelChannelFixture.pendingTabSelections.splice(0).forEach(release => release());
	});
	await navigation;
	if (navigationError) throw navigationError;
	await section("agent-memory", "Memory & context");
	const geometry = await page.evaluate(() => {
		const viewport = document.querySelector("#browser-viewport").getBoundingClientRect();
		const route = document.querySelector('.browser-app-page[data-app-page="settings"]');
		const button = [...route.querySelectorAll(".settings-nav button")].find(node => node.textContent?.trim() === "Memory & context");
		const picker = route.querySelector(".settings-section-picker select");
		const target = button.checkVisibility() ? button : picker;
		const bounds = target.getBoundingClientRect();
		const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		const rect = value => Object.fromEntries(["x", "y", "top", "right", "bottom", "left", "width", "height"].map(key => [key, value[key]]));
		return {
			insideViewport: bounds.left >= viewport.left && bounds.right <= viewport.right && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
			hitTarget: target === hit || target.contains(hit),
			target: target === button ? "sticky navigation" : "compact picker",
			position: getComputedStyle(route.querySelector(".settings-nav")).position,
			viewport: rect(viewport),
			button: rect(bounds),
			hit: hit ? { tag: hit.tagName, id: hit.id, className: typeof hit.className === "string" ? hit.className : "" } : null,
		};
	});
	assert(geometry.insideViewport && geometry.hitTarget && (geometry.target === "compact picker" || geometry.position === "sticky"), `A delayed Settings route must leave its responsive section control inside the active viewport and hit-testable: ${JSON.stringify(geometry)}`);
}
async function keyboardToggle(details) {
	await details.locator("summary").first().focus();
	await page.keyboard.press("Enter");
}
async function desktopChat(open) {
	const toggle = page.locator("#browser-agent-toggle");
	await toggle.waitFor({ state: "attached" });
	if (await toggle.getAttribute("aria-expanded") !== String(open)) await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", String(open));
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
async function channelControlsFit(name, row) {
	await row.scrollIntoViewIfNeeded();
	const escaped = await row.locator(".channel-interaction-grid").evaluate(grid => {
		const bounds = grid.getBoundingClientRect();
		return [...grid.querySelectorAll("label, select")].filter(node => {
			const box = node.getBoundingClientRect();
			return box.left < bounds.left - 1 || box.right > bounds.right + 1;
		}).map(node => node.getAttribute("aria-label") ?? node.textContent.trim());
	});
	assert.deepEqual(escaped, [], `${name}: all four channel controls must fit the form itself`);
	if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
}
async function checkChannelSettings() {
	await desktopChat(false);
	const row = page.locator(".channel-interaction-setting");
	const setup = row.locator(".channel-interaction-setup");
	await setup.waitFor();
	assert.equal(await setup.getAttribute("open"), null, "No-channel policy setup starts folded");
	await expect(row).toContainText("No messaging channels configured yet.");
	await keyboardToggle(setup);
	const progress = row.getByRole("combobox", { name: "Channel progress mode", exact: true });
	const typing = row.getByRole("combobox", { name: "Channel typing mode", exact: true });
	const interval = row.getByRole("combobox", { name: "Typing refresh interval", exact: true });
	const reaction = row.getByRole("combobox", { name: "Channel reaction level", exact: true });
	const selections = async () => Promise.all([progress.inputValue(), typing.inputValue(), interval.inputValue(), reaction.inputValue()]);
	const save = row.getByRole("button", { name: "Save channel policy", exact: true });
	await progress.selectOption("off"); await typing.selectOption("never"); await interval.selectOption("20"); await reaction.selectOption("extensive");
	const desired = ["off", "never", "20", "extensive"];
	await channelControlsFit("channel-policy-chat-closed", row);
	await desktopChat(true);
	await page.waitForFunction(() => !document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-collapsed"));
	await channelControlsFit("channel-policy-chat-docked", row);
	await desktopChat(false);
	await compactCapture("channel-policy", row);

	// Hold the real persisted GET result, save new selections, then deliver the
	// stale result. This recreates the refresh/save race without mocking storage.
	await application.evaluate(() => { globalThis.__kestrelChannelFixture.holdGets = true; });
	await keyboardToggle(setup);
	await expect.poll(() => application.evaluate(() => globalThis.__kestrelChannelFixture.pendingGets.length), { timeout: 25_000 }).toBeGreaterThan(0);
	assert.equal(await setup.getAttribute("open"), null, "Refresh retains the user's folded state");
	await keyboardToggle(setup);
	assert.deepEqual(await selections(), desired, "Folding and a pending refresh retain edits");
	await save.click();
	await expect(row.getByRole("status")).toHaveText("Channel interaction policy saved.");
	await application.evaluate(() => { const fixture = globalThis.__kestrelChannelFixture; fixture.holdGets = false; fixture.pendingGets.splice(0).forEach(release => release()); });
	await expect.poll(() => application.evaluate(() => globalThis.__kestrelChannelFixture.inFlightGets)).toBe(0);
	assert.deepEqual(await selections(), desired, "A pre-save refresh cannot replace successful saved selections");
	await keyboardToggle(setup); await expect(row.getByRole("status")).toBeVisible();
	await page.reload(); await openKestrelDestination(page, "Settings"); await section("agent-memory", "Memory & context");
	assert.equal(await setup.getAttribute("open"), null);
	await keyboardToggle(setup); assert.deepEqual(await selections(), desired, "All four values persist through the real core and reload");

	await application.evaluate(() => { globalThis.__kestrelChannelFixture.failSave = true; });
	await reaction.selectOption("ack"); await save.click();
	await expect(row.getByRole("alert")).toHaveText("Owned channel save failure.");
	await keyboardToggle(setup); await expect(row.getByRole("alert")).toBeVisible();
	const beforePoll = await application.evaluate(() => globalThis.__kestrelChannelFixture.completedGets);
	await expect.poll(() => application.evaluate(() => globalThis.__kestrelChannelFixture.completedGets), { timeout: 25_000 }).toBeGreaterThan(beforePoll);
	assert.equal(await setup.getAttribute("open"), null);
	await keyboardToggle(setup); assert.deepEqual(await selections(), ["off", "never", "20", "ack"], "A refresh after failed save cannot discard the unsaved draft");
	await application.evaluate(() => { const fixture = globalThis.__kestrelChannelFixture; fixture.failSave = false; fixture.channels = [
		{ id: "owned-slack", kind: "slack", inbound: true, editableProgress: true, typingSignals: false, reactions: true },
		{ id: "owned-webhook", kind: "webhook", inbound: false, editableProgress: false, typingSignals: true, reactions: false },
	]; });
	await page.reload(); await openKestrelDestination(page, "Settings"); await section("agent-memory", "Memory & context");
	await expect(setup).toHaveAttribute("open", "");
	await expect(row).toContainText("1 editable · 1 with typing · 1 with reactions · 2 configured");
	assert.deepEqual(await selections(), desired, "Configured-channel summaries preserve actual persisted values");
	await keyboardToggle(setup);
	const configuredPoll = await application.evaluate(() => globalThis.__kestrelChannelFixture.completedGets);
	await expect.poll(() => application.evaluate(() => globalThis.__kestrelChannelFixture.completedGets), { timeout: 25_000 }).toBeGreaterThan(configuredPoll);
	assert.equal(await setup.getAttribute("open"), null, "Configured-channel refresh also retains a user-collapsed form");
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
	// Fixture-only IPC interception supplies synthetic channel capability counts
	// and controlled response timing/failure. Real GET/SET storage stays in use.
	await application.evaluate(({ ipcMain }) => {
		const original = ipcMain._invokeHandlers?.get("kestrel:request");
		if (typeof original !== "function") throw new Error("Owned channel fixture cannot capture the desktop request handler.");
		const fixture = { channels: null, holdGets: false, pendingGets: [], inFlightGets: 0, completedGets: 0, failSave: false, blockNextTabSelection: false, pendingTabSelections: [] };
		globalThis.__kestrelChannelFixture = fixture;
		ipcMain.removeHandler("kestrel:request");
		ipcMain.handle("kestrel:request", async (event, request) => {
			if (request.type === "browser-select-tab" && fixture.blockNextTabSelection) {
				fixture.blockNextTabSelection = false;
				await new Promise(done => fixture.pendingTabSelections.push(done));
			}
			if (request.type === "channel-list" && fixture.channels) return { ok: true, channels: fixture.channels };
			if (request.type === "channel-interaction-set" && fixture.failSave) return { ok: false, error: "Owned channel save failure." };
			if (request.type !== "channel-interaction-get") return original(event, request);
			fixture.inFlightGets += 1;
			try {
				const result = await original(event, request);
				if (fixture.holdGets) await new Promise(done => fixture.pendingGets.push(done));
				fixture.completedGets += 1;
				return result;
			} finally { fixture.inFlightGets -= 1; }
		});
	});
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
	await page.reload();
	await page.setViewportSize({ width: 1440, height: 900 });
	await openKestrelDestination(page, "Settings");
	const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
	if (await closeChat.isVisible()) await closeChat.click();

	await section("agent-memory", "Memory & context");
	await checkDelayedSettingsNavigation();
	await checkChannelSettings();
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
	console.log("Settings disclosures passed: channel four-field storage, configured/unused disclosure defaults, live polling draft retention and stale refresh/save race, docked/closed/compact control geometry, keyboard/draft retention, explicit remote-data consent, visible failures, write-only credential mappings/save/remove, isolated custom profiles. Owned disposable profile/mock keychain and HTTP server; no model generation or real user data.");
} catch (error) {
	if (page && evidence) await page.screenshot({ path: join(evidence, "failure.png") });
	throw error;
} finally {
	await application?.close(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true });
}
