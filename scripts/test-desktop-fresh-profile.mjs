import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-fresh-profile-"));
const testHome = join(root, "home");
const testCodexHome = join(root, "codex-home");
mkdirSync(testHome, { recursive: true });
mkdirSync(testCodexHome, { recursive: true });
const testEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]]],
	),
);
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];
let application;

async function launch() {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...testEnvironment,
			HOME: testHome,
			USER: "kestrel-test",
			LOGNAME: "kestrel-test",
			CODEX_HOME: testCodexHome,
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
			KESTREL_REAL_USER_PROFILE: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
		},
	});
	return application.firstWindow();
}

async function assertFresh(page) {
	await page.locator("#runtime-prompt").waitFor();
	const response = await page.evaluate(() =>
		window.kestrel.request({ type: "snapshot" }),
	);
	assert.equal(response.ok, true);
	assert.equal(response.snapshot?.agentState, "idle");
	assert.deepEqual(response.snapshot?.approvals, []);
	assert.deepEqual(response.snapshot?.memories, []);
	assert.deepEqual(response.snapshot?.activity, []);
	assert.equal(
		await page
			.getByText("Finalize the Monday test plan?", { exact: true })
			.count(),
		0,
	);
	assert.equal(
		await page.getByText("Needs Your Approval", { exact: true }).count(),
		0,
	);
	assert.equal(await page.getByRole("button", { name: "Review a project" }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Plan a task" }).count(), 0);
}

async function assertNoProviderComposerState(page) {
	const taskInput = page.getByRole("textbox", { name: "Message Kestrel" });
	await taskInput.fill("Plan a safe task.");
	await page
		.locator(".agent-conversation-host .composer-status")
		.filter({ hasText: "Connect a model to send tasks." })
		.waitFor();
	assert.equal(
		await page
			.locator(".agent-conversation-host")
			.getByRole("button", { name: "Send message", exact: true })
			.isDisabled(),
		true,
	);

	const newTabInput = page.locator("#new-tab-chat-input");
	await newTabInput.fill("Plan a safe task.");
	await page
		.locator(".kestrel-home-composer")
		.getByText("Connect a model to send tasks.", { exact: true })
		.waitFor();
	const newTabSend = page.locator(
		".kestrel-home-composer .kestrel-home-send",
	);
	assert.equal(
		await newTabSend.isDisabled(),
		true,
	);
	await newTabInput.fill("https://127.0.0.1");
	assert.equal(
		await newTabSend.isEnabled(),
		true,
		"Browsing a URL must remain available without a configured model.",
	);
	const sessionIdsBeforeFirstTask = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		return response.ok && "sessions" in response
			? (response.sessions ?? []).map((session) => session.id)
			: [];
	});
	await page.evaluate(() => localStorage.setItem("kestrel:first-task", "yes"));
	await page.reload();
	await page
		.locator(".agent-conversation-host .composer-status")
		.filter({ hasText: "Connect a model to send tasks." })
		.waitFor();
	assert.deepEqual(
		await page.evaluate(async () => {
			const response = await window.kestrel.request({
				type: "runtime-list-sessions",
			});
			return response.ok && "sessions" in response
				? (response.sessions ?? []).map((session) => session.id)
				: [];
		}),
		sessionIdsBeforeFirstTask,
		"The guided first task must not create a session before a model route exists.",
	);

	await page
		.locator(".agent-conversation-host")
		.getByRole("button", { name: "Connect a model", exact: true })
		.click();
	await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
}

try {
	let page = await launch();
	await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
	await page.reload();
	await assertFresh(page);
	await assertNoProviderComposerState(page);
	await application.close();
	application = undefined;

	page = await launch();
	await assertFresh(page);
	process.stdout.write(
		"Fresh desktop profile starts idle, empty, and restart-safe without development fixtures.\n",
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
