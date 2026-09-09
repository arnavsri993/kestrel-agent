import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-action-motion-"));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const require = createRequire(resolve("apps/desktop/package.json"));
let application;
try {
	application = await electron.launch({
		executablePath: packaged || require("electron"),
		args: packaged ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
		env: { ...process.env, KESTREL_TEST_USER_DATA: root, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1" },
	});
	const page = await application.firstWindow();
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	const button = page.locator(".kestrel-sidebar-new-task");
	await button.waitFor();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const check = await page.evaluate(async () => {
		const button = document.querySelector(".kestrel-sidebar-new-task");
		const icon = button.querySelector("svg");
		const box = button.getBoundingClientRect();
		const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
		const move = (fraction, pointerType = "mouse") => button.dispatchEvent(new PointerEvent("pointermove", {
			bubbles: true, pointerType, clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2,
		}));
		move(.9); await frame();
		const right = parseFloat(icon.style.getPropertyValue("--action-x"));
		move(.1); await frame();
		const left = parseFloat(icon.style.getPropertyValue("--action-x"));
		const stable = button.getBoundingClientRect().x === box.x && button.getBoundingClientRect().width === box.width;
		button.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
		const cancelled = icon.style.getPropertyValue("--action-x") === "";
		move(.9, "touch"); await frame();
		const touchStatic = icon.style.getPropertyValue("--action-x") === "";
		move(.9); await frame();
		button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
		const exited = icon.style.getPropertyValue("--action-x") === "";
		button.disabled = true; move(.9); await frame();
		const disabledStatic = icon.style.getPropertyValue("--action-x") === "";
		button.disabled = false;
		return { right, left, stable, cancelled, touchStatic, exited, disabledStatic };
	});
	assert(check.right > 0 && check.right <= 2 && check.left < 0 && check.left >= -2);
	for (const key of ["stable", "cancelled", "touchStatic", "exited", "disabledStatic"]) assert.equal(check[key], true, key);
	await page.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(await button.locator("svg").evaluate(icon => getComputedStyle(icon).translate), "none");
	await button.focus();
	assert.equal(await button.evaluate(element => document.activeElement === element), true);
	await page.keyboard.press("Enter");
	await page.locator("#runtime-prompt").waitFor();
	console.log("Action motion: bounds, reversal, stable targets, cancellation, exit, touch, disabled, reduced motion and keyboard activation passed.");
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
