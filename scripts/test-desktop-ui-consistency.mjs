import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { _electron as electron } from "@playwright/test";
const temporary = mkdtempSync(join(tmpdir(), "kestrel-consistency-"));
const output = resolve(
	process.env.KESTREL_UI_EVIDENCE || ".tmp/ui-consistency",
);
mkdirSync(output, { recursive: true });
const require = createRequire(resolve("apps/desktop/package.json"));
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const report = { routes: [], errors: [], checks: [], settings: [] };
let app;
const server = createServer((_request, response) => {
	response.setHeader("Content-Type", "text/html");
	response.end(
		"<!doctype html><title>Find fixture</title><main><h1>Find fixture</h1><p>needle needle needle</p></main>",
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
try {
	app = await electron.launch({
		executablePath: executable || require("electron"),
		args: executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: join(temporary, "profile"),
			KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
			KESTREL_REAL_USER_PROFILE: "1",
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
		},
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	page.on("pageerror", (e) => report.errors.push(e.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	const session = await page.evaluate(async () => {
		const r = await window.kestrel.request({
			type: "runtime-create-session",
			title:
				"A long synthetic conversation title for checking sidebar fading and layout",
			kind: "conversation",
		});
		if (!r.ok || !r.session) throw new Error("Fixture creation failed");
		return r.session.id;
	});
	await page.reload();
	await page.locator("#new-tab-title").waitFor();
	async function size(width, height) {
		await app.evaluate(
			({ BrowserWindow }, { width, height }) => {
				const w = BrowserWindow.getAllWindows().find(
					(w) => !/[?&](petOverlay|findPopover)=/.test(w.webContents.getURL()),
				);
				w.setMinimumSize(400, 400);
				w.setSize(width, height);
				w.show();
				w.focus();
			},
			{ width, height },
		);
	}
	async function route(id) {
		await page.evaluate(
			async (input) => {
				const r = await window.kestrel.request({
					type: "browser-create-tab",
					input,
					active: true,
				});
				if (!r.ok) throw new Error(r.error);
			},
			id ? `kestrel://${id}` : "",
		);
		await page.waitForTimeout(350);
	}
	async function capture(name) {
		await page.screenshot({
			path: join(output, `${name}.png`),
			animations: "disabled",
		});
	}
	for (const [width, height] of process.env.KESTREL_UI_FOCUSED
		? []
		: [
				[1440, 1000],
				[760, 760],
			]) {
		await size(width, height);
		for (const id of [
			"",
			"memory",
			`memory?scope=${session}`,
			"connections",
			"agent",
			"projects",
			"writing",
			"history",
			"bookmarks",
			"downloads",
			"readiness",
			"approvals",
			"research",
			"artifacts",
			"work",
			"events",
			"activity",
			"extensions",
			"settings",
			"commands",
		]) {
			await route(id);
			const name = id.includes("scope=") ? "scoped-memory" : id || "home";
			if (name === "scoped-memory")
				await page
					.getByRole("button", { name: "Sources", exact: true })
					.click();
			await capture(`${width}-${name}`);
			if (name === "scoped-memory") {
				assert.equal(
					await page.getByLabel("Memory scope", { exact: true }).inputValue(),
					session,
				);
				assert(
					await page.getByLabel("Memory source", { exact: true }).isDisabled(),
				);
			}

			const metrics = await page.evaluate(() => ({
				overflow: document.documentElement.scrollWidth > innerWidth + 1,
				headings: [...document.querySelectorAll("h1")]
					.filter((n) => n.getBoundingClientRect().width)
					.map((n) => n.textContent),
				overlaps: [...document.querySelectorAll(".life-switcher")].flatMap(
					(n) => {
						const prev = n.previousElementSibling;
						if (!prev) return [];
						const a = prev.getBoundingClientRect(),
							b = n.getBoundingClientRect();
						return a.bottom > b.top + 1
							? [{ previous: prev.className, overlap: a.bottom - b.top }]
							: [];
					},
				),
			}));
			report.routes.push({ width, name, ...metrics });
			assert.equal(
				metrics.overflow,
				false,
				`${width} ${name} must fit the window`,
			);
			assert.equal(
				metrics.overlaps.length,
				0,
				`${width} ${name} navigation must not overlap fields`,
			);
			console.log(width, name, JSON.stringify(metrics));
			if (name === "settings" && width === 760) {
				for (const scope of ["Browser", "Agent"]) {
					await page
						.getByLabel("Settings category", { exact: true })
						.getByRole("tab", { name: scope, exact: true })
						.click();
					const picker = page.getByLabel(`${scope} settings section`, {
						exact: true,
					});
					const options = await picker
						.locator("option")
						.evaluateAll((nodes) =>
							nodes.map((n) => ({ value: n.value, label: n.textContent })),
						);
					for (const option of options) {
						await picker.selectOption(option.value);
						await page.waitForTimeout(100);
						const overflow = await page
							.locator(".settings-content")
							.evaluate((n) => n.scrollWidth > n.clientWidth + 1);
						assert.equal(overflow, false, `${option.value} must fit`);
						await capture(`settings-${option.value}`);
						report.settings.push({ scope, ...option, overflow });
					}
				}
			}
		}
	}
	await size(1440, 1000);
	await route("");
	await page.emulateMedia({ reducedMotion: "reduce" });
	const center = await page.locator("#new-tab-chat-input").evaluate((n) => {
		const r = n.getBoundingClientRect(),
			c = n.closest(".kestrel-home-composer").getBoundingClientRect(),
			s = getComputedStyle(n);
		return Math.abs(
			r.top +
				parseFloat(s.paddingTop) +
				parseFloat(s.lineHeight) / 2 -
				(c.top + c.height / 2),
		);
	});
	assert(
		center <= 1,
		`Compact composer line must be centered, delta=${center}`,
	);
	const titleStyle = await page
		.locator(".kestrel-sidebar-title")
		.first()
		.evaluate((n) => ({
			overflow: getComputedStyle(n).textOverflow,
			mask: getComputedStyle(n).maskImage,
		}));
	assert.equal(titleStyle.overflow, "clip");
	assert(titleStyle.mask.includes("linear-gradient"));
	const borders = await page
		.locator(".kestrel-widget-card")
		.evaluateAll((nodes) =>
			nodes.map((n) => {
				const s = getComputedStyle(n);
				return {
					widths: [
						s.borderTopWidth,
						s.borderRightWidth,
						s.borderBottomWidth,
						s.borderLeftWidth,
					],
					shadow: s.boxShadow,
				};
			}),
		);
	assert(
		borders.every(
			(b) => b.widths.every((w) => w === "1px") && !b.shadow.includes("inset"),
		),
		"Widgets need a single even rim",
	);
	async function openPopover() {
		const popupPromise = app.waitForEvent("window");
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()
				.find(
					(w) => !/[?&](petOverlay|findPopover)=/.test(w.webContents.getURL()),
				)
				.webContents.send("kestrel:browser-command", "find-in-page"),
		);
		const popup = await popupPromise;
		await popup
			.getByRole("textbox", { name: "Find in page", exact: true })
			.waitFor();
		return popup;
	}
	for (const tabLayout of ["horizontal", "vertical"]) {
		await page.evaluate(async (tabLayout) => {
			const s = await window.kestrel.request({ type: "browser-get-state" });
			await window.kestrel.request({
				type: "browser-update-settings",
				settings: { ...s.browserState.settings, tabLayout },
			});
		}, tabLayout);
		await page.waitForTimeout(350);
		const before = await page.locator(".browser-viewport").boundingBox();
		const popup = await openPopover();
		assert.deepEqual(
			await page.locator(".browser-viewport").boundingBox(),
			before,
			"Find must not move or resize page content",
		);
		const bounds = await app.evaluate(({ BrowserWindow }) => {
			const w = BrowserWindow.getAllWindows().find((w) =>
				w.webContents.getURL().includes("findPopover=1"),
			);
			return {
				bounds: w.getBounds(),
				parent: w.getParentWindow()?.getContentBounds(),
			};
		});
		assert(bounds.bounds.width <= 360 && bounds.bounds.height === 48);
		assert(bounds.bounds.y >= bounds.parent.y + before.y);
		assert.equal(await page.locator(".browser-find-bar").count(), 0);
		await popup.screenshot({ path: join(output, `find-${tabLayout}.png`) });
		const closed = popup.waitForEvent("close");
		await popup.keyboard.press("Escape").catch((error) => {
			if (!popup.isClosed()) throw error;
		});
		await closed;
		report.checks.push({ tabLayout, bounds, viewportUnchanged: true });
	}
	await page.evaluate(async () => {
		const s = await window.kestrel.request({ type: "browser-get-state" });
		await window.kestrel.request({
			type: "browser-update-settings",
			settings: {
				...s.browserState.settings,
				tabLayout: "horizontal",
				newTabBackground: "mountains",
			},
		});
	});
	await capture("home-wallpaper");
	await page.evaluate(async (input) => {
		const r = await window.kestrel.request({
			type: "browser-create-tab",
			input,
			active: true,
		});
		if (!r.ok) throw new Error(r.error);
	}, fixtureUrl);
	await page.waitForFunction(async () => {
		const r = await window.kestrel.request({ type: "browser-get-state" });
		const t = r.browserState?.tabs.find(
			(t) => t.id === r.browserState.activeTabId,
		);
		return t?.title === "Find fixture" && !t.loading;
	});
	const nativeBounds = () =>
		app.evaluate(({ BrowserWindow }, url) => {
			const w = BrowserWindow.getAllWindows().find(
				(w) => !/[?&](petOverlay|findPopover)=/.test(w.webContents.getURL()),
			);
			return w.contentView.children
				.filter((v) => v.webContents?.getURL().startsWith(url))
				.map((v) => ({ bounds: v.getBounds(), visible: v.getVisible() }));
		}, fixtureUrl);
	const beforeNative = await nativeBounds();
	const popup = await openPopover();
	const input = popup.getByRole("textbox", {
		name: "Find in page",
		exact: true,
	});
	await input.fill("needle");
	await popup.locator("output").filter({ hasText: "1/3" }).waitFor();
	assert.deepEqual(
		await nativeBounds(),
		beforeNative,
		"Native page must remain visible at unchanged bounds",
	);
	assert(beforeNative.length && beforeNative.every((v) => v.visible));
	await popup.getByRole("button", { name: "Next match", exact: true }).click();
	await popup.locator("output").filter({ hasText: "2/3" }).waitFor();
	await input.press("Shift+Enter");
	await popup.locator("output").filter({ hasText: "1/3" }).waitFor();
	await popup.screenshot({ path: join(output, "native-find.png") });
	await size(760, 760);
	await page.waitForTimeout(400);
	const compact = await app.evaluate(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows().find((w) =>
			w.webContents.getURL().includes("findPopover=1"),
		);
		return {
			bounds: w.getBounds(),
			parent: w.getParentWindow().getContentBounds(),
		};
	});
	assert(
		compact.bounds.x >= compact.parent.x &&
			compact.bounds.x + compact.bounds.width <=
				compact.parent.x + compact.parent.width,
	);
	await popup.screenshot({ path: join(output, "native-find-compact.png") });
	const restricted = await popup.evaluate(async () => {
		try {
			await window.kestrel.request({ type: "browser-get-state" });
			return false;
		} catch {
			return true;
		}
	});
	assert(restricted, "Popover must not access general browser IPC");
	await input.press("Meta+f");
	assert.equal(
		await input.evaluate((n) => n.selectionEnd - n.selectionStart),
		"needle".length,
		"Cmd+F reselects the current query",
	);
	const otherTabRejected = await popup.evaluate(async () => {
		try {
			await window.kestrel.request({
				type: "browser-find-in-page",
				tabId: "tab-00000000-0000-0000-0000-000000000000",
				query: "test",
			});
			return false;
		} catch {
			return true;
		}
	});
	assert(otherTabRejected, "Popover cannot search a different tab");
	await input.fill("no-match-fixture");
	await popup.locator("output").filter({ hasText: "0/0" }).waitFor();
	assert(
		await popup
			.getByRole("button", { name: "Next match", exact: true })
			.isDisabled(),
	);
	const closed = popup.waitForEvent("close");
	await popup
		.getByRole("button", { name: "Close find", exact: true })
		.click()
		.catch((error) => {
			if (!popup.isClosed()) throw error;
		});
	await closed;
	const second = await openPopover();
	const switched = second.waitForEvent("close");
	await route("");
	await switched;
	report.checks.push({
		nativeBounds: beforeNative,
		matches: 3,
		nextPrevious: true,
		noPageReflow: true,
		ipcRestricted: true,
		closeOnTabSwitch: true,
	});
	await size(1440, 1000);
	await route("");
	await page.locator("#new-tab-chat-input").focus();
	await capture("composer-expanded");
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find(
				(w) => !/[?&](petOverlay|findPopover)=/.test(w.webContents.getURL()),
			)
			.webContents.setZoomFactor(2),
	);
	await route(`memory?scope=${session}`);
	await page.getByRole("button", { name: "Sources", exact: true }).click();
	await capture("memory-200-percent");
	assert.equal(
		await page
			.locator(".source-memory-view")
			.evaluate((n) => n.scrollWidth > n.clientWidth + 1),
		false,
	);
	assert.deepEqual(report.errors, []);
	report.checks.push({
		center,
		titleStyle,
		borders,
		zoom: 2,
		reducedMotion: true,
	});
	writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
	console.log(
		"UI consistency audit passed",
		report.routes.length,
		"route/viewport combinations",
	);
} catch (error) {
	const page = app ? await app.firstWindow() : null;
	console.log(
		"FIND",
		await page
			?.locator(".browser-find-bar")
			.textContent()
			.catch(() => "missing"),
	);
	await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
	throw error;
} finally {
	await app?.close();
	rmSync(temporary, { recursive: true, force: true });
	await new Promise((resolve) => server.close(resolve));
}
