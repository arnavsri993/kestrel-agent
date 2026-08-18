import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-kanban-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const screenshotPath = resolve(
	"artifacts/screenshots/desktop/setup-revised/work-kanban.png",
);
mkdirSync(dirname(screenshotPath), { recursive: true });
let application;

try {
	application = await electron.launch({
		executablePath: requireFromDesktop("electron"),
		args: [resolve("apps/desktop")],
		env: {
			...process.env,
			KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data"),
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(10_000);
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
				"No worker lanes are configured. Cards remain with the local operator.",
			)
			.isVisible(),
		true,
	);
	process.stdout.write("Verified durable reload.\n");

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
	assert.match(reducedTransition, /0\.001ms|1e-06s/);
	process.stdout.write(
		`Accessible durable Kanban interaction passed. Screenshot: ${screenshotPath}\n`,
	);
} finally {
	await application?.close();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
