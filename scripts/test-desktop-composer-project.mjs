import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-composer-project-")));
for (const name of ["profile", "alpha", "beta", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_COMPOSER_PROJECT_EVIDENCE_DIR;
// PR #812 owns the pre-existing draft scope-binding fix. Enable its extra
// submission/unavailable-folder checks when verifying the integrated candidate.
const verifyRebinding = process.env.KESTREL_COMPOSER_PROJECT_VERIFY_REBINDING === "1";
if (evidence) mkdirSync(evidence, { recursive: true });
const now = new Date().toISOString();
const longName = "Beta project with a deliberately long descriptive workspace name for compact layout verification";
const projects = ["alpha", "beta", "missing"].map((name, order) => ({
	id: `project-${name}`, name: name === "missing" ? "Missing folder" : name === "alpha" ? "Alpha" : longName,
	path: join(root, name), order, createdAt: now, updatedAt: now,
}));
writeFileSync(join(root, "profile", "workspace-grants.json"), JSON.stringify(projects));
const providerErrors = [];
const server = createServer(async (request, response) => {
	try {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }));
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
		for await (const _chunk of request) { /* Synthetic provider only; no external model. */ }
		const event = { id: "composer-scope-fixture", model: "fixture-model", choices: [{ index: 0, delta: { content: "Composer scope fixture response." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }).end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
	} catch (error) { providerErrors.push(String(error)); response.writeHead(500).end("Fixture failed."); }
});
await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
let application;
let page;
const runtimeErrors = [];
const bindingResults = [];
const host = () => page.locator(".agent-conversation-host");
const cue = () => host().locator(".composer-project-scope");
const details = () => host().locator(".task-settings");
const select = () => details().locator(".runtime-project-picker select");
async function capture(name) {
	if (!evidence) return;
	const png = await application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
		return (await window.webContents.capturePage()).toPNG().toString("base64");
	});
	writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
async function closeSettings() {
	if (await details().getAttribute("open") !== null) await page.keyboard.press("Escape");
	await expect(details()).not.toHaveAttribute("open");
}
async function newTask() {
	const toggle = page.locator("#browser-agent-toggle");
	await toggle.waitFor();
	if (await toggle.getAttribute("aria-expanded") === "true") {
		const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
		if (await closeChat.isVisible()) await closeChat.click();
	}
	const sidebar = page.locator(".kestrel-sidebar");
	const expand = sidebar.getByRole("button", { name: "Expand sidebar", exact: true });
	if (await expand.isVisible()) await expand.click();
	await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
	await host().waitFor();
	await page.locator("#runtime-prompt").waitFor();
	await closeSettings();
}
async function revealChat() {
	if (await cue().isVisible()) return;
	const compactEntry = page.locator(".agent-compact-entry");
	if (await compactEntry.isVisible()) {
		await compactEntry.click();
		await expect(cue()).toBeVisible();
		return;
	}
	const toggle = page.locator("#browser-agent-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(cue()).toBeVisible();
}
async function checkCue(name, screenshot) {
	if (evidence && screenshot) await capture(screenshot);
	assert.equal(await cue().count(), 1, "The inherited draft project needs a visible, actionable composer cue");
	await expect(cue()).toBeVisible();
	await expect(cue()).toHaveAccessibleName(`Choose project: ${name}`);
	await expect(cue().locator("strong")).toHaveText(name);
	await expect(details()).not.toHaveAttribute("open");
	assert(await cue().evaluate(node => {
		const parent = node.closest("form").getBoundingClientRect();
		const bounds = node.getBoundingClientRect();
		return bounds.width > 0 && bounds.left >= parent.left && bounds.right <= parent.right + 1 && node.scrollWidth <= node.clientWidth + 1;
	}), "Project cue must fit the composer without horizontal overflow");
}
async function chooseProject(value) {
	await cue().focus();
	await page.keyboard.press("Enter");
	await expect(select()).toBeFocused();
	await select().selectOption(value);
	await page.keyboard.press("Escape");
	await expect(cue()).toBeFocused();
	await expect(details()).not.toHaveAttribute("open");
}
async function submitAndCheck(title, projectId, workspaceRoot) {
	await page.locator("#runtime-prompt").fill(title);
	await host().getByRole("button", { name: "Send message", exact: true }).click();
	await host().getByText("Composer scope fixture response.", { exact: true }).waitFor();
	const response = await page.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(response.ok);
	const session = response.sessions.find(item => item.title === title);
	assert(session, "Fixture task was not created.");
	assert.equal(session.projectId, projectId, "Submitted project must match the displayed choice");
	assert.equal(session.workspaceRoot, workspaceRoot, "Submitted workspace must match the displayed choice");
	bindingResults.push({ title, projectId: session.projectId ?? null, workspaceMatches: session.workspaceRoot === workspaceRoot });
	await expect(cue()).toHaveCount(0);
}
try {
	const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE;
	const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
	application = await electron.launch({
		executablePath: executablePath ? resolve(executablePath) : requireFromDesktop("electron"),
		args: [...(executablePath ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
		env: { ...env, HOME: join(root, "home"), USER: "composer-fixture", LOGNAME: "composer-fixture", CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
			KESTREL_TEST_USER_DATA: join(root, "profile"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1", KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", NOUS_API_KEY: "synthetic-fixture",
			NOUS_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, NOUS_MODEL: "fixture-model" },
	});
	page = await application.firstWindow(); page.setDefaultTimeout(20_000);
	page.on("pageerror", error => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
		window.setMinimumSize(360, 360); window.setSize(1440, 900);
	});
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.setItem("kestrel:active-project-id", "project-alpha"); localStorage.setItem("kestrel:agent-sidebar", "collapsed");
		localStorage.setItem("kestrel:execution-mode", "manual"); localStorage.setItem("kestrel:provider-id", "nous"); localStorage.setItem("kestrel:model", "fixture-model");
	});
	await page.reload();
	await page.locator(".kestrel-sidebar-project-open").filter({ hasText: "Alpha" }).waitFor();
	await newTask();
	await checkCue("Alpha", "inherited-alpha.png");
	for (const key of ["Enter", "Space"]) {
		await cue().focus(); await page.keyboard.press(key);
		await expect(select()).toBeFocused(); assert.equal(await select().inputValue(), projects[0].path);
		await page.keyboard.press("Escape"); await expect(cue()).toBeFocused();
	}
	await details().locator("summary").click();
	await select().waitFor(); await page.keyboard.press("Escape");
	await expect(details().locator("summary")).toBeFocused();
	const browserButton = page.locator(".kestrel-sidebar").getByRole("button", { name: /^Open .+ browser$/ });
	await cue().click(); await browserButton.click();
	await expect(details()).not.toHaveAttribute("open");
	await cue().focus(); await page.keyboard.press("Enter"); await expect(select()).toBeFocused();
	const modelButton = host().getByRole("button", { name: /^Model:/ });
	for (let count = 0; count < 20 && !await modelButton.evaluate(node => node === document.activeElement); count++) {
		await page.keyboard.press("Shift+Tab");
	}
	await expect(modelButton).toBeFocused(); await expect(details()).not.toHaveAttribute("open");
	await page.keyboard.press("Enter");
	const modelDialog = page.getByRole("dialog", { name: "Choose a provider, account, model, and thinking level" });
	await expect(modelDialog).toBeVisible(); await page.keyboard.press("Escape");
	await expect(modelDialog).not.toBeVisible(); await expect(modelButton).toBeFocused();
	await chooseProject("");
	await checkCue("Conversation only", "conversation-only.png");
	if (verifyRebinding) await submitAndCheck("Conversation-only cue fixture", undefined, undefined);
	else {
		await chooseProject(projects[0].path); await checkCue("Alpha");
		await submitAndCheck("Inherited Alpha cue fixture", "project-alpha", projects[0].path);
	}
	await newTask(); await chooseProject(projects[1].path);
	const widths = verifyRebinding ? [1440, 1024, 740] : [1440, 1024, 840];
	for (const width of widths) {
		await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.setSize(width, 900), width);
		await page.waitForFunction(width => innerWidth === width, width);
		await revealChat();
		await checkCue(longName, `long-name-${width}.png`);
		await cue().focus(); await page.keyboard.press("Enter"); await expect(select()).toBeFocused();
		await page.keyboard.press("Escape"); await expect(cue()).toBeFocused();
	}
	// Main's older compact layout hides chat below 760 CSS pixels. Verify zoom
	// at a supported width there; the integrated candidate also covers 740px.
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.setSize(1920, 900));
	await page.waitForFunction(() => innerWidth === 1920);
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.webContents.setZoomFactor(2));
	await page.waitForFunction(() => innerWidth === 960);
	await revealChat();
	await checkCue(longName, "long-name-200-percent.png");
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.webContents.setZoomFactor(1));
	if (verifyRebinding) {
		await submitAndCheck("Beta project cue fixture", "project-beta", projects[1].path);
		await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.setSize(1440, 900));
		await page.evaluate(() => localStorage.setItem("kestrel:active-project-id", "project-missing"));
		await page.reload(); await newTask();
		await checkCue("Missing folder · unavailable", "unavailable-folder.png");
		await chooseProject(""); await checkCue("Conversation only");
	}
	assert.deepEqual(providerErrors, []); assert.deepEqual(runtimeErrors, []);
	if (evidence) writeFileSync(join(evidence, "scope-bindings.json"), JSON.stringify(bindingResults, null, 2));
	console.log(`Composer project cue passed: inherited scope, visible picker choices, Enter/Space/Escape focus, outside dismissal, model-dialog focus, long names at ${widths.join("/")} and 200% zoom. ${verifyRebinding ? "Integrated PR #812: conversation/project submissions and unavailable folder passed." : "Inherited Alpha submission passed; changed-scope submission/unavailable-folder checks require PR #812 and explicit KESTREL_COMPOSER_PROJECT_VERIFY_REBINDING=1."} Synthetic provider; disposable profile/home and mock Keychain.`);
} catch (error) {
	if (page && evidence) await capture("failure.png");
	throw error;
} finally {
	await application?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true });
}
