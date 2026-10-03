import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-task-scope-")));
for (const name of ["profile", "alpha", "beta", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidenceDirectory = process.env.KESTREL_TASK_SCOPE_EVIDENCE_DIR;
if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
const now = new Date().toISOString();
const projects = ["alpha", "beta", "missing"].map((name, order) => ({
	id: `project-${name}`, name: name === "missing" ? "Missing folder" : name === "alpha" ? "Alpha" : "Beta",
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
		for await (const _chunk of request) { /* Drain the synthetic request; no real model is invoked. */ }
		const event = { id: "scope-fixture", model: "fixture-model", choices: [{ index: 0, delta: { content: "Scope fixture completed." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }).end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
	} catch (error) { providerErrors.push(String(error)); response.writeHead(500).end("Scope fixture failed."); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
let application;
let page;
const runtimeErrors = [];
async function settings() {
	const details = page.locator(".agent-conversation-host .task-settings");
	await details.waitFor();
	if (await details.getAttribute("open") === null) await details.locator("summary").click();
	const select = details.locator(".runtime-project-picker select");
	await select.waitFor();
	return { details, select };
}
async function newTask() {
	await page.getByRole("button", { name: "New task", exact: true }).click();
	return settings();
}
async function submitAndCheck(title, projectId, workspaceRoot) {
	const details = page.locator(".agent-conversation-host .task-settings");
	if (await details.getAttribute("open") !== null) await details.locator("summary").click();
	await page.locator("#runtime-prompt").fill(title);
	await page.locator(".agent-conversation-host").getByRole("button", { name: "Send message", exact: true }).click();
	await page.locator(".agent-conversation-host").getByText("Scope fixture completed.", { exact: true }).waitFor();
	const response = await page.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
	assert(response.ok);
	const session = response.sessions.find(item => item.title === title);
	assert(session, "The fixture task was not created.");
	assert.equal(session.projectId, projectId, "The task project must match the visible choice.");
	assert.equal(session.workspaceRoot, workspaceRoot, "The task file scope must match the visible choice.");
}
try {
	const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE;
	const env = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
	application = await electron.launch({
		executablePath: executablePath ?? requireFromDesktop("electron"),
		args: [...(executablePath ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
		env: { ...env, HOME: join(root, "home"), USER: "scope-fixture", LOGNAME: "scope-fixture", CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
			KESTREL_TEST_USER_DATA: join(root, "profile"), KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1", KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", NOUS_API_KEY: "synthetic-fixture",
			NOUS_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, NOUS_MODEL: "fixture-model" },
	});
	page = await application.firstWindow(); page.setDefaultTimeout(20_000);
	page.on("pageerror", error => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.setSize(1440, 900));
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.removeItem("kestrel:active-project-id"); localStorage.setItem("kestrel:execution-mode", "manual"); localStorage.setItem("kestrel:provider-id", "nous"); localStorage.setItem("kestrel:model", "fixture-model");
	});
	await page.reload();
	const toggle = page.locator("#browser-agent-toggle"); await toggle.waitFor();
	if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
	let choice = await settings();
	await choice.select.locator('option[value="' + projects[0].path + '"]').waitFor({ state: "attached" });
	assert.equal(await choice.select.inputValue(), "", "Loading projects must not silently grant the first folder to a draft.");
	await page.evaluate(() => localStorage.setItem("kestrel:active-project-id", "project-alpha"));
	await page.reload();
	choice = await newTask();
	assert.equal(await choice.select.inputValue(), projects[0].path);
	await choice.select.selectOption("");
	await choice.details.locator("summary").click();
	const beta = page.locator(".kestrel-sidebar-project-open").filter({ hasText: "Beta" });
	await beta.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Project settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Project settings" });
	await dialog.getByLabel("Project name").fill("Beta refreshed");
	await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
	await dialog.waitFor({ state: "detached" });
	choice = await settings();
	assert.equal(await choice.select.inputValue(), "", "Refreshing project metadata must preserve Conversation only.");
	await submitAndCheck("Conversation-only scope fixture", undefined, undefined);
	choice = await newTask();
	await choice.select.selectOption(projects[1].path);
	await submitAndCheck("Beta project scope fixture", "project-beta", projects[1].path);
	await page.evaluate(() => localStorage.setItem("kestrel:active-project-id", "project-missing"));
	await page.reload();
	choice = await newTask();
	assert.equal(await choice.select.inputValue(), projects[2].path);
	assert.match(await choice.select.locator("option:checked").innerText(), /Missing folder.*unavailable/);
	assert.equal(await choice.select.locator("option:checked").evaluate(option => option.disabled), true,
		"The unavailable native option must be disabled without disabling the project picker.");
	await page.getByRole("button", { name: "Project files unavailable", exact: true }).waitFor();
	if (evidenceDirectory) await page.screenshot({ path: join(evidenceDirectory, "unavailable-project.png") });
	await choice.select.selectOption("");
	await submitAndCheck("Missing-project conversation-only fixture", undefined, undefined);
	assert.deepEqual(providerErrors, []); assert.deepEqual(runtimeErrors, []);
	console.log("Task scope passed: conversation-only default/refresh/submit, selected project binding, honest unavailable option, and explicit removal of inherited file scope. Provider: synthetic HTTP fixture; no model generation; isolated profile/home.");
} catch (error) {
	if (page && evidenceDirectory) await page.screenshot({ path: join(evidenceDirectory, "task-scope-failure.png") });
	throw error;
} finally {
	await application?.close(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true });
}
