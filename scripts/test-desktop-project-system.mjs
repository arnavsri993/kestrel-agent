import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-projects-"));
const userData = join(root, "user-data");
const alphaPath = join(root, "alpha");
const betaPath = join(root, "beta");
const gammaPath = join(root, "gamma");
mkdirSync(userData, { recursive: true });
mkdirSync(alphaPath);
mkdirSync(betaPath);
mkdirSync(gammaPath);

const now = "2026-09-03T00:00:00.000Z";
const projects = [
	{
		id: "project-alpha",
		path: realpathSync(alphaPath),
		name: "Alpha",
		createdAt: now,
		updatedAt: now,
		order: 0,
	},
	{
		id: "project-beta",
		path: realpathSync(betaPath),
		name: "Beta",
		createdAt: now,
		updatedAt: now,
		order: 1,
	},
	{
		id: "project-gamma",
		path: realpathSync(gammaPath),
		name: "Gamma",
		createdAt: now,
		updatedAt: now,
		order: 2,
	},
];
writeFileSync(
	join(userData, "workspace-grants.json"),
	`${JSON.stringify(projects, null, 2)}\n`,
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
let page;
const pageErrors = [];
const consoleErrors = [];

async function request(input) {
	return page.evaluate(
		(requestInput) => window.kestrel.request(requestInput),
		input,
	);
}

async function waitForProject(projectName) {
	const row = page
		.locator(".kestrel-sidebar-project-open")
		.filter({ hasText: projectName })
		.first();
	await row.waitFor();
	return row;
}

async function waitForSession(sessionId) {
	await page.waitForFunction(async (expectedId) => {
		const response = await window.kestrel.request({ type: "runtime-list-sessions" });
		return response.ok && "sessions" in response &&
			(response.sessions ?? []).some((session) => session.id === expectedId);
	}, sessionId);
}

async function createSession(title, projectId) {
	const response = await request({
		type: "runtime-create-session",
		title,
		...(projectId ? { projectId } : {}),
	});
	assert.equal(response.ok, true, `Could not create ${title}.`);
	assert(response.session, `No session returned for ${title}.`);
	await waitForSession(response.session.id);
	return response.session;
}

async function openProjectSettings(projectRow) {
	await projectRow.click({ button: "right" });
	const menu = page.getByRole("menu");
	await menu.waitFor();
	await menu.getByRole("menuitem", { name: "Project settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Project settings" });
	await dialog.waitFor();
	return dialog;
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.waitForLoadState("domcontentloaded");
	await page.waitForFunction(() => typeof window.kestrel?.request === "function");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.removeItem("kestrel:active-project-id");
		localStorage.removeItem("kestrel:project-expanded");
	});
	await page.reload();
	await page.locator(".kestrel-sidebar").waitFor();
	const sidebar = page.locator(".kestrel-sidebar");
	await waitForProject("Alpha");
	await waitForProject("Beta");
	await waitForProject("Gamma");

	const sidebarText = await sidebar.textContent();
	assert.doesNotMatch(sidebarText ?? "", /workspace/i);
	assert.equal(await sidebar.locator(".kestrel-sidebar-chats h2 svg").count(), 0);
	assert.equal(
		await sidebar.locator(".kestrel-sidebar-list-item svg").count(),
		0,
		"Global chat rows must not display redundant chat icons.",
	);

	const alphaSessions = await Promise.all(
		Array.from({ length: 6 }, (_, index) =>
			createSession(`Alpha chat ${index + 1}`, "project-alpha"),
		),
	);
	const betaSession = await createSession("Beta chat", "project-beta");
	const globalSession = await createSession("Global chat", null);
	// Session-created events can race one another; reload once so the renderer
	// exercises its durable list rather than a transient event snapshot.
	await page.reload();
	await sidebar.waitFor();
	await waitForProject("Alpha");
	await page.waitForFunction(() =>
		document.querySelectorAll(".kestrel-sidebar-list-item").length >= 1,
	);

	const alphaRow = await waitForProject("Alpha");
	await alphaRow.click();
	await page.locator(".projects-workspace").waitFor();
	await page.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
	const alphaChildChats = page.locator(".kestrel-sidebar-project-chat");
	await alphaChildChats.first().waitFor();
	assert.equal(await alphaChildChats.count(), 5, "Project previews should be bounded.");
	assert.equal(await page.getByRole("button", { name: "Show more", exact: true }).count(), 1);
	const alphaChild = alphaChildChats.first();
	const parentBounds = await alphaRow.boundingBox();
	const childBounds = await alphaChild.boundingBox();
	assert(parentBounds && childBounds, "Project hierarchy rows should have bounds.");
	assert.ok(childBounds.x > parentBounds.x + 10, "Project chats must be visibly indented.");
	assert.equal(await alphaRow.locator("button").count(), 0);
	assert.doesNotMatch((await alphaRow.textContent()) ?? "", /chat/i);
	await page.getByRole("button", { name: "Show more", exact: true }).click();
	await page.waitForFunction(() =>
		document.querySelectorAll(".kestrel-sidebar-project-chat").length === 7,
	);
	assert.equal(
		await page.locator(".kestrel-sidebar-project-chat").filter({ hasText: "General" }).count(),
		1,
		"The legacy workspace-backed main session should remain in its migrated project.",
	);

	const betaRow = await waitForProject("Beta");
	await betaRow.click();
	await page.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Beta chat" }).waitFor();
	assert.equal(await page.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Alpha chat" }).count(), 0);
	assert.match((await betaRow.getAttribute("class")) ?? "", /active/);

	const gammaRow = await waitForProject("Gamma");
	await gammaRow.click();
	await page.getByText("No chats yet", { exact: true }).waitFor();

	const gammaDialog = await openProjectSettings(gammaRow);
	await gammaDialog.getByLabel("Project name").fill("Gamma renamed");
	await gammaDialog.getByLabel("Instructions").fill("Keep this project focused.");
	await gammaDialog.getByRole("button", { name: "Compass", exact: true }).click();
	await gammaDialog.getByRole("button", { name: "Sky", exact: true }).click();
	await gammaDialog.getByRole("button", { name: "Save changes", exact: true }).click();
	await gammaDialog.waitFor({ state: "detached" });
	await waitForProject("Gamma renamed");
	const storedProjects = await request({ type: "get-workspace-grants" });
	assert.equal(storedProjects.ok, true);
	assert.equal(storedProjects.projects.find((project) => project.id === "project-gamma").instructions, "Keep this project focused.");

	const renamedGamma = await waitForProject("Gamma renamed");
	const contextDialog = await openProjectSettings(renamedGamma);
	await contextDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await contextDialog.waitFor({ state: "detached" });

	const globalRow = sidebar.locator(".kestrel-sidebar-list-item").filter({ hasText: "Global chat" }).first();
	await globalRow.click({ button: "right" });
	const globalMenu = page.getByRole("menu");
	await globalMenu.waitFor();
	await globalMenu.getByRole("menuitem", { name: "Alpha", exact: true }).click();
	await page.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Global chat" }).waitFor();
	assert.equal(await sidebar.locator(".kestrel-sidebar-list-item").filter({ hasText: "Global chat" }).count(), 0);

	const assigned = await request({ type: "runtime-list-sessions" });
	const assignedSession = assigned.sessions.find((session) => session.id === globalSession.id);
	assert.equal(assignedSession.projectId, "project-alpha");

	const assignedChild = sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Global chat" }).first();
	await assignedChild.click({ button: "right" });
	const moveMenu = page.getByRole("menu");
	await moveMenu.waitFor();
	await moveMenu.getByRole("menuitem", { name: "Beta", exact: true }).click();
	await sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Global chat" }).waitFor();
	const afterMove = await request({ type: "runtime-list-sessions" });
	assert.equal(afterMove.sessions.find((session) => session.id === globalSession.id).projectId, "project-beta");

	const betaChild = sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Global chat" }).first();
	await betaChild.click({ button: "right" });
	const removeMenu = page.getByRole("menu");
	await removeMenu.waitFor();
	await removeMenu.getByRole("menuitem", { name: "Remove from project", exact: true }).click();
	await sidebar.locator(".kestrel-sidebar-list-item").filter({ hasText: "Global chat" }).waitFor();
	const afterRemove = await request({ type: "runtime-list-sessions" });
	const removedSession = afterRemove.sessions.find((session) => session.id === globalSession.id);
	assert.equal(removedSession.projectId, undefined);
	assert.equal(removedSession.workspaceRoot, undefined);

	const betaSettings = await openProjectSettings(betaRow);
	page.once("dialog", (dialog) => dialog.accept());
	await betaSettings.getByRole("button", { name: "Delete project", exact: true }).click();
	await betaSettings.waitFor({ state: "detached" });
	await betaRow.waitFor({ state: "detached" });
	await sidebar.locator(".kestrel-sidebar-list-item").filter({ hasText: "Beta chat" }).waitFor();
	const afterDelete = await request({ type: "runtime-list-sessions" });
	const preservedSession = afterDelete.sessions.find((session) => session.id === betaSession.id);
	assert.equal(preservedSession.projectId, undefined);
	assert.equal(preservedSession.workspaceRoot, undefined);

	const alphaAfterDelete = await waitForProject("Alpha");
	await alphaAfterDelete.click();
	await sidebar.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
	await page.locator('.kestrel-sidebar[data-collapsed="true"]').waitFor();
	await sidebar.getByRole("button", { name: "Expand sidebar", exact: true }).click();
	await sidebar.locator('.kestrel-sidebar-project-open.active').waitFor();
	await sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Alpha chat" }).first().waitFor();

	await page.reload();
	await sidebar.waitFor();
	await sidebar.locator('.kestrel-sidebar-project-open.active').filter({ hasText: "Alpha" }).waitFor();
	await sidebar.locator(".kestrel-sidebar-project-chat").filter({ hasText: "Alpha chat" }).first().waitFor();
	assert.equal(await page.locator(".projects-workspace").count(), 1);
	assert.deepEqual(pageErrors, []);
	assert.deepEqual(consoleErrors, []);
	process.stdout.write(
		"Desktop project system smoke passed: hierarchy, bounded previews, project home/settings, reassignment, non-destructive deletion, collapse/restore, and reload persistence.\n",
	);
} catch (error) {
	process.stderr.write(
		`Desktop project system smoke failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
	);
	throw error;
} finally {
	await application?.close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}
