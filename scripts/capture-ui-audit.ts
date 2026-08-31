import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";
import { seedLifeContextFixture } from "./ui-audit-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const outputOverride = process.env.KESTREL_UI_AUDIT_OUTPUT_ROOT;
const outputRoot = outputOverride
	? resolve(outputOverride)
	: join(root, "artifacts", "ui-audit", "baseline");
const manifestPath = outputOverride
	? join(outputRoot, "capture-manifest.json")
	: join(root, "artifacts", "ui-audit", "capture-manifest.json");
const testData = join(root, ".tmp", "ui-audit-capture-data");
const captureHome = join(testData, "home");
const captureCodexHome = join(testData, "codex-home");
const captureConfigHome = join(testData, "config");
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const forbiddenPersonalText = packagedExecutable
	? [homedir(), process.env.USER, process.env.LOGNAME].filter(
			(value): value is string => Boolean(value && value.length >= 4),
		)
	: [];

const VIEWPORTS = {
	wide: { width: 1440, height: 900, label: "wide" },
	normal: { width: 1280, height: 800, label: "normal" },
	compact: { width: 640, height: 760, label: "compact" },
} as const;

type ViewportKey = keyof typeof VIEWPORTS;

const manifest: Array<{
	id: string;
	viewport: ViewportKey;
	file: string;
	surface: string;
	state?: string;
}> = [];

await rm(testData, { recursive: true, force: true });
await rm(outputRoot, { recursive: true, force: true });
for (const key of Object.keys(VIEWPORTS) as ViewportKey[]) {
	await mkdir(join(outputRoot, key), { recursive: true });
}
await mkdir(captureHome, { recursive: true });
await mkdir(captureCodexHome, { recursive: true });
await mkdir(captureConfigHome, { recursive: true });

const captureEnvironment = Object.fromEntries(
	["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]!]],
	),
);

const application = await electron.launch({
	...(packagedExecutable
		? { executablePath: packagedExecutable, args: [] }
		: {
				args: [join(root, "apps", "desktop", "out", "main", "index.js")],
			}),
	env: {
		...captureEnvironment,
		HOME: packagedExecutable ? homedir() : captureHome,
		USER: "kestrel-capture",
		LOGNAME: "kestrel-capture",
		CODEX_HOME: captureCodexHome,
		CLAUDE_CONFIG_DIR: join(captureConfigHome, "claude"),
		XDG_CONFIG_HOME: captureConfigHome,
		KESTREL_TEST_USER_DATA: testData,
		KESTREL_DISABLE_UPDATES: "1",
		KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
		KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
	},
});

async function settle(page: Page, duration = 260) {
	await page.waitForTimeout(duration);
}

async function capture(
	page: Page,
	viewport: ViewportKey,
	surface: string,
	name: string,
	options: { duration?: number; state?: string; fullPage?: boolean } = {},
) {
	const { duration = 260, state, fullPage = false } = options;
	await settle(page, duration);
	const visibleText = await page.locator("body").innerText();
	const leaked = forbiddenPersonalText.find((value) =>
		visibleText.includes(value),
	);
	if (leaked)
		throw new Error(
			`${name} exposed host identity or home-directory text in the capture.`,
		);
	const filename = `${name}.png`;
	const filePath = join(outputRoot, viewport, filename);
	await page.screenshot({ path: filePath, fullPage });
	manifest.push({
		id: `${viewport}/${name}`,
		viewport,
		file: relative(dirname(manifestPath), filePath),
		surface,
		...(state ? { state } : {}),
	});
}

async function setViewport(page: Page, viewport: ViewportKey) {
	const size = VIEWPORTS[viewport];
	await page.setViewportSize({ width: size.width, height: size.height });
}

async function openBrowserHome(page: Page) {
	const brand = page
		.locator(".kestrel-sidebar-brand")
		.getByRole("button", { name: /Open .+ browser/ });
	if (await brand.count()) {
		await brand.click();
	} else {
		await page.keyboard.press("Meta+K");
		await page
			.locator(".command-groups button")
			.filter({ has: page.getByText("Browser", { exact: true }) })
			.first()
			.click();
	}
	await page
		.getByRole("heading", { name: /Hi there|what should we dive into/ })
		.waitFor({ timeout: 8_000 })
		.catch(() => page.locator("#new-tab-title").waitFor());
}

async function openTool(page: Page, label: string) {
	await page.keyboard.press("Meta+K");
	await page
		.getByRole("heading", { name: "Command Center", exact: true })
		.waitFor();
	await page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first()
		.click();
	// Route exits remain mounted briefly for an interruptible Motion transition.
	// The last keyed page is the newly selected destination.
	await page.locator(".browser-app-page").last().waitFor({ timeout: 8_000 });
	await settle(page);
}

async function seedLifeContext(page: Page) {
	await page.evaluate(seedLifeContextFixture);
}

async function captureSetupFlow(page: Page, viewport: ViewportKey) {
	await setViewport(page, viewport);
	await page.evaluate(() => {
		localStorage.removeItem("kestrel:onboarded");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.getByRole("heading", { name: /Your AI answers/ }).waitFor();
	await capture(page, viewport, "setup", "setup-01-welcome", {
		state: "first-run",
	});

	await page.getByRole("button", { name: "Get started" }).click();
	await page
		.getByRole("heading", { name: "Know what leaves this Mac." })
		.waitFor();
	await capture(page, viewport, "setup", "setup-02-before-you-begin");
	await page
		.locator(".warning-panel details")
		.first()
		.locator("summary")
		.click();
	await capture(page, viewport, "setup", "setup-02-boundary-detail", {
		state: "detail-expanded",
		duration: 120,
	});
	await page.getByLabel("I understand these boundaries").check();
	await page.getByRole("button", { name: "Continue" }).click();

	await page
		.getByRole("heading", { name: "Where should answers come from?" })
		.waitFor();
	await capture(page, viewport, "setup", "setup-03-choose-model");

	await page.getByRole("button", { name: /Use an account/ }).click();
	await page.getByRole("heading", { name: "Connect an account." }).waitFor();
	await capture(page, viewport, "setup", "setup-04-account", {
		state: "model-accounts",
	});

	await page.getByRole("button", { name: "Back" }).click();
	await page.getByRole("button", { name: /Try free providers/ }).click();
	await page
		.getByRole("heading", { name: "Set up free provider accounts." })
		.waitFor();
	await capture(page, viewport, "setup", "setup-04-free-providers", {
		state: "model-open",
	});

	await page.getByRole("button", { name: "Back" }).click();
	await page.getByRole("button", { name: /Run on this Mac/ }).click();
	await page.getByRole("heading", { name: "Set up a local model." }).waitFor();
	await capture(page, viewport, "setup", "setup-04-local-model", {
		state: "model-local",
	});

	const doLater = page.getByRole("button", { name: "Do this later" });
	if (await doLater.isVisible()) {
		await doLater.click();
	} else {
		await page.getByRole("button", { name: "Continue" }).click();
	}
	await page
		.getByRole("heading", { name: "You're set.", exact: true })
		.waitFor();
	await capture(page, viewport, "setup", "setup-05-ready", { state: "ready" });

	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.removeItem("kestrel:setup-step");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor({ timeout: 15_000 });
}

async function captureWorkspaceSurfaces(page: Page, viewport: ViewportKey) {
	await setViewport(page, viewport);
	// The prior surface can be a kestrel:// page left by the preceding viewport.
	// Always navigate through the product control so this capture is Browser Home,
	// rather than an incidental tab retained from another audit state.
	await openBrowserHome(page);
	await capture(page, viewport, "workspace", "workspace-new-tab", {
		state: "populated-default",
		duration: 360,
	});

	await openTool(page, "Agent");
	await page.locator(".agent-workspace-page, .browser-app-page").last().waitFor();
	await capture(page, viewport, "agent", "surface-agent");

	await openTool(page, "Projects");
	await capture(page, viewport, "projects", "surface-projects");

	await openTool(page, "Writing Studio");
	await capture(page, viewport, "writing", "surface-writing-studio");

	await openTool(page, "History");
	await page.locator("#history-title, .browser-library h1").first().waitFor();
	await capture(page, viewport, "history", "surface-history");

	await openTool(page, "Bookmarks");
	await page.locator(".browser-library h1").first().waitFor();
	await capture(page, viewport, "bookmarks", "surface-bookmarks");

	await openTool(page, "Downloads");
	await page
		.getByRole("heading", { name: "Downloaded files", exact: true })
		.waitFor();
	await capture(page, viewport, "downloads", "surface-downloads");

	await openBrowserHome(page);
	await page.keyboard.press("Meta+K");
	await page.getByLabel("Search Kestrel").waitFor();
	await capture(page, viewport, "command-center", "workspace-command-center", {
		state: "open",
	});

	await openTool(page, "Readiness");
	await capture(page, viewport, "readiness", "surface-readiness");

	await openTool(page, "Approvals");
	await capture(page, viewport, "approvals", "surface-approvals-empty", {
		state: "empty",
	});

	await openTool(page, "Life Context");
	const life = page.locator(".life-product-surface");
	await life.getByRole("heading", { name: "Life", exact: true }).waitFor();
	await capture(page, viewport, "life", "surface-life-calendar");
	await life.getByRole("button", { name: "People", exact: true }).click();
	await capture(page, viewport, "life", "surface-life-people");
	await life.getByRole("button", { name: "Memory", exact: true }).click();
	await capture(page, viewport, "life", "surface-life-memory");

	await openTool(page, "Research");
	await capture(page, viewport, "research", "surface-research");

	await openTool(page, "Artifacts");
	await capture(page, viewport, "artifacts", "surface-artifacts");

	await openTool(page, "Work");
	await capture(page, viewport, "work", "surface-work");

	await openTool(page, "Opportunities");
	await capture(page, viewport, "opportunities", "surface-opportunities");

	await openTool(page, "Activity");
	await capture(page, viewport, "activity", "surface-activity");

	await openTool(page, "Extensions");
	await capture(page, viewport, "extensions", "surface-extensions");

	await openTool(page, "Settings");
	await page
		.getByRole("heading", { name: "Settings", exact: true })
		.waitFor();
	await capture(page, viewport, "settings", "settings-connections");

	const settingsSections = [
		["browser", "Browser", "settings-browser.png"],
		["general", "General", "settings-general.png"],
		["models", "Models", "settings-models.png"],
		["intelligence", "Memory", "settings-memory.png"],
		["extensions", "Plugins", "settings-extensions.png"],
		["privacy", "Privacy", "settings-privacy.png"],
		["advanced", "Advanced", "settings-advanced.png"],
	] as const;
	for (const [id, label, filename] of settingsSections) {
		const compactPicker = page.locator(".settings-section-picker select");
		if (await compactPicker.isVisible()) {
			await compactPicker.selectOption(id);
		} else if (label === "Browser") {
			await page
				.locator(".settings-scope-switcher")
				.getByRole("tab", { name: /^Browser/ })
				.click();
		} else {
			if (label === "General")
				await page
					.locator(".settings-scope-switcher")
					.getByRole("tab", { name: /^Agent/ })
					.click();
			await page
				.locator(".settings-nav")
				.getByRole("button", { name: new RegExp(`^${label}`) })
				.click();
		}
		const baseName = filename.replace(".png", "");
		await capture(page, viewport, "settings", baseName, { duration: 120 });
	}
}

async function captureInteractionStates(page: Page, viewport: ViewportKey) {
	await setViewport(page, viewport);
	await openBrowserHome(page);

	const modelSelector = page.locator(".kestrel-home-model-selector");
	if (await modelSelector.count()) {
		await modelSelector.click();
		await capture(page, viewport, "new-tab", "workspace-model-selector-open", {
			state: "popover-open",
			duration: 120,
		});
		await page.keyboard.press("Escape");
	}

	await page.keyboard.press("Meta+/");
	await page.getByRole("heading", { name: /Keyboard shortcuts/i }).waitFor();
	await capture(page, viewport, "modal", "modal-keyboard-shortcuts", {
		state: "open",
	});
	await page.keyboard.press("Escape");

	const taskSettings = page.locator(
		".agent-conversation-host .task-settings summary",
	);
	if (await taskSettings.count()) {
		await taskSettings.click();
		await capture(page, viewport, "agent-sidebar", "workspace-task-settings-open", {
			state: "disclosure-open",
			duration: 120,
		});
	}
}

async function captureApprovalsPending(page: Page, viewport: ViewportKey) {
	await setViewport(page, viewport);
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	await page.keyboard.press("Meta+K");
	await page
		.locator(".command-groups button")
		.filter({ has: page.getByText("Approvals", { exact: true }) })
		.first()
		.click();
	const hasPending = await page
		.getByRole("heading", { name: "Review this action" })
		.isVisible()
		.catch(() => false);
	if (hasPending) {
		await capture(page, viewport, "approvals", "surface-approvals-pending", {
			state: "pending",
		});
	}
}

async function captureAccessibilityStates(page: Page) {
	await setViewport(page, "compact");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.reload();
	await page.locator("#runtime-prompt").waitFor({ state: "attached" });
	await openTool(page, "Approvals");
	await settle(page, 30);
	await capture(page, "compact", "accessibility", "compact-reduced-motion", {
		state: "reduced-motion",
		duration: 20,
	});

	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setEmulatedMedia", {
		features: [
			{ name: "prefers-reduced-motion", value: "reduce" },
			{ name: "prefers-reduced-transparency", value: "reduce" },
		],
	});
	await capture(
		page,
		"compact",
		"accessibility",
		"compact-reduced-transparency",
		{ state: "reduced-transparency", duration: 20 },
	);
}

const launchOutput: string[] = [];
for (const stream of [
	application.process().stdout,
	application.process().stderr,
]) {
	stream?.on("data", (chunk) => {
		launchOutput.push(String(chunk));
		if (launchOutput.length > 100) launchOutput.shift();
	});
}

let page: Page;
try {
	page = await application.firstWindow();
} catch (cause) {
	await application.close().catch(() => undefined);
	const detail = launchOutput.join("").trim().slice(-8_000);
	throw new Error(
		`UI audit capture did not open a window${detail ? `:\n${detail}` : "."}`,
		{ cause },
	);
}

const runtimeErrors: string[] = [];
page.on("console", (message) => {
	if (message.type() === "error") runtimeErrors.push(message.text());
});
page.on("pageerror", (error) => runtimeErrors.push(error.message));

try {
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});

	// Setup flow captured at normal width only (full flow is expensive).
	await captureSetupFlow(page, "normal");

	await seedLifeContext(page);
	await page.reload();
	await page.locator("#runtime-prompt").waitFor({ timeout: 15_000 });

	for (const viewport of ["wide", "normal", "compact"] as ViewportKey[]) {
		await captureWorkspaceSurfaces(page, viewport);
	}

	await captureInteractionStates(page, "normal");
	await captureApprovalsPending(page, "normal");
	await captureAccessibilityStates(page);

	if (runtimeErrors.length > 0)
		console.warn(`Renderer errors during capture: ${runtimeErrors.join(" | ")}`);
} finally {
	await application.close();
}

await writeFile(
	manifestPath,
	JSON.stringify(
		{
			capturedAt: new Date().toISOString(),
			viewports: VIEWPORTS,
			screenshots: manifest,
			count: manifest.length,
		},
		null,
		2,
	),
);

console.log(`Captured ${manifest.length} screenshots to ${outputRoot}`);
