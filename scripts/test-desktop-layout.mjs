import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-layout-"));
const userData = join(root, "user-data");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];

let application;
const pageErrors = [];

function assertNear(actual, expected, message) {
	assert.ok(
		Math.abs(actual - expected) <= 1,
		`${message}: expected ${expected}, got ${actual}`,
	);
}

async function readLayout(page) {
	return page.evaluate(() => {
		const shell = document.querySelector(".ai-browser-app");
		if (!shell) throw new Error("The Kestrel browser shell is unavailable.");
		const bounds = (selector) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			if (!rect) throw new Error(`Missing ${selector}.`);
			return {
				left: rect.left,
				right: rect.right,
				width: rect.width,
			};
		};
		const rootStyle = getComputedStyle(document.documentElement);
		return {
			innerWidth,
			classes: shell.className,
			columns: getComputedStyle(shell).gridTemplateColumns,
			navigation: bounds(".kestrel-sidebar"),
			main: bounds(".browser-main-plane"),
			viewport: bounds("#browser-viewport"),
			agent: bounds(".agent-sidebar"),
			theme: {
				canvas: rootStyle.getPropertyValue("--canvas").trim(),
				sidebar: rootStyle.getPropertyValue("--sidebar").trim(),
				solid: rootStyle.getPropertyValue("--solid").trim(),
				colorScheme: rootStyle.colorScheme,
			},
			bridgeReady: typeof window.kestrel?.request === "function",
		};
	});
}

function assertTheme(layout) {
	assert.deepEqual(layout.theme, {
		canvas: "#0d0e11",
		sidebar: "#131519",
		solid: "#f3f4f6",
		colorScheme: "dark",
	});
	assert.equal(layout.bridgeReady, true);
}

function assertCollapsedLayout(layout) {
	assert.match(layout.classes, /agent-sidebar-collapsed/);
	assertNear(layout.navigation.left, 0, "collapsed navigation left");
	assertNear(layout.navigation.width, 248, "collapsed navigation width");
	assertNear(
		layout.main.left,
		layout.navigation.right,
		"collapsed browser starts after navigation",
	);
	assert.ok(
		layout.main.width > layout.innerWidth / 2,
		`The collapsed browser plane was only ${layout.main.width}px (${layout.columns}).`,
	);
	assertNear(
		layout.main.right,
		layout.innerWidth,
		"collapsed browser reaches the window edge",
	);
	assertNear(
		layout.viewport.right,
		layout.innerWidth,
		"collapsed page viewport reaches the window edge",
	);
	assertNear(layout.agent.width, 0, "collapsed Pragmatic width");
	assertTheme(layout);
}

function assertOpenLayout(layout) {
	assert.doesNotMatch(layout.classes, /agent-sidebar-collapsed/);
	assertNear(layout.navigation.left, 0, "open navigation left");
	assertNear(layout.navigation.width, 248, "open navigation width");
	assertNear(
		layout.main.left,
		layout.navigation.right,
		"open browser starts after navigation",
	);
	assert.ok(
		layout.main.width > 500,
		`The open browser plane was only ${layout.main.width}px (${layout.columns}).`,
	);
	assertNear(layout.main.right, layout.innerWidth, "open browser plane reaches the window edge");
	assertNear(layout.viewport.right, layout.agent.left, "page viewport ends at Pragmatic");
	assertNear(layout.agent.right, layout.innerWidth, "Pragmatic reaches window edge");
	assertNear(layout.agent.width, 360, "open Pragmatic width");
	assertTheme(layout);
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
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.waitForFunction(() => typeof window.kestrel?.request === "function");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.setItem("kestrel:agent-sidebar", "collapsed");
	});
	await page.reload();
	await page.locator(".new-tab-page").waitFor();

	assertCollapsedLayout(await readLayout(page));
	await page.getByRole("button", { name: "Show Pragmatic", exact: true }).click();
	await page.waitForFunction(() => {
		const shell = document.querySelector(".ai-browser-app");
		const agent = document.querySelector(".agent-sidebar");
		return (
			shell &&
			agent &&
			!shell.classList.contains("agent-sidebar-collapsed") &&
			Math.abs(agent.getBoundingClientRect().width - 360) <= 1
		);
	});
	assertOpenLayout(await readLayout(page));

	await page
		.getByRole("button", { name: "Hide Pragmatic", exact: true })
		.first()
		.click();
	await page.waitForFunction(() => {
		const shell = document.querySelector(".ai-browser-app");
		const agent = document.querySelector(".agent-sidebar");
		return (
			shell?.classList.contains("agent-sidebar-collapsed") &&
			agent &&
			Math.abs(agent.getBoundingClientRect().width) <= 1
		);
	});
	assertCollapsedLayout(await readLayout(page));

	assert.deepEqual(pageErrors, []);
	process.stdout.write(
		"Desktop layout smoke passed: graphite theme, preload bridge, global navigation, browser plane, and open/collapsed Pragmatic geometry.\n",
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
