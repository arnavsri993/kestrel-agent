import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Real desktop/Core IPC on a disposable workspace; no provider or real profile.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-missing-file-")));
const evidence = process.env.KESTREL_MISSING_FILE_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const userData = join(root, "profile");
const workspace = join(root, "workspace");
for (const name of ["profile", "workspace", "home", "codex", "tmp"]) mkdirSync(join(root, name));
writeFileSync(join(userData, "workspace-grants.json"), JSON.stringify([{
	id: "missing-file-project", path: workspace, name: "Missing file fixture", order: 0,
	createdAt: "2026-07-22T15:00:00.000Z", updatedAt: "2026-07-22T15:00:00.000Z",
}]));
const childEnvironment = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
	process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(childEnvironment, {
	HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
	USER: "missing-file-fixture", LOGNAME: "missing-file-fixture", KESTREL_TEST_USER_DATA: userData,
	KESTREL_REAL_USER_PROFILE: "1", KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
	KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
if (evidence) mkdirSync(evidence, { recursive: true });
let app;
let page;
async function capture(name) {
	if (!evidence || !page) return;
	await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
	await page.screenshot();
	const png = await app.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
		return (await window.webContents.capturePage()).toPNG().toString("base64");
	});
	writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
	app = await electron.launch({
		executablePath: executable ? resolve(executable) : createRequire(resolve("apps/desktop/package.json"))("electron"),
		args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"], env: childEnvironment,
	});
	page = await app.firstWindow(); page.setDefaultTimeout(15_000);
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	const request = async input => {
		const response = await page.evaluate(input => window.kestrel.request(input), input);
		assert(response.ok, response.error); return response;
	};
	const { session } = await request({ type: "runtime-create-session", kind: "conversation", title: "Missing file read", workspaceRoot: workspace, approvalPolicy: "ask" });
	const call = async (toolName, input, extra = {}) => (await request({ type: "runtime-call-tool", sessionId: session.id, toolName, input, ...extra })).execution;
	const missing = await call("workspace.read", { path: "new-brief.md" });
	assert.equal(missing.status, "failed");
	assert.equal(missing.output, undefined);
	assert.equal(missing.error, 'File not found in this workspace: "new-brief.md". Check the file name and parent folder.');
	const absentParent = await call("workspace.read", { path: "missing-parent/new-brief.md" });
	assert.equal(absentParent.status, "failed");
	assert(absentParent.error.startsWith("File not found in this workspace:"));
	const blockedWrite = await call("workspace.write", { path: "new-brief.md", content: "Must await approval." }, { idempotencyKey: "fixture-write" });
	assert.equal(blockedWrite.status, "blocked");
	assert.equal(blockedWrite.output?.approvalRequired, true);
	// The fixture creates this file itself; this is not an agent save or approval.
	writeFileSync(join(workspace, "new-brief.md"), "Disposable readback evidence.\n");
	const readback = await call("workspace.read", { path: "new-brief.md" });
	assert.equal(readback.status, "verified");
	assert.equal(readback.output?.content, readFileSync(join(workspace, "new-brief.md"), "utf8"));
	for (const execution of [missing, readback]) await request({
		type: "runtime-append-message", sessionId: session.id, role: "tool", toolExecutionId: execution.id,
		content: JSON.stringify({ status: execution.status, error: execution.error, output: execution.output }),
	});
	await request({ type: "runtime-append-message", sessionId: session.id, role: "assistant", content: "The initial read found no file. After the fixture created it, a later read succeeded." });
	await request({ type: "runtime-select-session", sessionId: session.id });
	await page.reload();
	await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
		window.setSize(1440, 900);
	});
	const toggle = page.locator("#browser-agent-toggle"); await toggle.waitFor();
	if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
	const host = page.locator(".agent-conversation-host");
	await expect(host.locator(".runtime-tool-error, .work-summary").filter({ hasText: "File not found in this workspace:" })).toBeVisible();
	await expect(host.getByText("The initial read found no file.", { exact: false })).toBeVisible();
	const persisted = (await request({ type: "runtime-list-executions", sessionId: session.id })).executions;
	assert.equal(persisted.find(item => item.id === missing.id)?.status, "failed");
	assert.equal(persisted.find(item => item.id === blockedWrite.id)?.status, "blocked");
	await capture("missing-file-desktop.png");
	assert.deepEqual(errors, []);
	if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({ executable: executable ?? "source Electron", failedRead: missing.status, blockedWrite: blockedWrite.status, laterRead: readback.status, fileCreatedByFixture: true, realProfileVerified: false }, null, 2));
	console.log("Missing file smoke passed: clear failed read, preserved approval boundary, later read and durable execution history.");
} catch (error) {
	await capture("failure.png").catch(() => {}); throw error;
} finally {
	await app?.close().catch(() => {}); rmSync(root, { recursive: true, force: true });
}
