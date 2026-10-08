import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-efficiency-"));
const userData = join(root, "profile");
const projectPath = join(root, "project");
const evidence = resolve(".tmp/desktop-efficiency");
mkdirSync(userData);
mkdirSync(projectPath);
mkdirSync(evidence, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(userData, "workspace-grants.json"), JSON.stringify([
	{ id: "efficiency-project", path: realpathSync(projectPath), name: "Efficiency project", createdAt: now, updatedAt: now, order: 0 },
]));

const usageType = "runtime-provider-usage";
const traceType = "orchestration-routing-traces";
const usageFixture = {
	providerId: "codex-subscription-efficiency-fixture",
	providerPoolId: "codex-subscription",
	label: "Efficiency fixture · Codex",
	email: "efficiency-fixture@example.invalid",
	plan: "Plus",
	status: "ready",
	ordinaryUsageAllowed: true,
	updatedAt: now,
	windows: [{ label: "5-hour", usedPercent: 23, windowDurationMins: 300,
		resetsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }],
};
// Wrap the bridge before Electron freezes its exposed properties. Only usage
// and routing-trace readings are fixtures; all other requests use the real core.
const preload = join(root, "efficiency-fixture.cjs");
writeFileSync(preload, `
	const { contextBridge } = require("electron");
	const expose = contextBridge.exposeInMainWorld.bind(contextBridge);
	const counts = new Map();
	const outstanding = new Map();
	const modes = new Map([[${JSON.stringify(usageType)}, "defer"], [${JSON.stringify(traceType)}, "reject"]]);
	const pending = new Map();
	const result = type => type === ${JSON.stringify(usageType)}
		? { ok: true, providerUsage: [${JSON.stringify(usageFixture)}] }
		: { ok: true, routingTraces: [] };
	const key = (type, sessionId) => sessionId ? type + ":" + sessionId : type;
	contextBridge.exposeInMainWorld = (name, bridge) => {
		if (name === "kestrel") {
			const realRequest = bridge.request.bind(bridge);
			bridge = { ...bridge, request: async input => {
				const keys = [input.type, ...(input.sessionId ? [key(input.type, input.sessionId)] : [])];
				for (const requestKey of keys) {
					counts.set(requestKey, (counts.get(requestKey) || 0) + 1);
					outstanding.set(requestKey, (outstanding.get(requestKey) || 0) + 1);
				}
				try {
					if (!modes.has(input.type)) return await realRequest(input);
					const mode = modes.get(input.type);
					if (mode === "reject") throw new Error("Efficiency fixture transient failure");
					if (mode === "failed-response") return { ok: false, error: "Efficiency fixture unavailable" };
					if (mode === "defer") return await new Promise(resolve => {
						const readers = pending.get(input.type) || [];
						readers.push(resolve);
						pending.set(input.type, readers);
					});
					return result(input.type);
				} finally {
					for (const requestKey of keys) outstanding.set(requestKey, outstanding.get(requestKey) - 1);
				}
			} };
			expose("efficiencyFixture", {
				count: (type, sessionId) => counts.get(key(type, sessionId)) || 0,
				outstanding: (type, sessionId) => outstanding.get(key(type, sessionId)) || 0,
				mode: (type, mode) => modes.set(type, mode) && undefined,
				release: type => {
					modes.set(type, "success");
					for (const resolve of pending.get(type) || []) resolve(result(type));
					pending.delete(type);
				},
			});
		}
		return expose(name, bridge);
	};
`);

const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
let application;
let page;
const pageErrors = [];

async function request(input) {
	return page.evaluate(input => window.kestrel.request(input), input);
}

async function count(type, sessionId) {
	return page.evaluate(({ type, sessionId }) => window.efficiencyFixture.count(type, sessionId), { type, sessionId });
}

async function assertCount(type, expected, message, sessionId) {
	const actual = await count(type, sessionId);
	assert.equal(actual, expected, `${message} Actual ${type} count: ${actual}; expected: ${expected}.`);
}

async function setVisibility(state, repeats = 1) {
	await page.evaluate(({ state, repeats }) => {
		window.efficiencyVisibility = state;
		for (let i = 0; i < repeats; i += 1) document.dispatchEvent(new Event("visibilitychange"));
	}, { state, repeats });
}

async function waitForCount(type, expected, sessionId) {
	await page.waitForFunction(({ type, expected, sessionId }) =>
		window.efficiencyFixture.count(type, sessionId) >= expected,
	{ type, expected, sessionId });
}

async function waitForSettled(type, sessionId) {
	await page.waitForFunction(({ type, sessionId }) =>
		window.efficiencyFixture.outstanding(type, sessionId) === 0,
	{ type, sessionId });
}

async function revealWidget(id) {
	const card = page.locator(`[data-kestrel-widget-id="${id}"]`);
	for (let attempt = 0; attempt < 12; attempt += 1) {
		if (await card.isVisible().catch(() => false)) {
			await card.scrollIntoViewIfNeeded();
			return card;
		}
		const pager = page.locator(".kestrel-widget-pager:visible");
		if ((await pager.count()) === 0) break;
		const next = pager.getByRole("button", { name: /next/i }).first();
		if (!(await next.isVisible().catch(() => false)) || await next.isDisabled()) break;
		await next.click();
	}
	throw new Error(`Widget ${id} is not visible in the Home pager.`);
}

try {
	application = await electron.launch({
		executablePath: packagedExecutable ? resolve(packagedExecutable) : requireFromDesktop("electron"),
		args: packagedExecutable ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
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
	page.setDefaultTimeout(20_000);
	page.on("pageerror", error => pageErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.waitForFunction(() => typeof window.kestrel?.request === "function");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.setItem("kestrel:agent-sidebar", "open");
	});
	await application.evaluate(({ BrowserWindow }, preloadPath) => {
		const win = BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes("petOverlay"));
		if (!win) throw new Error("Main desktop window was not found.");
		win.setSize(1440, 1000);
		win.show();
		win.focus();
		win.webContents.session.setPreloads([preloadPath]);
	}, preload);
	await page.addInitScript(() => {
		window.efficiencyVisibility = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => window.efficiencyVisibility,
		});
	});
	await page.clock.install();
	await page.reload();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.locator("#new-tab-title").waitFor();
	const usage = await revealWidget("route-usage");
	await usage.getByText("Checking Codex accounts…", { exact: true }).waitFor();
	await waitForCount(usageType, 1);
	await assertCount(usageType, 1, "Initial usage reading should start once.");
	await setVisibility("hidden");
	await setVisibility("visible", 4);
	await assertCount(usageType, 1, "Visibility changes must join the pending usage read.");
	await page.clock.fastForward(65_000);
	await assertCount(usageType, 1, "A slow usage request must not overlap its timer.");
	await page.evaluate(type => window.efficiencyFixture.release(type), usageType);
	const meter = usage.getByRole("meter", { name: "5-hour remaining", exact: true }).first();
	await meter.waitFor();
	assert.equal(await meter.getAttribute("aria-valuenow"), "77");
	await waitForSettled(usageType);
	await page.screenshot({ animations: "disabled", path: join(evidence, "usage.png") });

	await setVisibility("hidden");
	await page.clock.fastForward(65_000);
	await assertCount(usageType, 1, "Hidden usage widgets must stay idle.");
	await setVisibility("visible");
	await waitForCount(usageType, 2);
	await waitForSettled(usageType);
	await assertCount(usageType, 2, "Foreground restoration should refresh usage once.");
	await page.evaluate(type => window.efficiencyFixture.mode(type, "failed-response"), usageType);
	await setVisibility("hidden");
	await setVisibility("visible");
	await waitForCount(usageType, 3);
	await usage.getByText(/Showing the last reading\.|Last reading|Could not refresh/i).waitFor();
	assert.equal(await meter.getAttribute("aria-valuenow"), "77", "A failed refresh must retain the visible reading.");
	await page.screenshot({ animations: "disabled", path: join(evidence, "usage-last-reading.png") });

	const workResponse = await request({ type: "browser-create-tab", input: "kestrel://work", active: true });
	assert.equal(workResponse.ok, true, "Could not open Work.");
	await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
	await waitForCount(traceType, 1);
	await waitForSettled(traceType);
	await assertCount(traceType, 1, "Work should issue a single initial trace read.");
	assert.deepEqual(pageErrors, [], "A rejected Work poll must be handled.");
	await page.evaluate(type => window.efficiencyFixture.mode(type, "defer"), traceType);
	await setVisibility("hidden");
	await setVisibility("visible");
	await waitForCount(traceType, 2);
	await setVisibility("visible", 4);
	await page.clock.fastForward(12_000);
	await assertCount(traceType, 2, "Slow Work reads must join visibility refreshes and timers.");
	await setVisibility("hidden");
	await page.evaluate(type => window.efficiencyFixture.release(type), traceType);
	await waitForSettled(traceType);
	await page.clock.fastForward(65_000);
	await assertCount(traceType, 2, "Hidden Work must stop polling after a pending read settles.");
	await setVisibility("visible");
	await waitForCount(traceType, 3);
	await waitForSettled(traceType);
	await assertCount(traceType, 3, "Work should recover on foreground restoration.");
	await page.screenshot({ animations: "disabled", path: join(evidence, "work.png") });

	const title = "Efficiency transcript fixture";
	const sessionResponse = await request({ type: "runtime-create-session", title, kind: "conversation" });
	assert(sessionResponse.ok && sessionResponse.session, "Could not create the isolated conversation.");
	const sessionId = sessionResponse.session.id;
	const sessionRow = page.locator(".kestrel-sidebar-list-item").filter({ hasText: title }).first();
	await sessionRow.waitFor();
	await sessionRow.click();
	await waitForCount("runtime-list-messages", 1, sessionId);
	await waitForSettled("runtime-list-messages", sessionId);
	await page.waitForTimeout(250);
	await assertCount("runtime-list-messages", 1, "Selecting a conversation should load its transcript once.", sessionId);
	const beforeMetadata = {
		messages: await count("runtime-list-messages", sessionId),
		providers: await count("runtime-list-providers"),
	};
	const projectRow = page.locator(".kestrel-sidebar-project-open").filter({ hasText: "Efficiency project" }).first();
	await projectRow.click({ button: "right" });
	await page.getByRole("menu").getByRole("menuitem", { name: "Project settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Project settings", exact: true });
	await dialog.getByLabel("Project name").fill("Efficiency project renamed");
	await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
	await dialog.waitFor({ state: "detached" });
	await page.locator(".kestrel-sidebar-project-open").filter({ hasText: "Efficiency project renamed" }).waitFor();
	await page.waitForTimeout(250);
	await assertCount("runtime-list-messages", beforeMetadata.messages, "Project metadata changes must not reload the transcript.", sessionId);
	await assertCount("runtime-list-providers", beforeMetadata.providers, "Project metadata changes must not reload providers.");
	await sessionRow.click();
	await page.waitForTimeout(250);
	await assertCount("runtime-list-messages", beforeMetadata.messages, "Reopening the active conversation should preserve its loaded transcript.", sessionId);
	assert.deepEqual(pageErrors, [], "Efficiency smoke must not leave unhandled renderer errors.");
	console.log("Desktop efficiency smoke passed: serialized usage and Work reads, hidden/resume behavior, preserved last reading, one transcript load, and project metadata without redundant reads.");
} catch (error) {
	await page?.screenshot({ animations: "disabled", path: join(evidence, "failure.png") }).catch(() => undefined);
	throw error;
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
