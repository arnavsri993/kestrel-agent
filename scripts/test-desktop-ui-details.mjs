import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";

const profileRoot = mkdtempSync(join(tmpdir(), "kestrel-ui-details-"));
const output = resolve(process.env.KESTREL_UI_DETAILS_OUTPUT || ".tmp/ui-details");
const baseline = process.env.KESTREL_UI_DETAILS_BASELINE === "1";
mkdirSync(output, { recursive: true });

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

async function assertNoHorizontalOverflow() {
	if (baseline) return;
	assert.equal(await page.locator(".new-tab-page").evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, "Home must not overflow horizontally");
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "The application must reflow without document overflow");
}

async function assertPill(selector) {
	const shape = await page.locator(selector).first().evaluate((node) => {
		const box = node.getBoundingClientRect();
		return { radius: parseFloat(getComputedStyle(node).borderTopLeftRadius), height: box.height };
	});
	assert(shape.radius >= shape.height / 2, `${selector} must have fully rounded ends: ${JSON.stringify(shape)}`);
}

async function main() {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: join(profileRoot, "profile"),
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	page = await application.firstWindow();
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#new-tab-title").waitFor();

	const windowSize = async (width, height) => {
		await application.evaluate(({ BrowserWindow }, size) => {
			const window = BrowserWindow.getAllWindows().find(
				(candidate) => !candidate.isDestroyed() && !candidate.webContents.getURL().includes("petOverlay"),
			);
			if (!window) throw new Error("Kestrel window unavailable");
			window.setMinimumSize(400, 500);
			window.setSize(size.width, size.height);
			window.show();
			window.focus();
		}, { width, height });
		await page.waitForTimeout(120);
	};

	await windowSize(1440, 900);
	if (!baseline) {
		await assertPill(".browser-address");
		const icons = await page.locator(".browser-toolbar-actions > button").evaluateAll((nodes) => nodes.map((node) => {
			const box = node.getBoundingClientRect();
			return { label: node.getAttribute("aria-label"), width: box.width, height: box.height, visible: node.checkVisibility(), radius: getComputedStyle(node).borderRadius };
		}));
		for (const icon of icons.filter((item) => item.visible)) {
			assert(Math.abs(icon.width - icon.height) < 1, `Toolbar icon must be square: ${JSON.stringify(icon)}`);
			assert.equal(icon.radius, "50%");
		}
	}
	await assertNoHorizontalOverflow();
	await page.screenshot({ animations: "disabled", path: join(output, "home-1440x900.png") });

	await windowSize(760, 760);
	await assertNoHorizontalOverflow();
	await page.screenshot({ animations: "disabled", path: join(output, "home-760x760.png") });

	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.isDestroyed() && !candidate.webContents.getURL().includes("petOverlay"),
		);
		window?.webContents.setZoomFactor(2);
	});
	await page.waitForTimeout(160);
	await assertNoHorizontalOverflow();
	await page.screenshot({ animations: "disabled", path: join(output, "home-760x760-200-percent.png") });
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.isDestroyed() && !candidate.webContents.getURL().includes("petOverlay"),
		);
		window?.webContents.setZoomFactor(1);
	});

	await windowSize(1440, 900);
	const menuTrigger = page.getByRole("button", { name: "Browser menu", exact: true });
	await menuTrigger.click();
	await page.getByRole("menu", { name: "Browser menu", exact: true }).waitFor();
	await page.screenshot({ animations: "disabled", path: join(output, "browser-menu-open.png") });
	await page.keyboard.press("Escape");

	const address = page.locator("#browser-address-input");
	await address.focus();
	await page.screenshot({ animations: "disabled", path: join(output, "address-keyboard-focus.png") });

	if (!baseline) {
		const toolbar = page.getByRole("group", { name: "Browser toolbar", exact: true });
		await toolbar.waitFor();
		assert.equal(await toolbar.getAttribute("aria-label"), "Browser toolbar");

		await address.fill("kestrel");
		await address.press("ArrowDown");
		const listbox = page.getByRole("listbox", { name: "Address suggestions", exact: true });
		await listbox.waitFor();
		const controls = await address.getAttribute("aria-controls");
		assert.equal(controls, await listbox.getAttribute("id"), "combobox must control the listbox");
		const activeDescendant = await address.getAttribute("aria-activedescendant");
		assert(activeDescendant, "ArrowDown must expose an active suggestion");
		assert.equal(await listbox.locator(`#${activeDescendant}`).count(), 1);
		await address.press("Escape");
		assert.equal(await address.evaluate((node) => document.activeElement === node), true, "Escape must retain address focus");

		await menuTrigger.click();
		await page.getByRole("menu", { name: "Browser menu", exact: true }).waitFor();
		await page.waitForFunction(() => document.querySelector('[role="menu"][aria-label="Browser menu"]')?.contains(document.activeElement));
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Browser menu");
		assert.equal(await menuTrigger.evaluate((node) => document.activeElement === node), true, "Escape must restore toolbar menu focus");

		const disabledNavigation = page.getByRole("button", { name: "Back", exact: true });
		if (await disabledNavigation.isDisabled()) {
			assert.equal(await disabledNavigation.getAttribute("aria-pressed"), null);
			assert.equal(await disabledNavigation.getAttribute("aria-selected"), null);
			assert.equal(await disabledNavigation.evaluate((node) => node.classList.contains("active")), false);
		}

		const composer = page.locator(".kestrel-home-composer");
		const composerInput = page.locator("#new-tab-chat-input");
		await composerInput.focus();
		const focusRing = await composer.evaluate((node) => {
			const style = getComputedStyle(node);
			return { outline: style.outlineStyle, boxShadow: style.boxShadow };
		});
		assert(
			focusRing.outline !== "none" || focusRing.boxShadow !== "none",
			"Composer focus must have a visible ring",
		);

		const dimensions = await page.evaluate(() => ({
			viewport: { width: innerWidth, height: innerHeight },
			horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
			composerWidth: document.querySelector(".kestrel-home-composer")?.getBoundingClientRect().width ?? 0,
		}));
		assert.equal(dimensions.horizontalOverflow, false, "Home must not overflow horizontally");
		assert(dimensions.composerWidth > 0, "Home composer must remain measurable");
		const buttonStates = await page.evaluate(() => {
			const fixture = document.createElement("button");
			fixture.className = "ui-button ui-button-solid ui-button-normal";
			fixture.innerHTML = '<span class="ui-button-label">Save changes</span>';
			document.querySelector(".ai-browser-app").append(fixture);
			const idleWidth = fixture.getBoundingClientRect().width;
			fixture.setAttribute("aria-busy", "true");
			fixture.disabled = true;
			fixture.insertAdjacentHTML("beforeend", '<span class="ui-spinner" aria-hidden="true"></span>');
			const busyWidth = fixture.getBoundingClientRect().width;
			const label = fixture.textContent;
			const opacity = getComputedStyle(fixture.querySelector(".ui-button-label")).opacity;
			fixture.remove();
			return { idleWidth, busyWidth, label, opacity };
		});
		assert.equal(buttonStates.idleWidth, buttonStates.busyWidth, "Loading must not shift button geometry");
		assert.equal(buttonStates.label, "Save changes");
		assert.equal(buttonStates.opacity, "0");
		await page.screenshot({ animations: "disabled", path: join(output, "composer-keyboard-focus.png") });

		// A text menu row must not inherit the toolbar toggle's circular shape.
		await menuTrigger.click();
		await page.getByRole("menuitem", { name: "Page options", exact: true }).click();
		const agentMenuRow = page.locator(".browser-agent-toggle-menu");
		await agentMenuRow.waitFor();
		const row = await agentMenuRow.evaluate((node) => ({ height: node.getBoundingClientRect().height, aspectRatio: getComputedStyle(node).aspectRatio }));
		assert(row.height <= 48, `Page options must use compact text rows: ${JSON.stringify(row)}`);
		assert.equal(row.aspectRatio, "auto");
		await page.screenshot({ animations: "disabled", path: join(output, "page-options-rows.png") });
		await page.keyboard.press("Escape");

		await page.evaluate(async () => {
			const response = await window.kestrel.request({ type: "browser-create-tab", input: "kestrel://settings", active: true });
			if (!response.ok) throw new Error(response.error);
		});
		await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
		await selectSettingsSection(page, "agent-general", "General");
		const styleChoices = page.getByRole("group", { name: "Communication style", exact: true });
		await styleChoices.waitFor();
		await assertPill(".segmented");
		await assertPill(".settings-search-field");
		const choices = await styleChoices.locator("button").evaluateAll((nodes) => nodes.map((node) => {
			const style = getComputedStyle(node);
			return { divider: style.borderRightWidth, radius: parseFloat(style.borderRadius), height: node.getBoundingClientRect().height };
		}));
		assert(choices.every((choice) => choice.divider === "0px" && choice.radius >= choice.height / 2), "Segment choices must be inset pills without old dividers");
		const friendly = styleChoices.getByRole("button", { name: "Friendly", exact: true });
		await friendly.focus();
		await page.keyboard.press("Space");
		await page.waitForFunction(() => document.querySelector('.segmented button[aria-pressed="true"]')?.textContent === "Friendly");
		await page.screenshot({ animations: "disabled", path: join(output, "settings-unified-controls.png") });
		await page.emulateMedia({ reducedMotion: "reduce" });
		await windowSize(760, 760);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "Settings controls must reflow");
		await page.screenshot({ animations: "disabled", path: join(output, "settings-reduced-motion-narrow.png") });
		assert.deepEqual(pageErrors, [], "Renderer must stay free of uncaught errors");
	}

	console.log(`${baseline ? "Baseline capture" : "UI details"} passed: ${output}`);
}

try {
	await main();
} catch (error) {
	await page?.screenshot({ animations: "disabled", path: join(output, "failure.png") }).catch(() => {});
	throw error;
} finally {
	await application?.close();
	rmSync(profileRoot, { recursive: true, force: true });
}
