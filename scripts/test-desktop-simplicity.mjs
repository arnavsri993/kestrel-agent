import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

// This smoke uses a disposable profile and only local fixture data. It never
// submits prompts or mutates a user profile/provider account.
const tempRoot = mkdtempSync(join(tmpdir(), "kestrel-ui-simplicity-"));
const userData = join(tempRoot, "profile");
const evidence = resolve(".tmp/ui-simplicity");
mkdirSync(evidence, { recursive: true });
const requireDesktop = createRequire(resolve("apps/desktop/package.json"));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packaged ? resolve(packaged) : requireDesktop("electron");
const launchArgs = packaged ? ["--use-mock-keychain"] : [resolve("apps/desktop")];
let app;
let page;
const pageErrors = [];
const measurements = [];
const visualFailures = [];

async function request(input) {
	return page.evaluate((value) => window.kestrel.request(value), input);
}

async function setWindowSize(width, height = 850) {
	await app.evaluate(({ BrowserWindow }, size) => {
		const window = BrowserWindow.getAllWindows().find((candidate) =>
			candidate.webContents.getURL().includes("renderer/index.html"),
		);
		if (!window) throw new Error("Kestrel renderer window is unavailable.");
		window.setMinimumSize(400, 400);
		window.setContentSize(size.width, size.height);
	}, { width, height });
	await page.waitForFunction((expected) => innerWidth === expected, width);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openRoute(route, heading) {
	const response = await request({ type: "browser-create-tab", input: `kestrel://${route}`, active: true });
	assert.equal(response.ok, true, `Could not open ${route}`);
	const surface = page.locator(`[data-app-page="${route}"]`);
	await surface.waitFor({ state: "visible" });
	if (route === "projects") await surface.locator("h1").first().waitFor();
	else await surface.getByRole("heading", { name: heading, exact: true }).first().waitFor();
	await page.waitForFunction(() => document.querySelector("#browser-agent-toggle")?.getAttribute("aria-expanded") === "false");
}

async function openMemoryOverview() {
	const button = page.locator(".memory-workspace-tabs").getByRole("button", { name: "Overview", exact: true });
	if (await button.count()) await button.click();
	else await page.getByLabel("More memory views").selectOption("overview");
	await page.locator(".memory-overview").waitFor();
}

async function assertNoOverflow(label) {
	const sizes = await page.evaluate(() => ({
		viewport: innerWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth,
	}));
	assert.ok(sizes.document <= sizes.viewport + 1, `${label} document overflow: ${JSON.stringify(sizes)}`);
	assert.ok(sizes.body <= sizes.viewport + 1, `${label} body overflow: ${JSON.stringify(sizes)}`);
}

async function capture(label, pageName, selectors = {}) {
	await assertNoOverflow(`${pageName}/${label}`);
	const result = await page.evaluate((targets) => {
		const style = (selector) => {
			const node = selector ? document.querySelector(selector) : null;
			if (!(node instanceof HTMLElement)) return null;
			const css = getComputedStyle(node);
			const rect = node.getBoundingClientRect();
			return {
				fontSize: Number.parseFloat(css.fontSize),
				lineHeight: css.lineHeight,
				minHeight: Number.parseFloat(css.minHeight) || 0,
				height: Math.round(rect.height),
				display: css.display,
				transitionDuration: css.transitionDuration,
			};
		};
		return {
			viewport: innerWidth,
			bodyFont: Number.parseFloat(getComputedStyle(document.body).fontSize),
			heading: style(targets.heading),
			section: style(targets.section),
			metadata: style(targets.metadata),
			control: style(targets.control),
			label: style(targets.label),
			controlTransition: style(targets.control)?.transitionDuration ?? null,
			reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
		};
	}, selectors);
	const check = (condition, message) => { if (!condition) visualFailures.push(`${pageName}/${label}: ${message}`); };
	check(result.bodyFont >= 16.5, `body type too small: ${result.bodyFont}px`);
	if (selectors.heading) check(Boolean(result.heading), "Page heading is missing");
	if (result.heading) check(result.heading.fontSize >= (pageName === "chat" ? 17 : 31), `heading too small: ${result.heading.fontSize}px`);
	if (result.section) check(result.section.fontSize >= 20, `section heading too small: ${result.section.fontSize}px`);
	if (result.metadata) check(result.metadata.fontSize >= 14, `metadata too small: ${result.metadata.fontSize}px`);
	if (result.control) check(result.control.height >= 38, `control too short: ${result.control.height}px`);
	if (result.label) check(result.label.fontSize >= 16.5, `control label too small: ${result.label.fontSize}px`);
	if (result.controlTransition) {
		const durations = result.controlTransition.split(",").map((duration) => Number.parseFloat(duration) * (duration.trim().endsWith("ms") ? 0.001 : 1));
		check(durations.every((duration) => duration <= 0.15), `long control transition: ${result.controlTransition}`);
	}
	measurements.push({ page: pageName, capture: label, ...result });
	await page.screenshot({ path: join(evidence, `${pageName}-${label}.png`), fullPage: false });
}

const surfaces = [
	{ name: "agent", route: "agent", heading: "Agents", selectors: { heading: ".agent-work-header h1", section: ".agent-work-overview-group h2", metadata: ".agent-work-overview-metadata", control: ".agent-work-search" } },
	{ name: "projects", route: "projects", heading: "Projects", selectors: { heading: ".projects-workspace h1", section: ".projects-workspace-chats-heading h2", metadata: ".projects-workspace-chat time", control: ".projects-workspace button.primary" } },
	{ name: "memory", route: "memory", heading: "Memory", selectors: { heading: ".memory-workspace-header h1", section: ".memory-overview h2", metadata: ".memory-tier small", control: ".memory-workspace-header summary" } },
	{ name: "connections", route: "connections", heading: "Connections", selectors: { heading: ".page-frame h1", section: ".settings-panel-header h2", metadata: ".connection-status", control: ".memory-scope-selector select" } },
	{ name: "settings", route: "settings", heading: "Settings", selectors: { heading: ".settings-page-frame h1", section: ".settings-panel-header h2", metadata: ".settings-panel-header p", label: ".settings-content .setting-row strong", control: ".settings-section-picker select" } },
];

try {
	app = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_REAL_USER_PROFILE: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
		},
	});
	page = await app.firstWindow();
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForURL((url) => url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"));
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.setItem("kestrel:agent-sidebar", "collapsed");
	});
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	await page.emulateMedia({ reducedMotion: "reduce" });
	const initialBrowserState = await request({ type: "browser-get-state" });
	assert.equal(initialBrowserState.ok, true);
	const homeTabId = initialBrowserState.browserState.activeTabId;

	await setWindowSize(1360);
	await capture("wide", "home", { heading: "#new-tab-title", control: ".kestrel-home-composer" });
	async function exerciseHomeWorkflow(sizeLabel) {
		await request({ type: "browser-select-tab", tabId: homeTabId });
		await page.locator("#new-tab-title").waitFor();
		await page.locator("#new-tab-chat-input").fill("Local UI smoke draft");
		assert.equal(await page.locator("#new-tab-chat-input").inputValue(), "Local UI smoke draft");
		await page.locator("#new-tab-chat-input").fill("");
		const toggle = page.locator("#browser-agent-toggle");
		await toggle.waitFor();
		if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
		assert.equal(await toggle.getAttribute("aria-expanded"), "false");
		await toggle.click();
		await page.waitForFunction(() => document.querySelector("#browser-agent-toggle")?.getAttribute("aria-expanded") === "true");
		await page.locator("#runtime-prompt").waitFor({ state: "visible" });
		if (await page.evaluate(() => innerWidth <= 760)) {
			await page.locator('[data-app-page="agent"]').waitFor({ state: "hidden" });
			await page.getByRole("button", { name: "Back to agents", exact: true }).click();
			await request({ type: "browser-select-tab", tabId: homeTabId });
			await page.locator("#new-tab-title").waitFor();
		} else await toggle.click();
		await page.waitForFunction(() => document.querySelector("#browser-agent-toggle")?.getAttribute("aria-expanded") === "false");
		await page.locator("#runtime-prompt").waitFor({ state: "hidden" });
		await capture(sizeLabel, "home", { heading: "#new-tab-title", control: ".kestrel-home-composer" });
	}

	// The existing app route retains the real mounted RuntimeConversation. Open
	// a disposable empty session so this never sends a model prompt.
	const created = await request({ type: "runtime-create-session", kind: "agent", title: "UI smoke session", privacyMode: "standard" });
	assert.equal(created.ok, true);
	const runlessAgent = created.session;
	await openRoute("agent", "Agents");
	await capture("wide", "agent", surfaces[0].selectors);
	const row = page.locator(`[data-agent-session-id="${runlessAgent.id}"]`).first();
	await row.waitFor();
	await row.click();
	await page.getByRole("button", { name: "Back to agents", exact: true }).waitFor();
	await capture("wide", "chat", { heading: ".agent-chat-heading strong", section: ".message-body h2", metadata: ".composer-footer > span", control: "#runtime-prompt" });
	assert.equal(await page.locator("#runtime-prompt").evaluate((node) => document.activeElement === node), true, "Focused conversation should expose a reachable composer");
	await page.getByRole("button", { name: "Back to agents", exact: true }).click();

	for (const surface of surfaces.slice(1)) {
		await openRoute(surface.route, surface.heading);
		if (["projects", "memory", "connections", "settings"].includes(surface.name))
			assert.equal(await page.locator("#runtime-prompt").isVisible().catch(() => false), false, `${surface.name} should not show the runtime composer by default`);
		if (surface.name === "memory") {
			const title = page.getByLabel(/^Title(?: \(optional\))?$/);
			if (!(await title.isVisible())) await page.getByRole("button", { name: "Add note", exact: true }).click();
			await title.fill("UI smoke note");
			await page.getByLabel("What Kestrel should know", { exact: true }).fill("A disposable note for checking this interface.");
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.locator(".memory-reader").getByRole("heading", { name: "UI smoke note" }).waitFor();
			await capture("notes-wide", "memory", surface.selectors);
			await page.getByRole("button", { name: /^Edit(?: note)?$/ }).click();
			await page.getByLabel("What Kestrel should know", { exact: true }).fill("Updated disposable note.");
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.locator(".memory-reader").getByText("Updated disposable note.", { exact: true }).waitFor();
			await openMemoryOverview();
		}
		if (surface.name === "settings") {
			const scope = page.locator(".settings-scope-switcher").getByRole("tab", { name: "Browser", exact: true });
			if (await scope.count()) await scope.click();
			await page.locator(".settings-content").waitFor();
		}
		await capture("wide", surface.name, surface.selectors);
		const toggle = page.locator("#browser-agent-toggle");
		await toggle.focus();
		await page.keyboard.press("Space");
		await page.locator("#runtime-prompt").waitFor({ state: "visible" });
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		await toggle.click();
		await page.locator("#runtime-prompt").waitFor({ state: "hidden" });
	}

	// Exercise the settings categories that most often change their control
	// density; choose real categories through the Settings scope/navigation.
	await page.locator(".settings-scope-switcher").getByRole("tab", { name: "Agent", exact: true }).click();
	const settingsPicker = page.getByLabel("Agent settings section");
	await settingsPicker.focus();
	assert.equal(await settingsPicker.evaluate((node) => document.activeElement === node), true);
	await settingsPicker.selectOption("agent-models");
	await capture("agent-wide", "settings-agent", { heading: ".settings-page-frame h1", section: ".settings-panel-header h2", metadata: ".settings-panel-header p", control: ".settings-content select" });

	for (const [width, label] of [[760, "compact"], [520, "narrow"]]) {
		await setWindowSize(width);
		await exerciseHomeWorkflow(label);
		for (const surface of surfaces) {
			await openRoute(surface.route, surface.heading);
			if (["projects", "memory", "connections", "settings"].includes(surface.name))
				assert.equal(await page.locator("#runtime-prompt").isVisible().catch(() => false), false, `${surface.name} should not show the runtime composer by default`);
			if (surface.name === "memory") await openMemoryOverview();
			if (surface.name === "settings") {
				const browserTab = page.locator(".settings-scope-switcher").getByRole("tab", { name: "Browser", exact: true });
				if (await browserTab.count()) await browserTab.click();
			}
			await capture(label, surface.name, surface.selectors);
		}
		await openRoute("agent", "Agents");
		const item = page.locator("[data-agent-session-id]").first();
		await item.waitFor();
		await item.click();
		await page.getByRole("button", { name: "Back to agents", exact: true }).waitFor();
		await capture(label, "chat", { heading: ".agent-chat-heading strong", section: ".message-body h2", metadata: ".composer-footer > span", control: "#runtime-prompt" });
		await page.getByRole("button", { name: "Back to agents", exact: true }).click();
	}

	// Fault the first Memory read at IPC in this disposable app, then let the real
	// request recover after the user activates Retry.
	await app.evaluate(({ ipcMain }) => {
		const original = ipcMain._invokeHandlers.get("kestrel:request");
		if (!original) throw new Error("Request handler is unavailable for the fixture");
		let failOnce = true;
		ipcMain.removeHandler("kestrel:request");
		ipcMain.handle("kestrel:request", (event, input) => {
			if (failOnce && input?.type === "memory-workspace-read") {
				failOnce = false;
				return { ok: false, error: "UI smoke injected read failure" };
			}
			return original(event, input);
		});
	});
	await openRoute("memory", "Memory");
	await page.getByRole("alert").waitFor();
	const retry = page.getByRole("button", { name: /try again|retry/i }).first();
	await retry.click();
	await page.getByRole("alert").waitFor({ state: "detached" });
	await capture("recovered", "memory", surfaces[2].selectors);

	// Return to Home through the original real browser tab, then record motion
	// metrics and assert no large interaction shifts survive the preference.
	const select = await request({ type: "browser-select-tab", tabId: homeTabId });
	assert.equal(select.ok, true);
	await page.locator("#new-tab-title").waitFor();
	const motion = await page.evaluate(() => {
		const selector = document.querySelector(".ui-button-primary") ?? document.querySelector(".kestrel-home-send");
		return selector ? getComputedStyle(selector).transitionDuration : "0s";
	});
	assert.ok(pageErrors.length === 0, `Renderer errors: ${pageErrors.join("; ")}`);
	writeFileSync(join(evidence, "measurements.json"), JSON.stringify({ measurements, reducedMotion: true, representativeTransitionDuration: motion }, null, 2));
	assert.deepEqual(visualFailures, [], "UI measurements failed");
	process.stdout.write(`UI simplicity smoke passed (${measurements.length} captures); evidence: ${evidence}\n`);
} catch (error) {
	if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
	throw error;
} finally {
	await app?.close();
	rmSync(tempRoot, { recursive: true, force: true });
}
