import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(
	join(tmpdir(), "kestrel-event-applications-"),
);
const userData = join(temporaryRoot, "user-data");
const screenshotPath = resolve(
	"artifacts/screenshots/desktop/setup-revised/opportunities-application-review.png",
);
const importScreenshotPath = resolve(
	"artifacts/screenshots/desktop/setup-revised/opportunities-import.png",
);
mkdirSync(dirname(screenshotPath), { recursive: true });

let application;
try {
	application = await electron.launch({
		args: [resolve("apps/desktop/out/main/index.js")],
		env: { ...process.env, KESTREL_TEST_USER_DATA: userData },
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(12_000);
	const runtimeErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));
	await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
	await page.reload();

	const applicationId = await page.evaluate(async () => {
		const created = await window.kestrel.request({
			type: "event-applications-create",
			title: "Neighborhood Build Weekend",
			organizer: "Fieldwork Studio",
			url: "https://events.example.test/apply",
			deadline: "2026-08-02T18:00:00.000Z",
		});
		if (!created.ok || !created.eventApplications?.[0])
			throw new Error("fixture create failed");
		const id = created.eventApplications[0].id;
		const prepared = await window.kestrel.request({
			type: "event-applications-update",
			id,
			status: "ready",
			eligibility: [
				{
					id: "age",
					label: "Applicant is 18 or older",
					met: true,
					evidence: "Applicant confirmation required",
				},
				{ id: "travel", label: "Can attend in person", met: null },
			],
			answers: [
				{
					id: "bio",
					label: "Short bio",
					value:
						"I build calm, accountable tools for people doing complex work.",
					required: true,
					reviewed: false,
					sensitivity: "personal",
					source: "agent",
				},
				{
					id: "phone",
					label: "Mobile number",
					value: "+1 555 010 1010",
					required: true,
					reviewed: false,
					sensitivity: "sensitive",
					source: "agent",
				},
			],
		});
		if (!prepared.ok) throw new Error("fixture prepare failed");
		return id;
	});

	await openKestrelDestination(page, "Opportunities");
	await page
		.getByRole("heading", {
			name: "Apply with your agent. Send with your consent.",
		})
		.waitFor();
	await page
		.getByRole("heading", { name: "Neighborhood Build Weekend" })
		.waitFor();
	await page.getByText("Submission stays locked", { exact: true }).waitFor();
	assert.equal(
		await page
			.getByText("sensitive · drafted by agent", { exact: true })
			.count(),
		1,
	);

	const eligibility = page.getByLabel("Can attend in person eligibility");
	await eligibility.selectOption("yes");
	const reviewChecks = page.locator(".review-checkbox input");
	await reviewChecks.nth(0).check();
	await reviewChecks.nth(1).check();
	await page
		.getByRole("button", { name: "Approve reviewed application" })
		.click();
	await page.locator(".event-status", { hasText: "approved" }).waitFor();
	const stored = await page.evaluate(async (id) => {
		const response = await window.kestrel.request({
			type: "event-applications-list",
		});
		return response.ok
			? response.eventApplications?.find((item) => item.id === id)
			: undefined;
	}, applicationId);
	assert.equal(stored?.status, "approved");
	assert.ok(stored?.approvedAt);

	await page.setViewportSize({ width: 1320, height: 900 });
	await page.locator(".legacy-product-surface").evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.screenshot({ path: importScreenshotPath });
	await page.locator(".legacy-product-surface").evaluate((element) => {
		element.scrollTop = 520;
	});
	await page.screenshot({ path: screenshotPath });
	await page.setViewportSize({ width: 620, height: 760 });
	assert.equal(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		),
		false,
	);
	await page.getByRole("button", { name: "Prepare again with agent" }).focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	assert.notEqual(
		await page
			.getByRole("button", { name: "Prepare again with agent" })
			.evaluate((element) => getComputedStyle(element).outlineStyle),
		"none",
	);
	assert.deepEqual(runtimeErrors, []);
	await page
		.getByRole("button", { name: "Continue with browser agent" })
		.waitFor();
	process.stdout.write(
		`Event import, sensitive review, eligibility, approval-gated browser handoff, persistence, compact reflow, and screenshots passed. Screenshots: ${importScreenshotPath}, ${screenshotPath}\n`,
	);
} finally {
	await application?.close();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
