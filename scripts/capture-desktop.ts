import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const captureName =
	process.env.KESTREL_CAPTURE_NAME ??
	(process.argv.includes("--final-native-graphite")
		? "final-native-graphite"
		: process.argv.includes("--natural-controls")
			? "natural-controls"
			: process.argv.includes("--model-tiers")
				? "model-tiers"
				: process.argv.includes("--native-graphite")
					? "native-graphite"
					: process.argv.includes("--mineral-current")
						? "mineral-current"
						: process.argv.includes("--setup-revised")
							? "setup-revised"
							: process.argv.includes("--workstrand-pass1")
								? "workstrand-pass1"
								: process.argv.includes("--workstrand-revised")
									? "workstrand-revised"
									: process.argv.includes("--revised")
										? "revised"
										: "initial");
const output = join(root, "artifacts", "screenshots", "desktop", captureName);
const testData = join(root, ".tmp", "desktop-capture-data");
const captureHome = join(testData, "home");
const captureCodexHome = join(testData, "codex-home");
const captureConfigHome = join(testData, "config");
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const forbiddenPersonalText = packagedExecutable
	? [homedir(), process.env.USER, process.env.LOGNAME].filter(
			(value): value is string => Boolean(value && value.length >= 4),
		)
	: [];

await rm(testData, { recursive: true, force: true });
await mkdir(output, { recursive: true });
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
		// A packaged macOS app needs the signed-in user's Keychain home for
		// safeStorage. All application data, CLI configuration, provider
		// discovery, and captured state remain isolated below testData.
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

async function capture(page: Page, name: string, duration = 260) {
	await settle(page, duration);
	const visibleText = await page.locator("body").innerText();
	const leaked = forbiddenPersonalText.find((value) =>
		visibleText.includes(value),
	);
	if (leaked)
		throw new Error(
			`${name} exposed host identity or home-directory text in the capture.`,
		);
	await page.screenshot({ path: join(output, name), fullPage: false });
}

async function assertNoPageOverflow(page: Page, label: string) {
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth,
	);
	if (overflow) throw new Error(`${label} has page-level horizontal overflow.`);
}

function normalizeVisibleCopy(value: string) {
	return value
		.trim()
		.toLocaleLowerCase()
		.replace(/[.?!:]+$/g, "");
}

async function assertDistinctVisibleCopy(
	page: Page,
	label: string,
	selectors: string[],
) {
	const values = (
		await Promise.all(
			selectors.map(async (selector) => {
				const element = page.locator(selector).first();
				return (await element.count()) && (await element.isVisible())
					? normalizeVisibleCopy((await element.innerText()) ?? "")
					: "";
			}),
		)
	).filter(Boolean);
	const duplicate = values.find(
		(value, index) => values.indexOf(value) !== index,
	);
	if (duplicate)
		throw new Error(
			`${label} repeats visible copy: ${JSON.stringify(duplicate)}.`,
		);
}

async function openTool(page: Page, label: string) {
	await page.keyboard.press("Meta+K");
	await page
		.getByRole("heading", { name: "Capabilities", exact: true })
		.waitFor();
	await page
		.locator(".command-groups button")
		.filter({ has: page.getByText(label, { exact: true }) })
		.first()
		.click();
	await page.locator(".browser-app-page").waitFor();
	await assertDistinctVisibleCopy(page, `${label} surface`, [
		".browser-tab.active [role='tab'] .browser-tab-title",
		".browser-app-page h1",
	]);
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
		`Desktop capture did not open a window${detail ? `:\n${detail}` : "."}`,
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
	await page.setViewportSize({ width: 1320, height: 860 });
	await page.evaluate(() => {
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});

	await page.getByRole("heading", { name: /Your AI answers/ }).waitFor();
	await capture(page, "setup-01-welcome.png");

	await page.getByRole("button", { name: "Get started" }).click();
	await page
		.getByRole("heading", { name: "Know what leaves this Mac." })
		.waitFor();
	await capture(page, "setup-02-before-you-begin.png");
	await page
		.locator(".warning-panel details")
		.first()
		.locator("summary")
		.click();
	await capture(page, "setup-02-boundary-detail.png", 120);
	await page.getByLabel("I understand these boundaries").check();
	await page.getByRole("button", { name: "Continue" }).click();

	await page
		.getByRole("heading", { name: "Where should answers come from?" })
		.waitFor();
	await assertDistinctVisibleCopy(page, "Choose-model setup", [
		".setup-rail li.current strong",
		".setup-stage h1",
	]);
	await capture(page, "setup-03-choose-model.png");

	await page.getByRole("button", { name: /Use an account/ }).click();
	await page.getByRole("heading", { name: "Connect an account." }).waitFor();
	await capture(page, "setup-04-account.png");

	await page.getByRole("button", { name: "Back" }).click();
	await page.getByRole("button", { name: /Try free providers/ }).click();
	await page
		.getByRole("heading", { name: "Connect a free account." })
		.waitFor();
	await capture(page, "setup-04-free-providers.png");

	await page.setViewportSize({ width: 640, height: 760 });
	await capture(page, "setup-04-free-providers-compact.png");
	await assertNoPageOverflow(page, "Compact provider setup");
	const railRows = await page.locator(".setup-rail ol").evaluate((rail) => {
		const items = [...rail.querySelectorAll("li")].map((item) =>
			Math.round(item.getBoundingClientRect().top),
		);
		return new Set(items).size;
	});
	if (railRows !== 1)
		throw new Error("Compact setup progress no longer fits on one row.");

	await page.setViewportSize({ width: 1320, height: 860 });
	await page.getByRole("button", { name: "Back" }).click();
	await page.getByRole("button", { name: /Run on this Mac/ }).click();
	await page.getByRole("heading", { name: "Set up a local model." }).waitFor();
	await capture(page, "setup-04-local-model.png");

	await page.getByRole("button", { name: "Continue" }).click();
	await page
		.getByRole("heading", { name: "You're set.", exact: true })
		.waitFor();
	await capture(page, "setup-05-ready.png");

	await page.getByRole("button", { name: /Open Kestrel/ }).click();
	await page.locator("#runtime-prompt").waitFor();
	await page.getByRole("heading", { name: "Good to see you." }).waitFor();
	await capture(page, "workspace-new-agent-and-tab.png", 360);

	await page.keyboard.press("Meta+H");
	await page
		.getByRole("heading", { name: "Pages you visited", exact: true })
		.waitFor();
	await assertDistinctVisibleCopy(page, "History surface", [
		".agent-sidebar-footer button[aria-current='page'] span",
		".browser-library h1",
	]);
	await capture(page, "surface-history.png");

	await page.keyboard.press("Meta+J");
	await page
		.getByRole("heading", { name: "Files from the web", exact: true })
		.waitFor();
	await assertDistinctVisibleCopy(page, "Downloads surface", [
		".agent-sidebar-footer button[aria-current='page'] span",
		".browser-library h1",
	]);
	await capture(page, "surface-downloads.png");

	await page
		.locator(".agent-sidebar-footer")
		.getByRole("button", { name: "Browser", exact: true })
		.click();
	await page.getByRole("heading", { name: "Good to see you." }).waitFor();

	await page.getByLabel("Task settings").click();
	await page.getByText("Task settings", { exact: true }).waitFor();
	await capture(page, "workspace-task-settings.png", 120);
	await page.getByLabel("Task settings").click();

	const firstSession = page
		.locator(".agent-sidebar-history-list > button")
		.first();
	if (await firstSession.count()) {
		await firstSession.click();
		await page.locator(".conversation-view").waitFor();
		await capture(page, "workspace-conversation.png");
	}
	await page
		.getByRole("button", { name: "New task", exact: true })
		.first()
		.click();

	await page.keyboard.press("Meta+K");
	await page.getByLabel("Search Kestrel").waitFor();
	await capture(page, "workspace-command-center.png", 160);

	await openTool(page, "Readiness");
	await page
		.getByRole("heading", { name: /Ready for work|Needs attention/ })
		.waitFor();
	await capture(page, "surface-readiness.png");

	await openTool(page, "Approvals");
	await page
		.getByRole("heading", { name: /Review this action|No approvals waiting/ })
		.waitFor();
	await capture(page, "surface-approvals.png");

	await openTool(page, "Life Context");
	await page
		.getByRole("heading", { name: "Your context", exact: true })
		.waitFor();
	await capture(page, "surface-life-calendar.png");
	await page.getByRole("button", { name: "Memory", exact: true }).click();
	await capture(page, "surface-life-memory.png");

	await openTool(page, "Research");
	await page
		.getByRole("heading", { name: "Search with sources", exact: true })
		.waitFor();
	await capture(page, "surface-research.png");

	await openTool(page, "Artifacts");
	await page
		.getByRole("heading", { name: "Verified results", exact: true })
		.waitFor();
	await capture(page, "surface-artifacts.png");

	await openTool(page, "Work");
	await page
		.getByRole("heading", { name: "Plan and track", exact: true })
		.waitFor();
	await capture(page, "surface-work.png");

	await openTool(page, "Opportunities");
	await page.locator(".event-applications-page").waitFor();
	await capture(page, "surface-opportunities.png");

	await openTool(page, "Activity");
	await page
		.getByRole("heading", { name: "What happened", exact: true })
		.waitFor();
	await capture(page, "surface-activity.png");

	await openTool(page, "Extensions");
	await page.locator(".dashboard-extensions").waitFor();
	await capture(page, "surface-extensions.png");

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.getByRole("heading", { name: "Preferences", exact: true })
		.waitFor();
	await assertDistinctVisibleCopy(page, "Settings shell", [
		".agent-sidebar-footer button[aria-current='page'] span",
		".page-header h1",
	]);
	await assertDistinctVisibleCopy(page, "Connections settings", [
		".settings-nav button[aria-current='page'] > span",
		".settings-content .settings-panel-header h2",
		".settings-content .settings-panel-header .eyebrow",
	]);
	await capture(page, "settings-connections.png");

	const settingsSections = [
		["Browser", "settings-browser.png"],
		["General", "settings-general.png"],
		["Models", "settings-models.png"],
		["Intelligence & Memory", "settings-memory.png"],
		["Agent Plugins", "settings-extensions.png"],
		["Privacy", "settings-privacy.png"],
		["Advanced", "settings-advanced.png"],
	] as const;
	for (const [label, filename] of settingsSections) {
		await page
			.locator(".settings-nav")
			.getByRole("button", { name: new RegExp(`^${label}`) })
			.click();
		await assertDistinctVisibleCopy(page, `${label} settings`, [
			".settings-nav button[aria-current='page'] > span",
			".settings-content .settings-panel-header h2",
			".settings-content .settings-panel-header .eyebrow",
		]);
		await capture(page, filename, 120);
	}

	await page
		.getByRole("button", { name: "New task", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "Browser", exact: true }).click();
	await page.getByRole("heading", { name: "Good to see you." }).waitFor();
	await page.setViewportSize({ width: 640, height: 760 });
	await page.locator("#runtime-prompt").waitFor();
	await capture(page, "compact-new-agent.png");
	await assertNoPageOverflow(page, "Compact workspace");

	await page.keyboard.press("Meta+K");
	await page.getByLabel("Search Kestrel").waitFor();
	await capture(page, "compact-command-center.png", 160);
	const commandBounds = await page
		.locator(".command-center")
		.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			return {
				top: bounds.top,
				bottom: bounds.bottom,
				viewportHeight: window.innerHeight,
			};
		});
	if (
		commandBounds.top < 0 ||
		commandBounds.bottom > commandBounds.viewportHeight
	)
		throw new Error("Compact command center is outside the usable viewport.");

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.locator(".command-center").waitFor({ state: "detached" });
	if ((await page.locator(".command-center").count()) !== 0)
		throw new Error("Command center stayed open after Settings navigation.");
	await capture(page, "compact-settings.png");
	await assertNoPageOverflow(page, "Compact Settings");

	const focusTrigger = page
		.locator(".agent-sidebar-footer")
		.getByRole("button", { name: "Browser", exact: true });
	// Verify focus the way a keyboard user reaches this control. Programmatic
	// focus intentionally does not always match :focus-visible in Chromium.
	await focusTrigger.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	const focusStyle = await page.evaluate(() => {
		const element = document.activeElement as HTMLElement | null;
		const style = element ? getComputedStyle(element) : null;
		return {
			label:
				element?.getAttribute("aria-label") ??
				element?.textContent?.trim() ??
				"",
			outline: style?.outlineStyle ?? "none",
			width: style?.outlineWidth ?? "0px",
		};
	});
	if (
		focusStyle.label !== "Browser" ||
		focusStyle.outline === "none" ||
		focusStyle.width === "0px"
	)
		throw new Error("Keyboard focus is not visibly represented.");

	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.reload();
	await page.waitForLoadState("domcontentloaded");
	await page
		.getByRole("button", { name: "New task", exact: true })
		.first()
		.waitFor();
	await page.keyboard.press("Meta+K");
	await page
		.locator(".command-groups button")
		.filter({ hasText: "Approvals" })
		.click();
	await settle(page, 30);
	const runningAnimations = await page.locator("body").evaluate(() =>
		document
			.getAnimations()
			.filter((animation) => {
				const duration = animation.effect?.getComputedTiming().duration;
				return (
					animation.playState === "running" &&
					typeof duration === "number" &&
					duration > 50
				);
			})
			.map((animation) => {
				const target =
					animation.effect instanceof KeyframeEffect
						? animation.effect.target
						: null;
				return {
					duration: animation.effect?.getComputedTiming().duration,
					target:
						target instanceof HTMLElement
							? `${target.tagName}.${target.className}`
							: "unknown",
				};
			}),
	);
	if (runningAnimations.length > 0)
		throw new Error(
			`Reduced motion left a running interface animation: ${JSON.stringify(runningAnimations)}`,
		);
	await capture(page, "compact-reduced-motion.png", 20);

	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setEmulatedMedia", {
		features: [
			{ name: "prefers-reduced-motion", value: "reduce" },
			{ name: "prefers-reduced-transparency", value: "reduce" },
		],
	});
	const transparency = await page
		.locator(".agent-sidebar")
		.evaluate((element) => getComputedStyle(element).backdropFilter);
	if (transparency !== "none")
		throw new Error("Reduced transparency did not keep the agent rail matte.");
	await capture(page, "compact-reduced-transparency.png", 20);

	if (runtimeErrors.length > 0)
		throw new Error(`Renderer errors: ${runtimeErrors.join(" | ")}`);
} finally {
	await application.close();
}

console.log(output);
