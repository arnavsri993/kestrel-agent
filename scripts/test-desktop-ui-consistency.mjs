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
					(w) => !w.webContents.getURL().includes("petOverlay"),
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
	for (const tabLayout of ["horizontal", "vertical"]) {
		await page.evaluate(async (tabLayout) => {
			const s = await window.kestrel.request({ type: "browser-get-state" });
			const r = await window.kestrel.request({
				type: "browser-update-settings",
				settings: { ...s.browserState.settings, tabLayout },
			});
			if (!r.ok) throw new Error(r.error);
		}, tabLayout);
		await page.locator("#new-tab-title").click();
		await page.keyboard.press("Meta+f");
		await page.locator("#browser-find-input").waitFor();
		await page.waitForTimeout(100);
		const fieldStyle = await page
			.locator("#browser-find-input")
			.evaluate((n) => {
				const s = getComputedStyle(n);
				return {
					height: s.height,
					minHeight: s.minHeight,
					shadow: s.boxShadow,
				};
			});
		assert.equal(fieldStyle.height, "28px");
		assert.equal(fieldStyle.minHeight, "28px");
		assert.equal(
			fieldStyle.shadow,
			"none",
			"Find uses a single outline, not stacked focus rings",
		);
		const geometry = await page.evaluate(() => {
			const f = document
					.querySelector(".browser-find-bar")
					.getBoundingClientRect(),
				v = document.querySelector(".browser-viewport").getBoundingClientRect(),
				t = document.querySelector(".browser-toolbar").getBoundingClientRect();
			return {
				find: { x: f.x, y: f.y, right: f.right, bottom: f.bottom },
				viewport: { x: v.x, y: v.y, right: v.right },
				toolbarBottom: t.bottom,
			};
		});
		assert(
			geometry.find.y >= geometry.toolbarBottom,
			`${tabLayout}: Find must be below toolbar`,
		);
		assert(
			geometry.viewport.y >= geometry.find.bottom - 1,
			`${tabLayout}: native viewport must clear Find`,
		);
		assert(
			Math.abs(geometry.find.x - geometry.viewport.x) < 1,
			`${tabLayout}: Find must align with content`,
		);
		await page.getByLabel("Find in page", { exact: true }).fill("fixture");
		await capture(`find-${tabLayout}`);
		await page.keyboard.press("Escape");
		await page.locator(".browser-find-bar").waitFor({ state: "detached" });
		await page.keyboard.press("Escape");
		report.checks.push({ tabLayout, geometry });
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
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find((w) => !w.webContents.getURL().includes("petOverlay"))
			.webContents.send("kestrel:browser-command", "find-in-page"),
	);
	await page.getByLabel("Find in page", { exact: true }).fill("needle");
	await page
		.locator(".browser-find-bar > span")
		.filter({ hasText: /of 3$/ })
		.waitFor();
	const native = await app.evaluate(({ BrowserWindow }, url) => {
		const w = BrowserWindow.getAllWindows().find(
			(w) => !w.webContents.getURL().includes("petOverlay"),
		);
		return w.contentView.children
			.filter((v) => v.webContents?.getURL().startsWith(url))
			.map((v) => v.getBounds());
	}, fixtureUrl);
	const findBottom = await page
		.locator(".browser-find-bar")
		.evaluate((n) => n.getBoundingClientRect().bottom);
	assert(
		native.length && native.every((r) => r.y >= findBottom - 1),
		"Native page must start below Find controls",
	);
	await capture("native-find");
	await page
		.locator(".browser-find-bar > span")
		.filter({ hasText: "1 of 3" })
		.waitFor();
	await page.getByRole("button", { name: "Next match", exact: true }).click();
	await page
		.locator(".browser-find-bar > span")
		.filter({ hasText: "2 of 3" })
		.waitFor();
	await page
		.getByRole("button", { name: "Previous match", exact: true })
		.click();
	await page
		.locator(".browser-find-bar > span")
		.filter({ hasText: "1 of 3" })
		.waitFor();
	await page.getByRole("button", { name: "Close find", exact: true }).click();
	await page.locator(".browser-find-bar").waitFor({ state: "detached" });
	report.checks.push({
		nativeBounds: native,
		findBottom,
		matches: 3,
		nextPrevious: true,
	});
	await route("");
	await page.locator("#new-tab-chat-input").focus();
	await capture("composer-expanded");
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find((w) => !w.webContents.getURL().includes("petOverlay"))
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
