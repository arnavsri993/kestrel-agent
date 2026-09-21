import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "kestrel-life-context-"));
const screenshotRoot = resolve(process.env.KESTREL_SCREENSHOT_DIR ?? "artifacts/screenshots/desktop/life-context");
const wideCalendarScreenshot = join(screenshotRoot, "calendar-wide.png");
const compactCalendarScreenshot = join(screenshotRoot, "calendar-compact.png");
const peopleScreenshot = join(screenshotRoot, "people-wide.png");
const memoryScreenshot = join(screenshotRoot, "memory-wide.png");
mkdirSync(dirname(wideCalendarScreenshot), { recursive: true });

let application;
try {
	const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE;
	application = await electron.launch({
		...(executablePath
			? {
					executablePath: resolve(executablePath),
					args: ["--use-mock-keychain"],
				}
			: { args: [resolve("apps/desktop/out/main/index.js")] }),
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data"),
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(15_000);
	const runtimeErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();

	const fixture = await page.evaluate(async () => {
		const now = new Date();
		const monday = new Date(now);
		monday.setHours(0, 0, 0, 0);
		monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
		const time = (day, hour, minutes = 0) => {
			const date = new Date(monday);
			date.setDate(date.getDate() + day);
			date.setHours(hour, minutes, 0, 0);
			return date.toISOString();
		};
		const requests = [
			{
				type: "calendar-create-local",
				title: "Deep work · Kestrel",
				startsAt: time(0, 9),
				endsAt: time(0, 11),
				origin: "explicit",
				confidence: 1,
				sourceId: "desktop-user",
			},
			{
				type: "calendar-create-local",
				title: "Likely commute",
				startsAt: time(1, 8, 15),
				endsAt: time(1, 8, 50),
				origin: "inferred",
				confidence: 0.76,
				sourceId: "routine-inference",
			},
			{
				type: "calendar-create-local",
				title: "Review project plan",
				startsAt: time(2, 15),
				endsAt: time(2, 16),
				origin: "suggested",
				confidence: 0.64,
				sourceId: "agent-suggestion",
			},
			{
				type: "people-upsert",
				displayName: "Dr. Maya Chen",
				nicknames: ["Professor Chen"],
				relationship: "Professor",
				organization: "Lakeshore University",
				role: "Capstone adviser",
				email: "maya.chen@example.test",
				tone: "Brief, respectful, and prepared",
				formality: "formal",
				sourceId: "desktop-user",
				sensitivity: "personal",
			},
			{
				type: "memory-remember",
				memoryType: "project",
				content:
					"The Kestrel capstone review is the highest-priority project this month.",
				sensitivity: "personal",
				sourceId: "desktop-user",
				layer: "mid_term",
			},
		];
		const responses = [];
		for (const request of requests) {
			const response = await window.kestrel.request(request);
			if (!response.ok) throw new Error(response.error);
			responses.push(response);
		}
		return {
			explicitEventId: responses[0].calendarEvents?.[0]?.id,
			personId: responses[3].people?.[0]?.id,
		};
	});
	assert.ok(fixture.explicitEventId);
	assert.ok(fixture.personId);
	const timelineFixture = await page.evaluate(async () => {
		const sessions = await window.kestrel.request({ type: "runtime-list-sessions" });
		const sessionId = sessions.sessions?.[0]?.id;
		if (!sessions.ok || !sessionId) throw new Error(sessions.error ?? "Main session missing");
		const message = await window.kestrel.request({
			type: "runtime-append-message",
			sessionId,
			role: "user",
			content: "Timeline fixture: reviewed the Kestrel memory architecture.",
		});
		if (!message.ok) throw new Error(message.error);
		return { sessionId };
	});
	assert.ok(timelineFixture.sessionId);
	await page.reload();

	await page.setViewportSize({ width: 1320, height: 900 });
	await openKestrelDestination(page, "Memory");
	const life = page.locator(".life-product-surface");
	await life.getByRole("heading", { name: "Memory", exact: true }).waitFor();
	await life.getByRole("heading", { name: "Notes", exact: true }).waitFor();
	await life.getByText("The Kestrel capstone review is the highest-priority project this month.", { exact: true }).first().waitFor();
	await page.screenshot({ path: memoryScreenshot });

	await life.locator(".memory-filters-disclosure > summary").click();
	const viewer = life.getByLabel("Viewing as");
	const domain = life.getByLabel("Domain");
	assert.equal(await viewer.inputValue(), "user");
	assert.equal(await domain.inputValue(), "");

	await life.getByRole("button", { name: "Notes", exact: true }).click();
	await life.getByRole("button", { name: "Add note", exact: true }).click();
	await life.getByLabel("Title").fill("Working preference");
	await life.getByLabel("What Kestrel should know").fill("Keep technical explanations concise and source the important claims.");
	await life.getByRole("button", { name: "Save", exact: true }).click();
	await life.getByRole("heading", { name: "Working preference", exact: true, level: 2 }).waitFor();
	await page.screenshot({ path: join(screenshotRoot, "notes-reader-wide.png") });
	await life.getByLabel("Search memory").fill("important claims");
	assert.equal(await life.locator("aside > button").count(), 1);
	await life.getByLabel("Search memory").fill("no-such-memory-fixture");
	await life.getByText("No matching documents.", { exact: false }).waitFor();
	await life.getByRole("button", { name: "Clear search", exact: true }).click();
	await life.getByRole("button", { name: "Edit note", exact: true }).click();
	await life.getByLabel("Title").fill("Unsaved title");
    page.once("dialog", dialog => dialog.dismiss());
    await life.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await life.getByLabel("Title").inputValue(), "Unsaved title");
    page.once("dialog", dialog => dialog.accept());
    await life.getByRole("button", { name: "Cancel", exact: true }).click();
    await life.getByRole("heading", { name: "Working preference", exact: true }).waitFor();
    await life.getByRole("button", { name: "Edit note", exact: true }).click();
    await life.getByText("Sources and provenance", { exact: true }).click();
	await life.getByText("manual", { exact: true }).waitFor();

	await life.getByRole("button", { name: "Recent activity", exact: true }).click();
	await life.getByRole("heading", { name: "Your week in context" }).waitFor();
	await life.locator(".memory-days details summary").first().click();
	await life.getByText("Timeline fixture: reviewed the Kestrel memory architecture.", { exact: true }).first().waitFor();

	await life.getByLabel("More memory views").selectOption("knowledge");
	await life.getByRole("heading", { name: "Knowledge", exact: true }).waitFor();
	await life.getByLabel("More memory views").selectOption("tools");
	await life.getByText("Calendar, capture, and source administration", { exact: true }).click();
	await life.getByText("Deep work · Kestrel", { exact: true }).waitFor();
	await page.screenshot({ path: wideCalendarScreenshot });

	await page.setViewportSize({ width: 640, height: 760 });
	await life.getByLabel("More memory views").selectOption("overview");
	await life.getByRole("heading", { name: "What Kestrel understands" }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
	await page.screenshot({ path: compactCalendarScreenshot, fullPage: true });

	await openKestrelDestination(page, "Connections");
	const connections = page.locator("#setting-agent-connections");
	await connections.getByRole("button", { name: "Apps & accounts", exact: true }).waitFor();
	assert.equal(await connections.getByRole("heading", { name: "Onshape", exact: true }).isVisible(), false);
	assert.equal(await connections.locator(".connection-app[open]").count(), 0);
	await page.screenshot({ path: join(screenshotRoot, "connections-compact.png") });
	await connections.locator(".connection-app > summary").filter({ hasText: "Google" }).click();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
	const googleButton = await connections.getByRole("button", { name: "Connect with Google", exact: true }).boundingBox();
	assert.ok(googleButton && googleButton.width > 100 && googleButton.height < 90, "Google action must remain readable at compact width");
	await page.screenshot({ path: join(screenshotRoot, "connections-setup-compact.png") });
	await page.setViewportSize({ width: 1320, height: 900 });
	await page.screenshot({ path: join(screenshotRoot, "connections-wide.png") });
	await connections.getByText("Set up Google connection", { exact: true }).click();
	await connections.getByLabel("Desktop OAuth client ID").waitFor();
	await connections.getByLabel("More connection settings").selectOption("local");
	await connections.getByText("Messages on this Mac", { exact: true }).waitFor();
	assert.equal(await connections.getByRole("heading", { name: "Onshape", exact: true }).isVisible(), false);
	await connections.getByLabel("More connection settings").selectOption("models");
	await connections.getByText("ChatGPT", { exact: true }).waitFor();
	await connections.getByLabel("More connection settings").selectOption("access");
	await connections.getByText("Select an agent in", { exact: false }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		`Memory overview, document editing, weekly timeline, advanced tools, scope controls, and compact reflow passed. Screenshots: ${wideCalendarScreenshot}, ${compactCalendarScreenshot}, ${peopleScreenshot}, ${memoryScreenshot}\n`,
	);
} finally {
	await application?.close();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
