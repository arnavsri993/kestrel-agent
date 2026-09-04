import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import {
	openKestrelDestination,
	revealNewTabControl,
} from "./desktop-browser-test-helpers.mjs";

const mainBundle = readFileSync(resolve("apps/desktop/out/main/index.js"), "utf8");
assert.match(
	mainBundle,
	/installMacFileIconCrashGuard\s*\(\s*app\s*\)/,
	"The packaged main process must install the macOS file-icon crash guard.",
);

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-layout-"));
const userData = join(root, "user-data");
const evidenceDirectory = resolve(".tmp/desktop-layout");
mkdirSync(evidenceDirectory, { recursive: true });
const evidenceStamp = new Date().toISOString().replace(/[:.]/g, "-");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];

assert.doesNotMatch(
	mainBundle,
	/getFileIcon\s*\(\s*process\.execPath/,
	"The packaged startup path must not ask Electron to resolve its own executable icon.",
);

let application;
let page;
const pageErrors = [];
const runtimeDiagnostics = {
	lastOperation: "before launch",
	lastBreakpoint: null,
	pageClosed: false,
	pageCrashed: false,
	process: {
		pid: null,
		exitCode: null,
		signalCode: null,
		error: null,
		closeCode: null,
		closeSignal: null,
		stderr: "",
	},
};

function noteOperation(operation, breakpoint = null) {
	runtimeDiagnostics.lastOperation = operation;
	if (breakpoint !== null) runtimeDiagnostics.lastBreakpoint = breakpoint;
}

function appendProcessStderr(chunk) {
	const value = String(chunk).replace(/(?:api[_-]?key|token|secret|password)=\S+/gi, "$1=<redacted>");
	runtimeDiagnostics.process.stderr = `${runtimeDiagnostics.process.stderr}${value}`.slice(-12_000);
}

function observeApplicationProcess() {
	const child = application?.process();
	if (!child) return;
	runtimeDiagnostics.process.pid = child.pid ?? null;
	child.on("error", (error) => {
		runtimeDiagnostics.process.error = error.message;
	});
	child.on("exit", (code, signal) => {
		runtimeDiagnostics.process.exitCode = code;
		runtimeDiagnostics.process.signalCode = signal;
	});
	child.on("close", (code, signal) => {
		runtimeDiagnostics.process.closeCode = code;
		runtimeDiagnostics.process.closeSignal = signal;
	});
	child.stderr?.on("data", appendProcessStderr);
}

async function captureFailureEvidence(error) {
	const prefix = join(evidenceDirectory, `${evidenceStamp}-${packagedExecutable ? "packaged" : "source"}`);
	const diagnosticsPath = `${prefix}-diagnostics.json`;
	const screenshotPath = `${prefix}-failure.png`;
	const diagnostics = {
		mode: packagedExecutable ? "packaged" : "source",
		executablePath,
		userData,
		failure: error instanceof Error ? error.stack ?? error.message : String(error),
		pageErrors,
		runtime: runtimeDiagnostics,
	};
	if (page) {
		try {
			diagnostics.layout = await readLayout(page);
		} catch (layoutError) {
			diagnostics.layoutError = String(layoutError);
		}
		try {
			diagnostics.taskSettings = await readTaskSettingsLayout(page);
		} catch (taskSettingsError) {
			diagnostics.taskSettingsError = String(taskSettingsError);
		}
		try {
			diagnostics.interaction = await readInteractionDiagnostics(page);
		} catch (interactionError) {
			diagnostics.interactionError = String(interactionError);
		}
		try {
			diagnostics.unhandledRejections = await readUnhandledRejections(page);
		} catch (rejectionError) {
			diagnostics.unhandledRejectionsError = String(rejectionError);
		}
		try {
			await page.screenshot({ path: screenshotPath, fullPage: false });
			diagnostics.screenshotPath = screenshotPath;
		} catch (screenshotError) {
			diagnostics.screenshotError = String(screenshotError);
		}
	}
	writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
	return { diagnosticsPath, screenshotPath: diagnostics.screenshotPath ?? null };
}

async function readUnhandledRejections(page) {
	return page.evaluate(
		() => window.__kestrelDesktopLayoutUnhandledRejections ?? [],
	);
}

async function readInteractionDiagnostics(page) {
	return page.evaluate(() => {
		const target = document.querySelector("#browser-agent-toggle");
		if (!target) return { target: null };
		const bounds = target.getBoundingClientRect();
		const x = bounds.left + bounds.width / 2;
		const y = bounds.top + bounds.height / 2;
		return {
			target: {
				ariaLabel: target.getAttribute("aria-label"),
				left: bounds.left,
				top: bounds.top,
				right: bounds.right,
				bottom: bounds.bottom,
			},
			hitStack: document.elementsFromPoint(x, y).slice(0, 8).map((element) => ({
				tag: element.tagName,
				id: element.id,
				className: typeof element.className === "string" ? element.className : "",
				pointerEvents: getComputedStyle(element).pointerEvents,
			})),
			activeElement: document.activeElement?.outerHTML?.slice(0, 500) ?? null,
			shell: document.querySelector(".ai-browser-app")?.className ?? null,
		};
	});
}

async function readAgentRailMotionState(page) {
	return page.evaluate(() => {
		const shell = document.querySelector(".ai-browser-app");
		const panel = document.querySelector(".agent-sidebar");
		if (!shell || !panel) throw new Error("The Agent rail is unavailable.");
		const presentedWidth = Number.parseFloat(
			getComputedStyle(shell).getPropertyValue("--agent-panel-presented-width"),
		);
		return {
			width: panel.getBoundingClientRect().width,
			presentedWidth: Number.isFinite(presentedWidth) ? presentedWidth : null,
			settling: shell.classList.contains("agent-sidebar-settling"),
			ariaLabel: document
				.querySelector("#browser-agent-toggle")
				?.getAttribute("aria-label"),
		};
	});
}

function assertNear(actual, expected, message) {
	assert.ok(
		Math.abs(actual - expected) <= 1,
		`${message}: expected ${expected}, got ${actual}`,
	);
}

function rectanglesIntersect(first, second, tolerance = 1) {
	return (
		first.left < second.right - tolerance &&
		second.left < first.right - tolerance &&
		first.top < second.bottom - tolerance &&
		second.top < first.bottom - tolerance
	);
}

function rectCenterY(rect) {
	return (rect.top + rect.bottom) / 2;
}

function expectedAgentPanelWidth(viewportWidth) {
	if (viewportWidth <= 760) return 0;
	if (viewportWidth <= 980) return 288;
	if (viewportWidth <= 1_120) return 312;
	return 336;
}

function expectedNavigationWidth(viewportWidth) {
	return viewportWidth <= 1_120 ? 56 : 216;
}

async function readLayout(page) {
	return page.evaluate(() => {
		const shell = document.querySelector(".ai-browser-app");
		if (!shell) throw new Error("The Kestrel browser shell is unavailable.");
		const bounds = (selector, optional = false) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			if (!rect) {
				if (optional) return { left: 0, right: 0, width: 0 };
				throw new Error(`Missing ${selector}.`);
			}
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
			navigation: bounds(".kestrel-sidebar", true),
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

async function readTaskSettingsLayout(page) {
	return page.evaluate(() => {
		const button = document.querySelector(".kestrel-home-model-selector");
		const panel = document.querySelector(
			".agent-conversation-host .task-settings-panel",
		);
		const composer = document.querySelector(
			".agent-conversation-host .runtime-new-composer",
		);
		const modelTrigger = document.querySelector(
			".agent-conversation-host .model-selector-trigger",
		);
		const taskTrigger = document.querySelector(
			".agent-conversation-host .task-settings-trigger",
		);
		const sendActions = document.querySelector(
			".agent-conversation-host .composer-send-actions",
		);
		const host = document.querySelector(".agent-conversation-host");
		const footer = document.querySelector(
			".agent-conversation-host .composer-footer",
		);
		const contextActions = document.querySelector(
			".agent-conversation-host .composer-context-actions",
		);
		const sendButton = sendActions?.querySelector(
			".send-button, button:not(.voice-button)",
		);
		if (
			!button ||
			!panel ||
			!composer ||
			!modelTrigger ||
			!taskTrigger ||
			!sendActions ||
			!host ||
			!footer ||
			!contextActions ||
			!sendButton
		) {
			throw new Error("Task settings layout is unavailable.");
		}
		const rect = (element) => {
			const bounds = element.getBoundingClientRect();
			return {
				top: bounds.top,
				right: bounds.right,
				bottom: bounds.bottom,
				left: bounds.left,
				width: bounds.width,
				height: bounds.height,
			};
		};
		const buttonStyle = getComputedStyle(button);
		const chevron = button.querySelector("svg");
		return {
			button: rect(button),
			buttonDisplay: buttonStyle.display,
			chevron: chevron ? rect(chevron) : null,
			modelTrigger: rect(modelTrigger),
			taskTrigger: {
				...rect(taskTrigger),
				ariaLabel: taskTrigger.getAttribute("aria-label"),
			},
			sendActions: rect(sendActions),
			sendButton: rect(sendButton),
			contextActions: rect(contextActions),
			footer: rect(footer),
			panel: rect(panel),
			composer: rect(composer),
			host: rect(host),
			controlOrder: [modelTrigger, taskTrigger, sendButton].map((element) =>
				Array.from(footer.querySelectorAll("button, summary")).indexOf(element),
			),
		};
	});
}

function assertTaskSettingsLayout(layout) {
	assert.ok(
		["flex", "inline-flex"].includes(layout.buttonDisplay),
		`New Tab task settings has an unexpected display mode: ${layout.buttonDisplay}.`,
	);
	assert.ok(
		layout.button.height <= 40,
		`New Tab task settings button is too tall: ${layout.button.height}px.`,
	);
	assert.ok(
		layout.button.width <= 200,
		`New Tab task settings button is too wide: ${layout.button.width}px.`,
	);
	assert.ok(
		layout.chevron && layout.chevron.width <= 16 && layout.chevron.height <= 16,
		`New Tab task settings chevron is too large: ${JSON.stringify(layout.chevron)}.`,
	);
	assert.equal(
		layout.taskTrigger.ariaLabel,
		"Task settings",
		"The task-settings trigger must keep its accessible name.",
	);
	assert.ok(
		layout.taskTrigger.width <= 40,
		`Task settings duplicated the model selector label: ${layout.taskTrigger.width}px.`,
	);
	assert.ok(
		!rectanglesIntersect(layout.modelTrigger, layout.taskTrigger),
		`Model and task-settings triggers intersect: ${JSON.stringify({ model: layout.modelTrigger, task: layout.taskTrigger })}.`,
	);
	assert.ok(
		!rectanglesIntersect(layout.taskTrigger, layout.sendActions),
		`Task-settings trigger intersects send actions: ${JSON.stringify({ task: layout.taskTrigger, send: layout.sendActions })}.`,
	);
	assert.ok(
		layout.modelTrigger.right <= layout.taskTrigger.left + 1,
		`Model selector must precede Task settings: ${JSON.stringify({ model: layout.modelTrigger, task: layout.taskTrigger })}.`,
	);
	assert.ok(
		layout.taskTrigger.right <= layout.sendActions.left + 1,
		`Task settings must precede send actions: ${JSON.stringify({ task: layout.taskTrigger, send: layout.sendActions })}.`,
	);
	for (const [label, first, second] of [
		["model and task-settings", layout.modelTrigger, layout.taskTrigger],
		["task-settings and send", layout.taskTrigger, layout.sendActions],
	]) {
		assert.ok(
			Math.abs(rectCenterY(first) - rectCenterY(second)) <= 2,
			`${label} controls are not aligned on the composer row: ${JSON.stringify({ first, second })}.`,
		);
	}
	assert.ok(
		layout.controlOrder[0] < layout.controlOrder[1] &&
			layout.controlOrder[1] < layout.controlOrder[2],
		`Composer controls must remain in model, task-settings, send order: ${JSON.stringify(layout.controlOrder)}.`,
	);
	assert.ok(
		layout.panel.top >= layout.host.top - 1,
		`Task settings panel escaped above the Agent conversation host: ${layout.panel.top} < ${layout.host.top}.`,
	);
	assert.ok(
		layout.panel.bottom <= layout.host.bottom + 1,
		`Task settings panel is clipped below the Agent conversation host: ${layout.panel.bottom} > ${layout.host.bottom}.`,
	);
	assert.ok(
		layout.composer.bottom >= layout.host.bottom - 1,
		`New task composer is not anchored to the bottom of the Agent rail: ${layout.composer.bottom} < ${layout.host.bottom}.`,
	);
}

function assertTheme(layout) {
	assert.deepEqual(layout.theme, {
		canvas: "#0b0c0e",
		sidebar: "#111317",
		solid: "#f5f5f7",
		colorScheme: "dark",
	});
	assert.equal(layout.bridgeReady, true);
}

function assertNoLayoutTransition(properties, label) {
	for (const property of ["width", "max-width", "flex-basis", "height"]) {
		assert.equal(
			properties.includes(property),
			false,
			`${label} must not transition ${property}; layout motion has a single owner.`,
		);
	}
}

function transitionDurationsInSeconds(value) {
	return value.split(",").map((part) => {
		const trimmed = part.trim();
		if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed) / 1_000;
		if (trimmed.endsWith("s")) return Number.parseFloat(trimmed);
		return 0;
	});
}

async function assertMotionContract(page) {
	const motion = await page.evaluate(() => {
		const read = (selector) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`Missing ${selector}.`);
			const style = getComputedStyle(element);
			return {
				transitionProperty: style.transitionProperty,
				transitionDuration: style.transitionDuration,
				animationName: style.animationName,
				willChange: style.willChange,
			};
		};
		return {
			tab: read(".browser-tab"),
			control: read(".browser-toolbar-actions button:not(:disabled)"),
			agent: read(".agent-sidebar"),
			widget: document.querySelector(".kestrel-widget-card")
				? read(".kestrel-widget-card")
				: null,
		};
	});
	const tabProperties = motion.tab.transitionProperty
		.split(",")
		.map((property) => property.trim());
	assertNoLayoutTransition(tabProperties, "Browser tabs");
	assert.equal(
		tabProperties.includes("opacity"),
		false,
		"Motion owns tab lifecycle and drag opacity; CSS must not trail it.",
	);
	assert.equal(
		motion.agent.willChange,
		"auto",
		"The agent rail must not stay GPU-promoted at rest.",
	);
	assertNoLayoutTransition(
		motion.agent.transitionProperty
			.split(",")
			.map((property) => property.trim()),
		"Agent rail",
	);
	assert.ok(
		Math.max(...transitionDurationsInSeconds(motion.control.transitionDuration)) <= 0.15,
		`Control feedback is too slow: ${motion.control.transitionDuration}.`,
	);
	if (motion.widget) {
		const widgetProperties = motion.widget.transitionProperty
			.split(",")
			.map((property) => property.trim());
		assert.equal(
			widgetProperties.includes("transform"),
			false,
			"New Tab widget transform motion must have a single Motion owner.",
		);
	}
}

async function assertNewTabHoverAffordance(page) {
	const control = page.getByRole("button", {
		name: "New Tab",
		exact: true,
	});
	await control.waitFor({ state: "visible" });
	const readStyle = () =>
		control.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				opacity: style.opacity,
				pointerEvents: style.pointerEvents,
				backgroundColor: style.backgroundColor,
				borderRadius: style.borderRadius,
			};
		});
	const idle = await readStyle();
	assert.equal(idle.opacity, "1", "New Tab must remain visible at rest.");
	assert.equal(
		idle.pointerEvents,
		"auto",
		"New Tab must remain interactive at rest.",
	);
	assert.equal(
		idle.backgroundColor,
		"rgba(0, 0, 0, 0)",
		"New Tab must keep a quiet background before hover.",
	);
	await control.hover();
	await page.waitForTimeout(100);
	const hovered = await readStyle();
	assert.notEqual(
		hovered.backgroundColor,
		idle.backgroundColor,
		"New Tab hover must paint its circular background.",
	);
	assert.equal(
		hovered.borderRadius,
		"50%",
		"New Tab hover must retain the circular affordance shape.",
	);
}

async function assertReducedMotionStyles(page) {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const reduced = await page.evaluate(() => {
		const read = (selector) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`Missing ${selector}.`);
			const style = getComputedStyle(element);
			return {
				transitionDuration: style.transitionDuration,
				animationName: style.animationName,
				scrollBehavior: style.scrollBehavior,
			};
		};
		return {
			tab: read(".browser-tab"),
			home: read(".kestrel-home-content"),
		};
	});
	assert.ok(
		reduced.tab.transitionDuration
			.split(",")
			.every((duration) => Number.parseFloat(duration) === 0),
		`Reduced motion left a tab transition active: ${reduced.tab.transitionDuration}.`,
	);
	assert.equal(reduced.home.animationName, "none");
	assert.equal(reduced.tab.scrollBehavior, "auto");
	await page.emulateMedia({ reducedMotion: "no-preference" });
}

async function assertAgentRailInterruption(page) {
	const toggle = page.locator("#browser-agent-toggle");
	const expectedWidth = expectedAgentPanelWidth(
		await page.evaluate(() => innerWidth),
	);
	const readWidth = () =>
		page.locator(".agent-sidebar").evaluate((element) =>
			element.getBoundingClientRect().width,
		);
	const afterTwoFrames = () =>
		page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve)),
				),
		);

	await clickAfterHitTest(page, toggle, "#browser-agent-toggle");
	await page.waitForFunction(
		(target) => {
			const shell = document.querySelector(".ai-browser-app");
			const agent = document.querySelector(".agent-sidebar");
			const width = agent?.getBoundingClientRect().width ?? 0;
			return (
				shell?.classList.contains("agent-sidebar-settling") &&
				width > 8 &&
				width < target - 8
			);
		},
		expectedWidth,
	);
	const openingWidth = await readWidth();

	// Reverse while the spring is live. The rail may briefly carry its incoming
	// velocity, but it must not jump to either endpoint or lock the toggle.
	await clickAfterHitTest(page, toggle, "#browser-agent-toggle");
	await afterTwoFrames();
	const reversedWidth = await readWidth();
	assert.ok(
		reversedWidth > 0 && reversedWidth < expectedWidth,
		`Rail reversal jumped to an endpoint (${reversedWidth}px).`,
	);
	assert.ok(
		Math.abs(reversedWidth - openingWidth) < expectedWidth * 0.36,
		`Rail reversal jumped from ${openingWidth}px to ${reversedWidth}px.`,
	);
	await page.waitForFunction(
		(before) =>
			(document.querySelector(".agent-sidebar")?.getBoundingClientRect().width ?? 0) <
			before - 4,
		openingWidth,
	);
	// Re-open before the close finishes. This proves the next input is accepted
	// during motion and that the new spring starts from the rendered width. Read
	// the first resumed frame before sampling two more frames; displacement over
	// two frames is expected spring motion, not evidence of an endpoint jump.
	// The close spring keeps moving while Playwright resolves the hit target.
	// Sample immediately before dispatching the reopen click so the continuity
	// assertion compares against the width the person could actually see.
	await waitForHitTestTarget(page, "#browser-agent-toggle");
	const closingStateBeforeReopen = await readAgentRailMotionState(page);
	await toggle.click();
	await page.waitForFunction(
		(label) =>
			document.querySelector("#browser-agent-toggle")?.getAttribute("aria-label") ===
			label,
		"Hide Pragmatic",
	);
	const reopenedStart = await readAgentRailMotionState(page);
	const continuityTolerance = Math.max(24, expectedWidth * 0.16);
	assert.ok(
		reopenedStart.settling,
		"Interrupted re-open did not start a settling transition.",
	);
	assert.ok(
		Math.abs(reopenedStart.width - closingStateBeforeReopen.width) <= continuityTolerance,
		`Interrupted re-open did not start from the rendered width (${closingStateBeforeReopen.width}px to ${reopenedStart.width}px; tolerance ${continuityTolerance}px).`,
	);
	if (reopenedStart.presentedWidth !== null) {
		assert.ok(
			Math.abs(reopenedStart.presentedWidth - reopenedStart.width) <= 2,
			`Interrupted re-open presented width diverged from its rendered width (${JSON.stringify(reopenedStart)}).`,
		);
	}
	await afterTwoFrames();
	const reopenedWidth = await readWidth();
	assert.ok(
		reopenedWidth > 0 && reopenedWidth < expectedWidth,
		`Interrupted re-open jumped to an endpoint (${reopenedWidth}px).`,
	);
	await waitForOpenAgentLayout(page, expectedWidth);

	await clickAfterHitTest(page, toggle, "#browser-agent-toggle");
	await waitForCollapsedLayout(page);
}

async function assertTabDragMotion(page, orientation = "horizontal") {
	let lastError;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const tab = page.locator(".browser-tab").first();
		await tab.waitFor();
		const box = await tab.boundingBox();
		assert(box, "The browser tab has no visible bounds.");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		try {
			if (orientation === "vertical") {
				await page.mouse.move(
					box.x + box.width / 2,
					box.y + box.height / 2 + 24,
					{ steps: 4 },
				);
			} else {
				await page.mouse.move(
					box.x + box.width / 2 + 24,
					box.y + box.height / 2,
					{ steps: 4 },
				);
			}
			await page.waitForFunction(
				() => {
					const dragging = document.querySelector(".browser-tab.is-dragging");
					return (
						dragging &&
						Number.parseFloat(getComputedStyle(dragging).opacity) < 0.95
					);
				},
				undefined,
				{ timeout: 5_000 },
			);
			return;
		} catch (error) {
			lastError = error;
		} finally {
			await page.mouse.up();
		}
	}
	throw new Error(`The ${orientation} tab drag feedback did not become visible.`, {
		cause: lastError,
	});
}

async function waitForVerticalTabsToSettle(page) {
	await page.waitForFunction(
		() => document.querySelectorAll(".browser-tab-row-vertical .browser-tab").length >= 2,
	);
	await page.waitForFunction(() => {
		const rail = document.querySelector(".browser-tab-row-vertical");
		if (!rail) return false;
		const railRect = rail.getBoundingClientRect();
		return Array.from(rail.querySelectorAll(".browser-tab")).every((tab) => {
			const rect = tab.getBoundingClientRect();
			return (
				getComputedStyle(tab).transform === "none" &&
				rect.left >= railRect.left - 1 &&
				rect.right <= railRect.right + 1
			);
		});
	});
}

async function readVerticalTabLayout(page) {
	return page.evaluate(() => {
		const rail = document.querySelector(".browser-tab-row-vertical");
		const tabs = document.querySelector(".browser-tab-row-vertical .browser-tabs");
		const viewport = document.querySelector("#browser-viewport");
		if (!rail || !tabs || !viewport) throw new Error("Vertical tab layout is unavailable.");
		const railRect = rail.getBoundingClientRect();
		const viewportRect = viewport.getBoundingClientRect();
		const tabRects = Array.from(rail.querySelectorAll(".browser-tab")).map((tab) => {
			const rect = tab.getBoundingClientRect();
			return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
		});
		return {
			innerWidth,
			trailingOverflow:
				document.documentElement.scrollWidth - document.documentElement.clientWidth,
			rail: { left: railRect.left, right: railRect.right, width: railRect.width },
			tabs: {
				left: tabs.getBoundingClientRect().left,
				right: tabs.getBoundingClientRect().right,
				scrollWidth: tabs.scrollWidth,
				clientWidth: tabs.clientWidth,
			},
			viewport: { left: viewportRect.left, right: viewportRect.right },
			tabRects,
		};
	});
}

function assertVerticalTabGeometry(layout, agentWidth) {
	const expectedRailWidth = layout.innerWidth <= 1120 ? 180 : 208;
	assertNear(
		layout.rail.left,
		layout.viewport.left - expectedRailWidth,
		"vertical tab rail position",
	);
	assertNear(layout.rail.width, expectedRailWidth, "vertical tab rail width");
	assert.ok(
		layout.viewport.left >= layout.rail.right - 1,
		"Vertical tabs overlap the page viewport.",
	);
	assert.ok(
		layout.viewport.right <= layout.innerWidth + 1,
		"Vertical tabs caused page overflow.",
	);
	assertNear(
		layout.viewport.right,
		layout.innerWidth - agentWidth,
		"Vertical page viewport ends before the active agent rail",
	);
	assert.ok(layout.trailingOverflow <= 1, "Vertical tabs caused document overflow.");
	assert.ok(
		layout.tabs.scrollWidth <= layout.tabs.clientWidth + 1,
		"Vertical tabs overflow horizontally instead of scrolling vertically.",
	);
	for (const rect of layout.tabRects) {
		assert.ok(
			rect.left >= layout.rail.left - 1 && rect.right <= layout.rail.right + 1,
		);
	}
}

async function assertVerticalTabLayout(page) {
	await page.getByRole("button", { name: "Tab tools", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Turn On Vertical Tabs", exact: true })
		.click();
	await page.locator(".browser-workspace-vertical").waitFor();
	await waitForVerticalTabsToSettle(page);
	await page.waitForFunction(() => {
		const viewport = document.querySelector("#browser-viewport");
		return viewport && Math.abs(viewport.getBoundingClientRect().right - innerWidth) <= 1;
	});
	assertVerticalTabGeometry(await readVerticalTabLayout(page), 0);
	const verticalViewportProperties = await page.locator("#browser-viewport").evaluate(
		(element) =>
			getComputedStyle(element)
				.transitionProperty.split(",")
				.map((property) => property.trim()),
	);
	assert.equal(
		verticalViewportProperties.includes("right"),
		false,
		"The rAF spring owns vertical browser geometry; CSS must not trail it.",
	);

	await assertTabDragMotion(page, "vertical");
	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	const agentWidth = expectedAgentPanelWidth(
		await page.evaluate(() => innerWidth),
	);
	await waitForOpenAgentLayout(page, agentWidth);
	await page.waitForFunction(() => {
		const viewport = document.querySelector("#browser-viewport");
		const agent = document.querySelector(".agent-sidebar");
		return (
			viewport &&
			agent &&
			Math.abs(
				viewport.getBoundingClientRect().right - agent.getBoundingClientRect().left,
			) <= 1
		);
	});
	assertVerticalTabGeometry(await readVerticalTabLayout(page), agentWidth);

	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	await waitForCollapsedLayout(page);
	await page.waitForFunction(() => {
		const viewport = document.querySelector("#browser-viewport");
		return viewport && Math.abs(viewport.getBoundingClientRect().right - innerWidth) <= 1;
	});
	assertVerticalTabGeometry(await readVerticalTabLayout(page), 0);

	await page.getByRole("button", { name: "Tab tools", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Turn Off Vertical Tabs", exact: true })
		.click();
	await page.locator(".browser-tab-row-horizontal").waitFor();
}

function assertCollapsedLayout(layout) {
	assert.match(layout.classes, /agent-sidebar-collapsed/);
	assertNear(layout.navigation.left, 0, "collapsed navigation left");
	assertNear(
		layout.navigation.width,
		expectedNavigationWidth(layout.innerWidth),
		"collapsed navigation width",
	);
	assertNear(
		layout.main.left,
		0,
		"collapsed browser plane starts at the window edge",
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
	assert.ok(
		layout.viewport.left >= layout.navigation.right - 1,
		"collapsed page viewport overlaps the navigation rail",
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
	assertNear(
		layout.navigation.width,
		expectedNavigationWidth(layout.innerWidth),
		"open navigation width",
	);
	assertNear(
		layout.main.left,
		0,
		"open browser plane starts at the window edge",
	);
	assert.ok(
		layout.main.width > 500,
		`The open browser plane was only ${layout.main.width}px (${layout.columns}).`,
	);
	assertNear(layout.main.right, layout.innerWidth, "open browser plane reaches the window edge");
	assert.ok(
		layout.viewport.left >= layout.navigation.right - 1,
		"open page viewport overlaps the navigation rail",
	);
	assertNear(layout.viewport.right, layout.agent.left, "page viewport ends at Pragmatic");
	assertNear(layout.agent.right, layout.innerWidth, "Pragmatic reaches window edge");
	assertNear(
		layout.agent.width,
		expectedAgentPanelWidth(layout.innerWidth),
		"open Pragmatic width",
	);
	assertTheme(layout);
}

function agentPanelWidthBounds(viewportWidth) {
	if (viewportWidth <= 760) return { min: 0, max: 0 };
	return {
		min: 288,
		max: Math.max(288, Math.min(520, viewportWidth * 0.44)),
	};
}

function assertResponsiveAgentPanelWidth(layout) {
	const bounds = agentPanelWidthBounds(layout.innerWidth);
	assert.ok(
		layout.agent.width >= bounds.min - 1 && layout.agent.width <= bounds.max + 1,
		`Agent panel width escaped its responsive bounds at ${layout.innerWidth}px: ${layout.agent.width}px, expected ${bounds.min}-${bounds.max}px.`,
	);
}

async function setDesktopZoom(
	application,
	page,
	zoomFactor,
	expectedViewportWidth,
) {
	const appliedZoom = await application.evaluate(
		({ BrowserWindow }, requestedZoom) => {
			const window = BrowserWindow.getAllWindows().find(
				(candidate) => !candidate.isDestroyed(),
			);
			if (!window) throw new Error("The Kestrel window is unavailable.");
			window.webContents.setZoomFactor(requestedZoom);
			return window.webContents.getZoomFactor();
		},
		zoomFactor,
	);
	assertNear(appliedZoom, zoomFactor, "Electron zoom factor");
	await page.waitForFunction(
		(expectedWidth) => Math.abs(innerWidth - expectedWidth) <= 2,
		Math.round(expectedViewportWidth),
	);
}

async function setDesktopWindowWidth(application, page, width) {
	noteOperation("resize window", width);
	const appliedWidth = await application.evaluate(
		({ BrowserWindow }, requestedWidth) => {
			const window = BrowserWindow.getAllWindows().find(
				(candidate) => !candidate.isDestroyed(),
			);
			if (!window) throw new Error("The Kestrel window is unavailable.");
			const [, height] = window.getSize();
			window.setSize(requestedWidth, height);
			return window.getSize()[0];
		},
		width,
	);
	assertNear(appliedWidth, width, "Electron window width");
	await page.waitForFunction(
		(expectedWidth) => Math.abs(innerWidth - expectedWidth) <= 2,
		width,
	);
}

async function waitForHitTestTarget(page, selector) {
	await page.waitForFunction((targetSelector) => {
		const target = document.querySelector(targetSelector);
		if (!target) return false;
		const style = getComputedStyle(target);
		if (
			style.pointerEvents === "none" ||
			style.visibility === "hidden" ||
			style.display === "none"
		)
			return false;
		const bounds = target.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return false;
		const hit = document.elementFromPoint(
			bounds.left + bounds.width / 2,
			bounds.top + bounds.height / 2,
		);
		return hit === target || target.contains(hit);
	}, selector);
}

async function clickAfterHitTest(page, locator, selector) {
	await waitForHitTestTarget(page, selector);
	await locator.click();
}

async function waitForCollapsedLayout(page) {
	noteOperation("wait for collapsed Agent layout");
	await page.waitForFunction(() => {
		const shell = document.querySelector(".ai-browser-app");
		const viewport = document.querySelector("#browser-viewport");
		const agent = document.querySelector(".agent-sidebar");
		if (!shell || !viewport || !agent) return false;
		return (
			shell.classList.contains("agent-sidebar-collapsed") &&
			!shell.classList.contains("agent-sidebar-settling") &&
			Math.abs(agent.getBoundingClientRect().width) <= 1 &&
			Math.abs(viewport.getBoundingClientRect().right - innerWidth) <= 1
		);
	});
}

async function waitForOpenAgentLayout(page, expectedWidth = null) {
	noteOperation("wait for open Agent layout", expectedWidth);
	await page.waitForFunction(
		(target) => {
			const shell = document.querySelector(".ai-browser-app");
			const agent = document.querySelector(".agent-sidebar");
			const width = agent?.getBoundingClientRect().width ?? 0;
			return (
				shell &&
				agent &&
				!shell.classList.contains("agent-sidebar-collapsed") &&
				!shell.classList.contains("agent-sidebar-settling") &&
				width > 0 &&
				(target === null || Math.abs(width - target) <= 1)
			);
		},
		expectedWidth,
	);
}

async function assertTaskSettingsAtCurrentWidth(page) {
	noteOperation("measure Task settings", runtimeDiagnostics.lastBreakpoint);
	await waitForOpenAgentLayout(page);
	assertResponsiveAgentPanelWidth(await readLayout(page));
	const details = page.locator(".agent-conversation-host .task-settings");
	await details.waitFor();
	await details.evaluate((element) => element.removeAttribute("open"));
	await clickAfterHitTest(
		page,
		page.locator(".kestrel-home-model-selector"),
		".kestrel-home-model-selector",
	);
	await page
		.locator('.agent-conversation-host .task-settings[open] .task-settings-panel')
		.waitFor();
	assertTaskSettingsLayout(await readTaskSettingsLayout(page));
	await details.evaluate((element) => element.removeAttribute("open"));
}

async function readZoomReflow(page) {
	return page.evaluate(() => {
		const root = document.documentElement;
		const body = document.body;
		const shell = document.querySelector(".ai-browser-app");
		const viewport = document.querySelector("#browser-viewport");
		if (!shell || !viewport) {
			throw new Error("The Kestrel browser layout is unavailable.");
		}

		const readControl = (selector) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`Missing ${selector}.`);
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				selector,
				display: style.display,
				visibility: style.visibility,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				width: rect.width,
				height: rect.height,
			};
		};
		const agentToggleLabel = document.querySelector(
			".browser-agent-toggle > span:not(.pragmatic-logo)",
		);
		const navigationControl = document.querySelector(".kestrel-sidebar-new-task");

		return {
			innerWidth,
			innerHeight,
			rootOverflow: root.scrollWidth - root.clientWidth,
			bodyOverflow: body.scrollWidth - body.clientWidth,
			shellOverflow: shell.scrollWidth - shell.clientWidth,
			viewportOverflow: viewport.scrollWidth - viewport.clientWidth,
			secondaryToolbarDisplays: Array.from(
				document.querySelectorAll(".browser-toolbar-secondary"),
			).map((element) => getComputedStyle(element).display),
			overflowingElements: Array.from(shell.querySelectorAll("*"))
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return {
						tag: element.tagName.toLowerCase(),
						className:
							typeof element.className === "string" ? element.className : "",
						left: rect.left,
						right: rect.right,
						clientWidth: element.clientWidth,
						scrollWidth: element.scrollWidth,
					};
				})
				.filter(
					(element) =>
						element.left < -1 ||
						element.right > innerWidth + 1 ||
						element.scrollWidth > element.clientWidth + 1,
				)
				.slice(0, 12),
			sidebarLabelDisplay: document.querySelector(".kestrel-sidebar-nav-item span")
				? getComputedStyle(
					document.querySelector(".kestrel-sidebar-nav-item span"),
				).display
				: "none",
			agentToggleLabelDisplay: agentToggleLabel
				? getComputedStyle(agentToggleLabel).display
				: "none",
			controls: [
				navigationControl ? readControl(".kestrel-sidebar-new-task") : null,
				readControl(".browser-new-tab"),
				readControl("#browser-address-input"),
				readControl(
					'.browser-toolbar-actions button[aria-label="Browser menu"]',
				),
				readControl(".browser-agent-toggle"),
			].filter(Boolean),
		};
	});
}

function assertZoomReflow(layout, reflow, navigationWidth = 56) {
	assert.ok(
		reflow.innerWidth <= 700,
		`Expected a compact CSS viewport at 200% zoom, got ${reflow.innerWidth}px.`,
	);
	assertNear(layout.navigation.width, navigationWidth, "zoomed navigation width");
	assertNear(
		layout.main.left,
		0,
		"zoomed browser plane starts at the window edge",
	);
	assertNear(
		layout.main.right,
		layout.innerWidth,
		"zoomed browser reaches the window edge",
	);
	assert.ok(
		layout.viewport.left >= layout.navigation.right - 1,
		"zoomed page viewport overlaps the compact navigation rail",
	);
	assertNear(
		layout.viewport.right,
		layout.innerWidth,
		"zoomed page viewport reaches the window edge",
	);
	assertNear(layout.agent.width, 0, "zoomed collapsed Pragmatic width");
	assert.equal(reflow.sidebarLabelDisplay, "none");
	assert.equal(reflow.agentToggleLabelDisplay, "none");
	assert.ok(
		reflow.secondaryToolbarDisplays.length >= 3 &&
		reflow.secondaryToolbarDisplays.every((display) => display === "none"),
		"High zoom must hide direct toolbar shortcuts before primary controls overflow.",
	);
	for (const [surface, overflow] of Object.entries({
		document: reflow.rootOverflow,
		body: reflow.bodyOverflow,
		shell: reflow.shellOverflow,
		viewport: reflow.viewportOverflow,
	})) {
		assert.ok(
			overflow <= 1,
			`The zoomed ${surface} overflowed horizontally by ${overflow}px: ${JSON.stringify(reflow.overflowingElements)}.`,
		);
	}
	for (const control of reflow.controls) {
		assert.notEqual(control.display, "none", `${control.selector} was hidden.`);
		assert.notEqual(
			control.visibility,
			"hidden",
			`${control.selector} was invisible.`,
		);
		assert.ok(
			control.width > 0 && control.height > 0,
			`${control.selector} had no visible size.`,
		);
		assert.ok(
			control.left >= -1 && control.right <= reflow.innerWidth + 1,
			`${control.selector} escaped the horizontal viewport (${control.left}, ${control.right}).`,
		);
		assert.ok(
			control.top >= -1 && control.bottom <= reflow.innerHeight + 1,
			`${control.selector} escaped the vertical viewport (${control.top}, ${control.bottom}).`,
		);
	}
	assertTheme(layout);
}

function assertInTabAgentLayout(layout) {
	assert.doesNotMatch(layout.classes, /agent-full-page/);
	assert.match(layout.classes, /agent-sidebar-collapsed/);
	const navigationWidth = expectedNavigationWidth(layout.innerWidth);
	assertNear(layout.navigation.width, navigationWidth, "in-tab Agent navigation width");
	assertNear(
		layout.main.left,
		0,
		"in-tab Agent browser plane starts at the window edge",
	);
	assertNear(
		layout.main.right,
		layout.innerWidth,
		"in-tab Agent browser plane reaches the window edge",
	);
	assertNear(
		layout.viewport.left,
		navigationWidth,
		"in-tab Agent page viewport starts after the navigation rail",
	);
	assertNear(
		layout.viewport.right,
		layout.innerWidth,
		"in-tab Agent page viewport reaches the window edge",
	);
	assertNear(layout.agent.width, 0, "in-tab Agent collapsed Pragmatic width");
	assertTheme(layout);
}

async function assertWindowControlMotion(page, application) {
	const control = page.locator(".window-control-close");
	await control.waitFor();
	await page.bringToFront();
	await page.waitForFunction(
		() =>
			!document
				.querySelector(".window-controls")
				?.classList.contains("window-controls-inactive"),
	);
	await page.evaluate(
		() =>
			new Promise((resolveFrame) =>
				requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
			),
	);
	const box = await control.boundingBox();
	assert.ok(box, "The close window control has no visible bounds.");
	const appearance = await page.locator(".window-control").evaluateAll((elements) =>
		elements.map((element) => {
			const style = getComputedStyle(element);
			return {
				fill: style.getPropertyValue("--window-control-fill").trim(),
				iconColor: style.getPropertyValue("--window-control-icon-color").trim(),
			};
		}),
	);
	assert.deepEqual(appearance, [
		{ fill: "#f45146", iconColor: "#8c0000" },
		{ fill: "#fcb600", iconColor: "#a63a00" },
		{ fill: "#00bc00", iconColor: "#2e7300" },
	]);

	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.isDestroyed() && candidate.isVisible(),
		);
		if (!window) throw new Error("The Kestrel window is unavailable.");
		window.blur();
	});
	await page.waitForFunction(() =>
		document
			.querySelector(".window-controls")
			?.classList.contains("window-controls-inactive"),
	);
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.isDestroyed() && candidate.isVisible(),
		);
		if (!window) throw new Error("The Kestrel window is unavailable.");
		window.focus();
	});
	await page.waitForFunction(
		() =>
			!document
				.querySelector(".window-controls")
				?.classList.contains("window-controls-inactive"),
	);

	const readMotion = () =>
		control.evaluate((element) => {
			const style = getComputedStyle(element);
			const triangle = element.querySelector(".window-control-triangle");
			const shade = element.querySelector(".window-control-shade");
			return {
				tilt: Number.parseFloat(
					style.getPropertyValue("--window-control-tilt"),
				),
				triangleX: Number.parseFloat(
					style.getPropertyValue("--window-control-triangle-x"),
				),
				fillShade: Number.parseFloat(
					style.getPropertyValue("--window-control-fill-shade"),
				),
				triangleTransform: triangle
					? getComputedStyle(triangle).transform
					: "missing",
				shadeOpacity: shade ? Number.parseFloat(getComputedStyle(shade).opacity) : -1,
			};
			});
	const sample = async (x, y, ready) => {
		let motion = await readMotion();
		for (let attempt = 0; attempt < 8 && !ready(motion); attempt += 1) {
			// Target the actual no-drag button instead of the titlebar coordinate. The
			// one-pixel nudge prevents Chromium from coalescing a repeated hover after
			// a focus or reduced-motion change.
			const nudgeX = x <= box.width / 2 ? x + 1 : x - 1;
			await control.hover({ position: { x: nudgeX, y } });
			await control.hover({ position: { x, y } });
			await page.evaluate(
				() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)),
			);
			motion = await readMotion();
		}
		return motion;
	};

	const center = await sample(
		box.width / 2,
		box.height / 2,
		(motion) => motion.fillShade >= 0.1 && motion.shadeOpacity >= 0.08,
	);
	assert.ok(
		center.fillShade >= 0.1 && center.shadeOpacity >= 0.08,
		`The focused window did not activate control motion (${JSON.stringify(center)}).`,
	);
	const left = await sample(
		1,
		box.height / 2,
		(motion) => motion.tilt < 0,
	);
	const right = await sample(
		box.width - 1,
		box.height / 2,
		(motion) => motion.tilt > 0,
	);
	assert.ok(left.tilt < 0, `Expected a left tilt, got ${left.tilt}.`);
	assert.ok(right.tilt > 0, `Expected a right tilt, got ${right.tilt}.`);
	assert.ok(
		left.triangleX < right.triangleX,
		`Pointer travel did not update the triangle position (${left.triangleX}, ${right.triangleX}).`,
	);
	assert.ok(
		right.fillShade >= 0.1 && right.shadeOpacity >= 0.08,
		`The hovered triangle did not deepen (${right.fillShade}, ${right.shadeOpacity}).`,
	);

	await control.hover({ position: { x: box.width / 2, y: box.height / 2 } });
	await page.emulateMedia({ reducedMotion: "reduce" });
	const reduced = await sample(
		box.width / 2,
		box.height / 2,
		(motion) => motion.shadeOpacity >= 0.08,
	);
	assert.equal(
		reduced.triangleTransform,
		"none",
		"Reduced motion must remove cursor-following travel.",
	);
	assert.ok(
		reduced.shadeOpacity >= 0.08,
		`Reduced motion must retain the darker hover cue (${JSON.stringify(reduced)}).`,
	);
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await control.hover({ position: { x: box.width / 2, y: box.height / 2 } });
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
	noteOperation("application launched");
	observeApplicationProcess();
	page = await application.firstWindow();
	await page.addInitScript(() => {
		window.addEventListener("unhandledrejection", (event) => {
			const reason = event.reason;
			const message =
				reason instanceof Error ? reason.stack ?? reason.message : String(reason);
			const existing = window.__kestrelDesktopLayoutUnhandledRejections ?? [];
			window.__kestrelDesktopLayoutUnhandledRejections = [
				...existing,
				message,
			].slice(-20);
		});
	});
	page.on("close", () => {
		runtimeDiagnostics.pageClosed = true;
		runtimeDiagnostics.lastOperation = "page closed";
	});
	page.on("crash", () => {
		runtimeDiagnostics.pageCrashed = true;
		runtimeDiagnostics.lastOperation = "page crashed";
	});
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.waitForFunction(() => typeof window.kestrel?.request === "function");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "open");
		localStorage.setItem("kestrel:agent-sidebar", "collapsed");
		localStorage.setItem("kestrel:agent-universe-rail", "collapsed");
	});
	await page.reload();
	await page.locator(".new-tab-page").waitFor();
	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	await waitForOpenAgentLayout(
		page,
		expectedAgentPanelWidth(await page.evaluate(() => innerWidth)),
	);
	const homeTaskSettings = page.locator(".kestrel-home-model-selector");
	await homeTaskSettings.waitFor();
	await assertTaskSettingsAtCurrentWidth(page);
	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	await waitForCollapsedLayout(page);
	await assertWindowControlMotion(page, application);
	await waitForCollapsedLayout(page);
	await assertMotionContract(page);
	await assertReducedMotionStyles(page);
	await assertAgentRailInterruption(page);
	const newTabControl = await revealNewTabControl(page);
	await assertNewTabHoverAffordance(page);
	await newTabControl.click();
	await page.waitForFunction(
		() => document.querySelectorAll(".browser-tabs .browser-tab").length >= 2,
	);
	await assertTabDragMotion(page);
	await assertVerticalTabLayout(page);

	await waitForCollapsedLayout(page);
	assertCollapsedLayout(await readLayout(page));
	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	const openAgentWidth = expectedAgentPanelWidth(
		await page.evaluate(() => innerWidth),
	);
	await waitForOpenAgentLayout(page, openAgentWidth);
	assertOpenLayout(await readLayout(page));

	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	await waitForCollapsedLayout(page);
	assertCollapsedLayout(await readLayout(page));

	// Opening Agent from the navigation rail should stay in the browser tab
	// surface like New Tab, with browser chrome visible and the chat rail optional.
	await (await revealNewTabControl(page)).click();
	await page.locator(".new-tab-page").waitFor();

	// Exercise the composer at every supported non-compact rail breakpoint.
	// The rail must finish its spring before the controls are measured; otherwise
	// a transient narrow frame can wrap the context group and create a false
	// packaged-layout failure.
	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	await waitForOpenAgentLayout(
		page,
		expectedAgentPanelWidth(await page.evaluate(() => innerWidth)),
	);
	for (const width of [920, 979, 980, 981, 1119, 1120, 1121, 1280, 1440]) {
		await setDesktopWindowWidth(application, page, width);
		await waitForOpenAgentLayout(page);
		await assertTaskSettingsAtCurrentWidth(page);
	}
	await clickAfterHitTest(
		page,
		page.locator("#browser-agent-toggle"),
		"#browser-agent-toggle",
	);
	await waitForCollapsedLayout(page);

	await openKestrelDestination(page, "Agent");
	await page.waitForFunction(() => {
		const shell = document.querySelector(".ai-browser-app");
		const workspace = document.querySelector("#browser-viewport .agent-workspace");
		const browserPlane = document.querySelector(".browser-main-plane");
		const tabRow = document.querySelector(".browser-tab-row-horizontal");
		return (
			shell &&
			!shell.classList.contains("agent-full-page") &&
			shell.classList.contains("agent-sidebar-collapsed") &&
			browserPlane &&
			getComputedStyle(browserPlane).display !== "none" &&
			tabRow &&
			workspace
		);
	});
	await page.locator("#agent-workspace-title").waitFor();

	await setDesktopWindowWidth(application, page, 920);
	await waitForCollapsedLayout(page);
	assertInTabAgentLayout(await readLayout(page));
	const baselineViewportWidth = await page.evaluate(() => innerWidth);
	await setDesktopZoom(application, page, 2, baselineViewportWidth / 2);
	await waitForCollapsedLayout(page);
	await page.waitForFunction(() => {
		const viewport = document.querySelector("#browser-viewport");
		return viewport && Math.abs(viewport.getBoundingClientRect().right - innerWidth) <= 1;
	});
	assertZoomReflow(await readLayout(page), await readZoomReflow(page), 56);
	await setDesktopZoom(application, page, 1, baselineViewportWidth);
	await waitForCollapsedLayout(page);
	await page.waitForFunction(() => {
		const viewport = document.querySelector("#browser-viewport");
		return viewport && Math.abs(viewport.getBoundingClientRect().right - innerWidth) <= 1;
	});
	assertInTabAgentLayout(await readLayout(page));

	assert.deepEqual(pageErrors, []);
	assert.deepEqual(await readUnhandledRejections(page), []);
	process.stdout.write(
		"Desktop layout smoke passed: startup guard, graphite theme, traffic-control motion, preload bridge, global navigation, browser plane, open/collapsed Pragmatic geometry, in-tab Agent route, and minimum-width 200% zoom reflow.\n",
	);
} catch (error) {
	const evidence = await captureFailureEvidence(error);
	process.stderr.write(
		`Desktop layout failure evidence: ${evidence.diagnosticsPath}${evidence.screenshotPath ? `; ${evidence.screenshotPath}` : ""}\n`,
	);
	throw error;
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
