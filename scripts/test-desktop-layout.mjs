import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const mainBundle = readFileSync(resolve("apps/desktop/out/main/index.js"), "utf8");
assert.match(
	mainBundle,
	/installMacFileIconCrashGuard\s*\(\s*app\s*\)/,
	"The packaged main process must install the macOS file-icon crash guard.",
);

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
const mainBundle = readFileSync(
	resolve("apps/desktop/out/main/index.js"),
	"utf8",
);

assert.doesNotMatch(
	mainBundle,
	/getFileIcon\s*\(\s*process\.execPath/,
	"The packaged startup path must not ask Electron to resolve its own executable icon.",
);

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

async function setDesktopZoom(application, page, zoomFactor) {
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
		(expectedCompact) =>
			expectedCompact ? innerWidth <= 700 : innerWidth >= 1_200,
		zoomFactor > 1,
	);
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

		return {
			innerWidth,
			innerHeight,
			rootOverflow: root.scrollWidth - root.clientWidth,
			bodyOverflow: body.scrollWidth - body.clientWidth,
			shellOverflow: shell.scrollWidth - shell.clientWidth,
			viewportOverflow: viewport.scrollWidth - viewport.clientWidth,
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
			sidebarLabelDisplay: getComputedStyle(
				document.querySelector(".kestrel-sidebar-nav-item span"),
			).display,
			agentToggleLabelDisplay: getComputedStyle(
				document.querySelector(
					".browser-agent-toggle > span:not(.pragmatic-logo)",
				),
			).display,
			controls: [
				readControl(".kestrel-sidebar-new-task"),
				readControl(".browser-new-tab"),
				readControl("#browser-address-input"),
				readControl(".browser-agent-toggle"),
			],
		};
	});
}

function assertZoomReflow(layout, reflow) {
	assert.ok(
		reflow.innerWidth <= 700,
		`Expected a compact CSS viewport at 200% zoom, got ${reflow.innerWidth}px.`,
	);
	assertNear(layout.navigation.width, 56, "zoomed navigation width");
	assertNear(
		layout.main.left,
		layout.navigation.right,
		"zoomed browser starts after compact navigation",
	);
	assertNear(
		layout.main.right,
		layout.innerWidth,
		"zoomed browser reaches the window edge",
	);
	assertNear(
		layout.viewport.right,
		layout.innerWidth,
		"zoomed page viewport reaches the window edge",
	);
	assertNear(layout.agent.width, 0, "zoomed collapsed Pragmatic width");
	assert.equal(reflow.sidebarLabelDisplay, "none");
	assert.equal(reflow.agentToggleLabelDisplay, "none");
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

async function assertWindowControlMotion(page) {
	const control = page.locator(".window-control-close");
	await control.waitFor();
	await page.bringToFront();
	const box = await control.boundingBox();
	assert.ok(box, "The close window control has no visible bounds.");

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
		await page.mouse.move(x, y, { steps: 4 });
		let motion = await readMotion();
		for (let attempt = 0; attempt < 20 && !ready(motion); attempt += 1) {
			await page.waitForTimeout(25);
			motion = await readMotion();
		}
		return motion;
	};

	await page.mouse.move(box.x + 140, box.y + 140);
	const left = await sample(
		box.x + 5,
		box.y + box.height / 2,
		(motion) => motion.tilt < 0,
	);
	const right = await sample(
		box.x + box.width - 5,
		box.y + box.height / 2,
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

	await page.mouse.move(box.x + 140, box.y + 140);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const reduced = await sample(
		box.x + box.width / 2,
		box.y + box.height / 2,
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
	await page.mouse.move(box.x + 140, box.y + 140);
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
	await assertWindowControlMotion(page);

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

	await setDesktopZoom(application, page, 2);
	assertZoomReflow(await readLayout(page), await readZoomReflow(page));
	await setDesktopZoom(application, page, 1);
	assertCollapsedLayout(await readLayout(page));

	assert.deepEqual(pageErrors, []);
	process.stdout.write(
		"Desktop layout smoke passed: startup guard, graphite theme, traffic-control motion, preload bridge, global navigation, browser plane, open/collapsed Pragmatic geometry, and 200% zoom reflow.\n",
	);
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
