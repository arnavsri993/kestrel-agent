import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-personas-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [
			resolve("apps/desktop"),
			...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
		];
const inheritedEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap(
		(key) =>
			process.env[key] === undefined ? [] : [[key, process.env[key]]],
	),
);

let application;

const commandDestinationLabels = [
	"Browser",
	"Cluster tabs",
	"History",
	"Bookmarks",
	"Downloads",
	"Agent",
	"Writing Studio",
	"Approvals",
	"Work",
	"Opportunities",
	"Life Context",
	"Research",
	"Artifacts",
	"Activity",
	"Extensions",
	"Readiness",
	"Settings",
	"Keyboard Shortcuts",
];

function personaPaths(name) {
	const personaRoot = join(root, name);
	const home = join(personaRoot, "home");
	const codexHome = join(personaRoot, "codex-home");
	mkdirSync(home, { recursive: true });
	mkdirSync(codexHome, { recursive: true });
	return {
		personaRoot,
		home,
		codexHome,
		userData: join(personaRoot, "user-data"),
	};
}

async function launchPersona(paths, { realProfile }) {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...inheritedEnvironment,
			HOME: paths.home,
			USER: "kestrel-persona-test",
			LOGNAME: "kestrel-persona-test",
			CODEX_HOME: paths.codexHome,
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_USER_DATA: paths.userData,
			...(realProfile ? { KESTREL_REAL_USER_PROFILE: "1" } : {}),
		},
	});
	const rendererNetworkRequests = [];
	application.context().on("request", (request) => {
		if (/^https?:\/\//.test(request.url()))
			rendererNetworkRequests.push(request.url());
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	const runtimeErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	return { page, runtimeErrors, rendererNetworkRequests };
}

async function closeApplication() {
	await application?.close();
	application = undefined;
}

async function markReturningUser(page) {
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	await page.locator("#new-tab-title").waitFor();
}

async function readSnapshot(page) {
	const response = await page.evaluate(() =>
		window.kestrel.request({ type: "snapshot" }),
	);
	assert.equal(response.ok, true);
	assert.ok(response.snapshot, "The desktop snapshot is unavailable.");
	return response.snapshot;
}

async function assertNoStartupFailure(page, label) {
	assert.equal(
		await page.locator(".loading-screen.error-screen").count(),
		0,
		`${label} rendered the startup error screen.`,
	);
}

async function assertFreshState(page) {
	await page.locator("#runtime-prompt").waitFor();
	await page.locator("#new-tab-title").waitFor();
	const snapshot = await readSnapshot(page);
	assert.equal(snapshot.agentState, "idle");
	assert.deepEqual(snapshot.approvals, []);
	assert.deepEqual(snapshot.memories, []);
	assert.deepEqual(snapshot.activity, []);

	const browserResponse = await page.evaluate(() =>
		window.kestrel.request({ type: "browser-get-state" }),
	);
	assert.equal(browserResponse.ok, true);
	assert.deepEqual(browserResponse.browserState?.history, []);
	assert.deepEqual(browserResponse.browserState?.bookmarks, []);
	assert.deepEqual(browserResponse.browserState?.downloads, []);
	assert.equal(
		await page.getByText("Finalize the Monday test plan?", { exact: true }).count(),
		0,
	);
	assert.equal(
		await page.getByRole("button", { name: "Review a project" }).count(),
		0,
	);
	await assertNoStartupFailure(page, "Fresh profile");
}

async function openCommandCenter(page) {
	await page.keyboard.press("Meta+K");
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	const search = page.getByLabel("Search Kestrel");
	await search.waitFor();
	await page.waitForFunction(
		() => document.activeElement === document.querySelector(".command-search input"),
	);
	await page.waitForFunction(
		(expected) =>
			JSON.stringify(
				Array.from(
					document.querySelectorAll(".command-groups button strong"),
					(node) => node.textContent,
				),
			) === JSON.stringify(expected),
		commandDestinationLabels,
	);
	return search;
}

async function selectDestination(page, label) {
	await openCommandCenter(page);
	const destination = page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first();
	await destination.waitFor();
	await destination.click();
}

async function assertFocusedRoute(page, id) {
	const route = page.locator(`[data-app-page="${id}"]`);
	await route.waitFor({ state: id === "agent" ? "attached" : "visible" });
	if (id === "agent") await page.locator(".agent-workspace").waitFor();
	await page.waitForFunction((routeId) => {
		const node = document.querySelector(`[data-app-page="${routeId}"]`);
		const heading =
			routeId === "agent"
				? document.querySelector("#agent-workspace-title")
				: node?.querySelector("h1, h2");
		return Boolean(heading && heading === document.activeElement);
	}, id);
	await assertNoStartupFailure(page, id);
}

async function assertNoHorizontalOverflow(page, label) {
	const width = await page.evaluate(() => ({
		document: document.documentElement.scrollWidth,
		viewport: document.documentElement.clientWidth,
	}));
	assert.ok(
		width.document <= width.viewport + 1,
		`${label} overflowed horizontally: ${JSON.stringify(width)}`,
	);
}

async function runFreshPersona() {
	const paths = personaPaths("fresh");
	let launched = await launchPersona(paths, { realProfile: true });
	await markReturningUser(launched.page);
	await assertFreshState(launched.page);
	assert.deepEqual(launched.runtimeErrors, []);
	assert.deepEqual(launched.rendererNetworkRequests, []);
	await closeApplication();

	launched = await launchPersona(paths, { realProfile: true });
	assert.equal(
		await launched.page.evaluate(() => localStorage.getItem("kestrel:onboarded")),
		"yes",
	);
	await assertFreshState(launched.page);
	assert.deepEqual(launched.runtimeErrors, []);
	assert.deepEqual(launched.rendererNetworkRequests, []);
	await closeApplication();
	process.stdout.write(
		"Fresh-user persona passed: fixture-free idle state and local browser data remain empty across restart.\n",
	);
}

async function runReturningPersona() {
	const paths = personaPaths("returning");
	const { page, runtimeErrors, rendererNetworkRequests } = await launchPersona(paths, {
		realProfile: false,
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ width: 1320, height: 860 });
	await markReturningUser(page);

	const snapshot = await readSnapshot(page);
	assert.equal(snapshot.agentState, "waiting_approval");
	assert.ok(snapshot.approvals.length > 0, "The returning persona has no approvals.");
	assert.ok(snapshot.memories.length > 0, "The returning persona has no memory.");
	assert.ok(snapshot.activity.length > 0, "The returning persona has no activity.");
	await assertNoStartupFailure(page, "Returning profile");

	const search = await openCommandCenter(page);
	assert.deepEqual(
		await page.locator(".command-groups button strong").allTextContents(),
		commandDestinationLabels,
		"The persona matrix must enumerate every current Command Center destination.",
	);
	assert.equal(
		await search.evaluate((element) => document.activeElement === element),
		true,
	);
	await page.keyboard.press("Tab");
	assert.equal(
		await page.evaluate(() => document.activeElement?.tagName),
		"BUTTON",
		"Keyboard navigation did not move from search to an actionable command.",
	);
	const reducedMotion = await page.locator(".command-center").evaluate((element) => ({
		matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
		transitionDuration: getComputedStyle(element).transitionDuration,
	}));
	assert.equal(reducedMotion.matches, true);
	assert.match(reducedMotion.transitionDuration, /^(?:0s|0\.001ms|1e-06s)$/);
	await page.keyboard.press("Escape");
	await page.locator(".command-center").waitFor({ state: "detached" });
	await page.locator("#new-tab-title").waitFor();

	await selectDestination(page, "Browser");
	await page.locator("#new-tab-title").waitFor();
	assert.equal(await page.locator("[data-app-page]").count(), 0);

	await selectDestination(page, "Cluster tabs");
	await page.getByRole("dialog", { name: "Tab clusters" }).waitFor();
	await page.getByRole("button", { name: "Close tab clusters" }).click();

	for (const [label, id] of [
		["Agent", "agent"],
		["Writing Studio", "writing"],
		["History", "history"],
		["Bookmarks", "bookmarks"],
		["Downloads", "downloads"],
		["Approvals", "approvals"],
		["Work", "work"],
		["Opportunities", "events"],
		["Life Context", "memory"],
		["Research", "research"],
		["Artifacts", "artifacts"],
		["Activity", "activity"],
		["Extensions", "extensions"],
		["Readiness", "readiness"],
	]) {
		await selectDestination(page, label);
		await assertFocusedRoute(page, id);
	}

	await selectDestination(page, "Settings");
	await assertFocusedRoute(page, "settings");
	await page
		.getByRole("tab", { name: /Browser Tabs, search, and new tab/ })
		.click();
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: "Browser Preferences" })
		.click();
	await page.getByRole("heading", { name: "Make the browser feel like yours." }).waitFor();

	await page
		.getByRole("tab", { name: /Agent Models, memory, and behavior/ })
		.click();
	for (const [label, heading] of [
		["General & Autonomy", "Autonomy and behavior"],
		["Connections", "Accounts and access"],
		["Models & Routing", "Routing and providers"],
		["Intelligence & Memory", "Memory and learning"],
		["Agent Plugins", "Plugins and publishers"],
		["Privacy & Safety", "Approvals and recovery"],
		["Advanced System", "Diagnostics and organization"],
	]) {
		await page
			.getByRole("navigation", { name: "Settings sections" })
			.getByRole("button", { name: label })
			.click();
		await page.getByRole("heading", { name: heading }).waitFor();
		if (label === "Intelligence & Memory")
			await page.getByText("Honcho remote memory", { exact: true }).first().waitFor();
		await assertNoStartupFailure(page, `Settings / ${label}`);
	}

	await page.setViewportSize({ width: 640, height: 760 });
	await assertNoHorizontalOverflow(page, "Compact Settings");
	await openCommandCenter(page);
	await assertNoHorizontalOverflow(page, "Compact Command Center");
	await page.setViewportSize({ width: 1320, height: 860 });
	await assertNoHorizontalOverflow(page, "Wide Command Center");

	const shortcuts = page
		.locator(".command-groups button")
		.filter({ has: page.getByText("Keyboard Shortcuts", { exact: true }) })
		.first();
	await shortcuts.click();
	await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
	await page.getByRole("button", { name: "Close keyboard shortcuts" }).click();

	assert.deepEqual(runtimeErrors, []);
	assert.deepEqual(
		rendererNetworkRequests,
		[],
		`The persona matrix unexpectedly made renderer HTTP(S) requests: ${rendererNetworkRequests.join(", ")}`,
	);
	await closeApplication();
	process.stdout.write(
		"Returning-user persona passed: every destination, both Settings scopes, reduced motion, keyboard focus, and compact/wide reflow are healthy.\n",
	);
}

try {
	await runFreshPersona();
	await runReturningPersona();
} finally {
	await closeApplication();
	rmSync(root, { recursive: true, force: true });
}
