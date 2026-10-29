import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";

const content = "Native Kestrel workspace fixture. This disposable folder contains no user data.\n";

export async function nativeWorkspaceCanary({ settings, getHome, profile, evidence, receipt, origin, fixtures }) {
	const folder = join(profile, "workspace-fixture");
	await mkdir(folder, { mode: 0o700 });
	await writeFile(join(folder, "README.md"), content, { mode: 0o600 });
	await writeFile(join(profile, "outside-workspace-fixture.txt"), "Owned synthetic file outside the granted folder.\n", { mode: 0o600 });
	const canonical = await realpath(folder);
	await selectSettingsSection(settings, "agent-workspace", "Workspace & sessions");
	const row = settings.locator("#setting-agent-workspace-grants");
	await row.getByRole("button", { name: "Add folder", exact: true }).click();
	console.log(`OWNED_NATIVE_WORKSPACE_PICKER_READY: select only ${canonical}`);
	let project;
	for (const end = Date.now() + 180_000; Date.now() < end;) {
		const response = await getHome().evaluate(() => window.kestrel.request({ type: "get-workspace-grants" }));
		if (!response.ok && response.error === "Settings are being applied. Wait for Agent Core to restart.") { await delay(100); continue; }
		assert(response.ok, JSON.stringify(response));
		project = response.projects?.find(item => item.path === canonical);
		if (project) break;
		await delay(100);
	}
	assert(project?.available, "The actual native folder picker must grant only the owned fixture.");
	// Grant metadata is readable before the controlled Core restart completes.
	// Wait for the actual Settings mutation response before starting new work.
	await row.getByRole("button", { name: "Add folder", exact: true }).waitFor({ state: "visible" });
	await settings.waitForFunction(() => document.querySelector("#setting-agent-workspace-grants > button")?.disabled === false);
	await settings.locator(".kestrel-sidebar").getByRole("button", { name: /^(Open|Collapse) workspace-fixture project$/ }).waitFor();
	await getHome().locator(".kestrel-sidebar").getByRole("button", { name: /^(Open|Collapse) workspace-fixture project$/ }).waitFor();
	const created = await getHome().evaluate(project => window.kestrel.request({ type: "runtime-create-session", title: "Native workspace fixture", kind: "conversation", projectId: project.id, workspaceRoot: project.path }), project);
	assert(created.ok && created.session?.id, JSON.stringify(created));
	const state = { projectId: project.id, path: canonical, sessionId: created.session.id };
	const read = await workspaceRead(getHome(), state.sessionId);
	assert.equal(read.status, "verified", JSON.stringify(read));
	assert.equal(read.output?.content, content);
	const call = async (toolName, input) => {
		const response = await getHome().evaluate(({ sessionId, toolName, input }) => window.kestrel.request({ type: "runtime-call-tool", sessionId, toolName, input, approvalStatus: "approved", idempotencyKey: crypto.randomUUID() }), { sessionId: state.sessionId, toolName, input });
		return response.execution ?? response;
	};
	const isolated = await call("browser.create", { allowedOrigins: [origin] });
	assert.equal(isolated.status, "verified", JSON.stringify(isolated));
	const browserSessionId = isolated.output?.browserSessionId; assert(browserSessionId);
	try {
		const navigated = await call("browser.navigate", { browserSessionId, url: `${origin}/isolation-upload` });
		assert(!["failed", "blocked"].includes(navigated.status), JSON.stringify(navigated));
		const denied = await call("browser.upload", { browserSessionId, selector: "#fixture-upload", paths: ["../outside-workspace-fixture.txt"] });
		assert(denied.ok === false || ["failed", "blocked"].includes(denied.status), JSON.stringify(denied));
		assert.equal(fixtures.uploads.length, 0, "A containment escape must not reach the native file input.");
		const uploaded = await call("browser.upload", { browserSessionId, selector: "#fixture-upload", paths: ["README.md"] });
		assert.equal(uploaded.status, "verified", JSON.stringify(uploaded));
		for (const end = Date.now() + 10_000; Date.now() < end && !fixtures.uploads.length;) await delay(50);
		assert.deepEqual(fixtures.uploads, [content], "The native input must transfer the actual approved fixture bytes.");
	} finally { await call("browser.close", { browserSessionId }); }
	await settings.screenshot({ path: join(evidence, "native-workspace-granted.png") });
	receipt.phases.push({ phase: "native-macOS-folder-picker-to-Core-workspace-read", passed: true, projectId: project.id, sessionId: state.sessionId });
	receipt.phases.push({ phase: "native-granted-workspace-browser-upload-and-containment-refusal", passed: true });
	return state;
}

async function workspaceRead(home, sessionId) {
	const response = await home.evaluate(sessionId => window.kestrel.request({ type: "runtime-call-tool", sessionId, toolName: "workspace.read", input: { path: "README.md" }, approvalStatus: "approved", idempotencyKey: crypto.randomUUID() }), sessionId);
	return response.execution ?? response;
}

export async function finishNativeWorkspaceCanary({ home, state, receipt }) {
	const grants = await home.evaluate(() => window.kestrel.request({ type: "get-workspace-grants" }));
	assert(grants.ok && grants.projects?.some(project => project.id === state.projectId && project.path === state.path && project.available));
	const persisted = await workspaceRead(home, state.sessionId);
	assert.equal(persisted.status, "verified", JSON.stringify(persisted));
	assert.equal(persisted.output?.content, content);
	await home.locator(".kestrel-sidebar").getByRole("button", { name: /^(Open|Collapse) workspace-fixture project$/ }).waitFor();
	const removed = await home.evaluate(path => window.kestrel.request({ type: "remove-workspace-folder", path }), state.path);
	assert(removed.ok && !removed.projects?.some(project => project.id === state.projectId), JSON.stringify(removed));
	await home.locator(".kestrel-sidebar").getByRole("button", { name: /^(Open|Collapse) workspace-fixture project$/ }).waitFor({ state: "hidden" });
	const denied = await workspaceRead(home, state.sessionId);
	assert(denied.ok === false || ["failed", "blocked"].includes(denied.status), "Revocation must remove persisted-session file access: " + JSON.stringify(denied));
	assert.equal(await readFile(join(state.path, "README.md"), "utf8"), content);
	receipt.phases.push({ phase: "native-workspace-full-restart-and-grant-revocation", passed: true });
}
