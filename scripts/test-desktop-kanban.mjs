import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openCommandCenter, openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-kanban-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const screenshotPath = resolve(
	"artifacts/screenshots/desktop/setup-revised/work-kanban.png",
);
mkdirSync(dirname(screenshotPath), { recursive: true });
let application;
let page;
const diagnosticsRoot = resolve("test-results/desktop-kanban");
async function recordInteraction(stage) {
	if (!page || page.isClosed()) return;
	mkdirSync(diagnosticsRoot, { recursive: true, mode: 0o700 });
	const evidence = await page.evaluate(() => {
		const describe = element => {
			if (!(element instanceof HTMLElement)) return null;
			const style = getComputedStyle(element), rect = element.getBoundingClientRect();
			return { tag: element.tagName, id: element.id, className: element.className,
				role: element.getAttribute("role"), appPage: element.dataset.appPage,
				ariaHidden: element.getAttribute("aria-hidden"), inert: element.inert,
				pointerEvents: style.pointerEvents, inlinePointerEvents: element.style.pointerEvents,
				opacity: style.opacity, display: style.display, visibility: style.visibility,
				overflow: style.overflow, transform: style.transform, zIndex: style.zIndex,
				scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
		};
		const card = [...document.querySelectorAll(".kanban-card")].find(element =>
			[...element.querySelectorAll("h1,h2,h3,h4,h5,h6")].some(heading => heading.textContent === "Audit reference coverage"));
		const buttons = card ? [...card.querySelectorAll("button")] : [];
		const button = buttons.find(element => element.textContent?.trim() === "In progress →") ??
			buttons.find(element => element.textContent?.trim() === "← Ready");
		const rect = button?.getBoundingClientRect();
		const x = rect ? Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)) : 0;
		const y = rect ? Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)) : 0;
		const ancestors = []; for (let element = button; element && ancestors.length < 12; element = element.parentElement) ancestors.push(describe(element));
		return { viewport: { width: innerWidth, height: innerHeight }, visibility: document.visibilityState,
			hasFocus: document.hasFocus(), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
			button: describe(button), ancestors,
			hitPoint: { x, y }, hitStack: document.elementsFromPoint(x, y).slice(0, 12).map(describe),
			appPages: [...document.querySelectorAll(".browser-app-page")].slice(0, 8).map(describe),
			browserViewport: describe(document.getElementById("browser-viewport")), activeElement: describe(document.activeElement) };
	});
	writeFileSync(join(diagnosticsRoot, `${stage}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

try {
	application = await electron.launch({
		executablePath: requireFromDesktop("electron"),
		args: [resolve("apps/desktop")],
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data"),
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

	const column = (name) =>
		page
			.locator(".kanban-column")
			.filter({ has: page.getByRole("heading", { name, exact: true }) });
	const card = (name) =>
		page
			.locator(".kanban-card")
			.filter({ has: page.getByRole("heading", { name, exact: true }) });
	await recordInteraction("before-move");
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
	for (const reduced of [false, true]) {
		await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
		for (let index = 0; index < 3; index++) {
			await openCommandCenter(page);
			await openWork();
			await recordInteraction(`route-return-${reduced ? "reduced" : "normal"}-${index}`);
			await card("Audit reference coverage").getByRole("button", { name: "← Ready", exact: true }).click();
			await column("Ready").getByRole("heading", { name: "Audit reference coverage", exact: true }).waitFor();
			await card("Audit reference coverage").getByRole("button", { name: "In progress →", exact: true }).click();
			await column("In progress").getByRole("heading", { name: "Audit reference coverage", exact: true }).waitFor();
			assert.equal(await card("Audit reference coverage").evaluate(element => element === document.activeElement), true);
		}
	}
	await page.emulateMedia({ reducedMotion: "no-preference" });
	process.stdout.write("Verified repeated route returns with normal and reduced motion.\n");

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

	await page.screenshot({ path: screenshotPath, fullPage: false });
	await page.screenshot({ path: join(diagnosticsRoot, "desktop.png"), fullPage: false });

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
	await page.screenshot({ path: join(diagnosticsRoot, "compact.png"), fullPage: false });

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
	await recordInteraction("failure").catch(() => undefined);
	await page?.screenshot({ path: join(diagnosticsRoot, "failure.png"), fullPage: false }).catch(() => undefined);
	throw error;
} finally {
	await application?.close();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
