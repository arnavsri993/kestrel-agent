import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// Renderer proof only. These stored fixture messages do not certify model work.
const root = mkdtempSync(join(tmpdir(), "kestrel-tool-results-"));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const evidence = process.env.KESTREL_TOOL_RESULTS_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
let app;
try {
	app = await electron.launch({
		executablePath: packaged || createRequire(resolve("apps/desktop/package.json"))("electron"),
		args: [...(packaged ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
		env: { ...process.env, KESTREL_TEST_USER_DATA: root, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" },
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(15_000);
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	const request = async input => {
		const result = await page.evaluate(input => window.kestrel.request(input), input);
		assert(result.ok, result.error);
		return result;
	};
	const created = await request({ type: "runtime-create-session", title: "Tool result display fixture" });
	const sessionId = created.session.id;
	const append = (role, content) => request({ type: "runtime-append-message", sessionId, role, content });
	await append("user", "Read the disposable fixture page.");
	await append("tool", JSON.stringify({ status: "verified", output: { url: "https://example.test/check?private=value", accessibilityTree: "large-fixture-observation ".repeat(4_000) } }));
	await append("tool", JSON.stringify({ status: "failed", error: "The fixture page was unavailable. Read a visible tab instead." }));
	await append("assistant", "Fixture answer: the page was read; one subsequent read failed.");
	await request({ type: "runtime-select-session", sessionId });
	await page.reload();
	const chatToggle = page.locator("#browser-agent-toggle");
	await chatToggle.waitFor();
	if (await chatToggle.getAttribute("aria-expanded") !== "true") await chatToggle.click();
	const chat = page.locator(".agent-conversation-host");
	const list = chat.locator(".message-list");
	const rows = chat.locator(".runtime-tool-message");
	await expect(rows).toHaveCount(2);
	for (const width of [1440, 1000]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"))?.setSize(width, 900), width);
		await expect(rows.locator("details[open]")).toHaveCount(0);
		await expect(rows.first().locator("pre")).toBeHidden();
		await expect(rows.first().locator("summary")).toContainText("Done");
		await expect(rows.first().locator("summary")).not.toContainText("private=value");
		await expect(rows.last().locator(".runtime-tool-error")).toBeVisible();
		const geometry = await list.evaluate(node => {
			const box = node.getBoundingClientRect();
			const answer = node.querySelector(".assistant-message").getBoundingClientRect();
			const result = node.querySelector(".runtime-tool-message").getBoundingClientRect();
			return { answerVisible: answer.top >= box.top && answer.bottom <= box.bottom, compactResult: result.height < 90, overflow: node.scrollWidth > node.clientWidth };
		});
		assert.deepEqual(geometry, { answerVisible: true, compactResult: true, overflow: false });
		if (width === 1000) assert(await page.locator(".agent-sidebar-collapse").evaluate(button => {
			const box = button.getBoundingClientRect();
			const text = button.querySelector("span").getBoundingClientRect();
			const icon = button.querySelector("svg").getBoundingClientRect();
			return text.top >= box.top && text.bottom <= box.bottom && icon.right <= text.left && Math.abs((icon.top + icon.bottom) / 2 - (text.top + text.bottom) / 2) < 2;
		}), "Compact Close's icon and label must share one contained row.");
		if (evidence) await page.screenshot({ path: join(evidence, `tool-results-${width}.png`) });
		await rows.first().locator("summary").focus();
		await page.keyboard.press("Enter");
		await expect(rows.first().locator("pre")).toBeVisible();
		assert(await rows.first().locator("pre").evaluate(node => node.clientHeight <= 242 && node.scrollHeight > node.clientHeight), "Expanded observations must scroll within a bounded area.");
		await page.keyboard.press("Enter");
		await expect(rows.first().locator("pre")).toBeHidden();
	}
	// A fresh appended answer follows the bottom; reviewing old text stays put.
	await append("assistant", "Scrollable fixture text.\n".repeat(60));
	await expect(chat.locator(".assistant-message").last()).toContainText("Scrollable fixture text.");
	await expect.poll(() => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
	await list.hover();
	await page.mouse.wheel(0, -5_000);
	await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0);
	await append("assistant", "A new result arrived while you reviewed an older message.");
	await expect(chat.locator(".assistant-message").last()).toContainText("A new result arrived");
	assert.equal(await list.evaluate(node => node.scrollTop), 0, "New results must not pull a reader away from earlier messages.");
	await page.mouse.wheel(0, 5_000);
	await expect.poll(() => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
	await chat.locator("#runtime-prompt").focus();
	await append("assistant", "Another answer at the bottom.\n".repeat(20));
	await expect(chat.locator(".assistant-message").last()).toContainText("Another answer at the bottom.");
	await expect.poll(() => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
	assert.equal(await page.evaluate(() => document.activeElement?.id), "runtime-prompt", "Following new results must not steal keyboard focus.");
	assert.deepEqual(errors, []);
	console.log("Tool results: compact and desktop details, visible errors, bounded expansion, answer follow, review scroll and focus passed.");
} finally {
	await app?.close();
	rmSync(root, { recursive: true, force: true });
}
