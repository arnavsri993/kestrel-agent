import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-kanban-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const screenshotPath = resolve(
	process.env.KESTREL_KANBAN_SCREENSHOT ?? "artifacts/screenshots/desktop/setup-revised/work-kanban.png",
);
mkdirSync(dirname(screenshotPath), { recursive: true });
let application;
let page;

try {
	application = await electron.launch({
		executablePath: packagedExecutable ? resolve(packagedExecutable) : requireFromDesktop("electron"),
		args: packagedExecutable ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data"),
			KESTREL_TEST_MOCK_KEYCHAIN: "1",
			KESTREL_DISABLE_UPDATES: "1",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	const openWork = async () => {
		await openKestrelDestination(page, "Work");
	};
	await openWork();
	await page.getByRole("heading", { name: "Goal board" }).waitFor();

	const created = await page.evaluate(async () => {
		const sessions = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		if (!sessions.ok || !sessions.sessions?.[0])
			throw new Error("A root runtime session is required.");
		const response = await window.kestrel.request({
			type: "orchestration-goal-create",
			sessionId: sessions.sessions[0].id,
			title: "Market readiness",
			objective:
				"Audit reference coverage\nWire durable state\nVerify packaged interaction",
			tasks: [
				"Audit reference coverage",
				"Wire durable state",
				"Verify packaged interaction",
			],
		});
		if (!response.ok || !response.goals?.[0])
			throw new Error("The board fixture goal was not created.");
		const goal = response.goals[0];
		const results = [
			await window.kestrel.request({
				type: "orchestration-goal-update",
				goalId: goal.id,
				taskId: goal.tasks[1].id,
				taskStatus: "in_progress",
			}),
			await window.kestrel.request({
				type: "orchestration-goal-update",
				goalId: goal.id,
				taskId: goal.tasks[2].id,
				taskStatus: "completed",
			}),
		];
		if (results.some((result) => !result.ok))
			throw new Error("The board fixture statuses were not created.");
		return { goalId: goal.id };
	});
	assert.match(created.goalId, /^goal-/);
	process.stdout.write("Created durable board fixture.\n");

	await page.reload();
	await openWork();
	await page.getByRole("heading", { name: "Goal board" }).waitFor();
	await page.getByText("Market readiness", { exact: true }).first().waitFor();
	process.stdout.write("Rendered all board columns.\n");
	const routeTabs = await page.evaluate(async () => {
		const response = await window.kestrel.request({ type: "browser-get-state" });
		if (!response.ok || !response.browserState) throw new Error("Browser state unavailable.");
		return Object.fromEntries(["work", "commands"].map(route => [route,
			response.browserState.tabs.find(tab => tab.url === `kestrel://${route}`)?.id]));
	});
	assert(routeTabs.work && routeTabs.commands);
	// Switch back before the previous page finishes exiting. The final task
	// move still uses a real pointer click, without bypassing hit testing.
	for (let attempt = 0; attempt < 6; attempt += 1) {
		await page.locator('[data-app-page="commands"]').waitFor({ state: "detached" });
		const selectRoute = async (tabId) => {
			const response = await page.evaluate(tabId => window.kestrel.request({ type: "browser-select-tab", tabId }), tabId);
			assert.equal(response.ok, true);
		};
		await selectRoute(routeTabs.commands);
		await page.waitForFunction(() => document.querySelector('[data-app-page="commands"]'), undefined, { polling: "raf" });
		const exitingWork = await page.locator('[data-app-page="work"]').evaluateAll(routes => routes.map(route => ({
			inert: route.inert,
			pointerEvents: getComputedStyle(route).pointerEvents,
		})));
		for (const route of exitingWork) {
			assert.deepEqual(route, { inert: true, pointerEvents: "none" });
		}
		await page.locator(".command-groups button")
			.filter({ has: page.getByText("Work", { exact: true }) }).first().press("Enter");
		await page.getByRole("heading", { name: "Goal board" }).waitFor();
		await page.waitForFunction(() => {
			const routes = [...document.querySelectorAll('.browser-app-page[data-app-page="work"]')];
			const route = routes[0];
			const button = route && [...route.querySelectorAll('.kanban-card-actions button')].find(button => button.textContent === "In progress →");
			const bounds = button?.getBoundingClientRect();
			const hit = bounds && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
			const exiting = [...document.querySelectorAll(".browser-app-page")].filter(other => other !== route);
			return routes.length === 1 && !route.inert && getComputedStyle(route).pointerEvents === "auto" &&
				button?.contains(hit) && route.contains(document.activeElement) &&
				exiting.every(other => other.inert && getComputedStyle(other).pointerEvents === "none");
		}, undefined, { timeout: 2_000 });
	}
	process.stdout.write("Verified rapid route re-entry and inert exiting pages.\n");

	const column = (name) =>
		page
			.locator(".kanban-column")
			.filter({ has: page.getByRole("heading", { name, exact: true }) });
	const card = (name) =>
		page
			.locator(".kanban-card")
			.filter({ has: page.getByRole("heading", { name, exact: true }) });
	await card("Audit reference coverage")
		.getByRole("button", { name: "In progress →" })
		.click();
	await column("In progress")
		.getByRole("heading", { name: "Audit reference coverage", exact: true })
		.waitFor();
	await page
		.locator(".kanban > [role='status']")
		.getByText("Task moved from Ready to In progress.")
		.waitFor();
	assert.equal(
		await card("Audit reference coverage").evaluate(
			(element) => element === document.activeElement,
		),
		true,
	);
	process.stdout.write(
		"Verified keyboard-accessible move and focus restoration.\n",
	);

	const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
	await card("Wire durable state").dispatchEvent("dragstart", { dataTransfer });
	await column("Done").dispatchEvent("dragenter", { dataTransfer });
	await column("Done").dispatchEvent("dragover", { dataTransfer });
	await column("Done").dispatchEvent("drop", { dataTransfer });
	await card("Wire durable state")
		.dispatchEvent("dragend", { dataTransfer })
		.catch(() => undefined);
	await column("Done")
		.getByRole("heading", { name: "Wire durable state", exact: true })
		.waitFor();
	await page
		.locator(".kanban > [role='status']")
		.getByText("Task moved from In progress to Done.")
		.waitFor();
	process.stdout.write("Verified pointer drag transition.\n");

	await page.reload();
	await openWork();
	await column("In progress")
		.getByRole("heading", { name: "Audit reference coverage", exact: true })
		.waitFor();
	await column("Done")
		.getByRole("heading", { name: "Wire durable state", exact: true })
		.waitFor();
	await column("Done")
		.getByRole("heading", { name: "Verify packaged interaction", exact: true })
		.waitFor();
	assert.equal(
		await page
			.getByText(
			"No worker lanes. Cards remain local.",
			)
			.isVisible(),
		true,
	);
	process.stdout.write("Verified durable reload.\n");

	await page.locator('[data-app-page="commands"]').waitFor({ state: "detached" });
	await page.waitForFunction(() => {
		const route = document.querySelector('[data-app-page="work"]');
		return route && getComputedStyle(route).opacity === "1";
	});
	await page.screenshot({ path: screenshotPath, fullPage: false });

	await page.setViewportSize({ width: 640, height: 860 });
	const compactLayout = await page
		.locator(".kanban-columns")
		.evaluate((element) => ({
			columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: window.innerWidth,
		}));
	assert.equal(compactLayout.columns, 1);
	assert.ok(
		compactLayout.documentWidth <= compactLayout.viewportWidth,
		`Compact board overflowed: ${JSON.stringify(compactLayout)}`,
	);

	await page.emulateMedia({ reducedMotion: "reduce" });
	const reducedTransition = await page
		.locator(".kanban-column")
		.first()
		.evaluate((element) => getComputedStyle(element).transitionDuration);
	assert.match(reducedTransition, /^(?:0s|0\.001ms|1e-06s)$/);
	process.stdout.write(
		`Accessible durable Kanban interaction passed. Screenshot: ${screenshotPath}\n`,
	);
} catch (error) {
	const routes = await page?.evaluate(() => [...document.querySelectorAll(".browser-app-page")].map(route => ({
		page: route.getAttribute("data-app-page"),
		style: route.getAttribute("style"),
		pointerEvents: getComputedStyle(route).pointerEvents,
		inert: route.hasAttribute("inert"),
		focused: route.contains(document.activeElement),
		activeElement: document.activeElement?.outerHTML.slice(0, 180),
		buttons: [...route.querySelectorAll('.kanban-card-actions button')].slice(0, 2).map(button => {
			const bounds = button.getBoundingClientRect();
			return { text: button.textContent, hit: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.outerHTML.slice(0, 180) };
		}),
	}))).catch(() => undefined);
	process.stderr.write(`Route interaction diagnostics: ${JSON.stringify(routes)}\n`);
	throw error;
} finally {
	await application?.close();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
