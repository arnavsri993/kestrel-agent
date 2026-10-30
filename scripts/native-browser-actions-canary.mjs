import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function nativeBrowserActionsCanary({ getHome, createdPage, coreTool, baseUrl, readableTab, evidence, receipt }) {
	const url = `${baseUrl}/actions`;
	const opened = await coreTool("browser.open-tab", { input: url });
	assert(opened.output?.tabId, JSON.stringify(opened));
	const tabId = opened.output.tabId; const page = await createdPage(candidate => candidate === url);
	await page.getByRole("heading", { name: "Native browser action canary" }).waitFor();
	async function snapshot(id = tabId) {
		const result = await coreTool("browser.visible-snapshot", { tabId: id }); assert.equal(result.status, "verified", JSON.stringify(result)); return result.output;
	}
	async function action(input) {
		const result = await coreTool("browser.visible-act", { tabId, action: input });
		assert(!["failed", "blocked", "cancelled"].includes(result.status), JSON.stringify(result)); return result;
	}
	const first = await snapshot(); const query = first.interactive.find(item => item.name === "Public query"); const staleButton = first.interactive.find(item => item.name === "Add one");
	assert(query && staleButton, JSON.stringify(first));
	await action({ type: "type", target: `@${query.ref}`, text: "native input result" });
	assert.equal(await page.getByLabel("Public query", { exact: true }).inputValue(), "native input result");
	assert.equal(await page.evaluate(() => window.nativeTrustedInput), true, "Chromium must deliver trusted native input.");
	const stale = await coreTool("browser.visible-act", { tabId, action: { type: "click", target: staleButton.ref } });
	assert.equal(stale.status, "failed", "An old observation must not target a new snapshot's element.");
	assert.equal(await page.locator("#click-result").textContent(), "0");
	const current = await snapshot(); const button = current.interactive.find(item => item.name === "Add one"); assert(button);
	await action({ type: "click", target: `ref=${button.ref}` });
	assert.equal(await page.locator("#click-result").textContent(), "1");
	assert.equal(await page.evaluate(() => window.nativeTrustedClick), true, "Chromium must deliver a trusted native click.");
	const selectSnapshot = await snapshot(); const country = selectSnapshot.interactive.find(item => item.name === "Country"); assert(country);
	await action({ type: "select", target: country.ref, value: "second" });
	assert.equal(await page.locator("select#country").inputValue(), "second");
	assert.equal(await page.locator("#selection-result").textContent(), "second");
	const typeSnapshot = await snapshot(); const secondQuery = typeSnapshot.interactive.find(item => item.name === "Public query"); assert(secondQuery);
	await action({ type: "type", target: secondQuery.ref, text: " more" });
	await snapshot(); await action({ type: "key", key: "Enter" });
	assert.equal(await page.evaluate(() => window.nativeTrustedKey), true, "Page keys must stay in Chromium's native input path.");
	assert.equal(await page.evaluate(() => window.nativeTrustedKeypress), true, "Enter must deliver its real character event, not only key-down metadata.");
	await snapshot(); await action({ type: "scroll", x: 0, y: 450 });
	await page.waitForFunction(() => scrollY > 0);
	receipt.phases.push({ phase: "native-Core-trusted-click-type-select-key-scroll-and-stale-ref-rejection", passed: true });

	const beforeNavigation = await snapshot(); const ref = beforeNavigation.interactive.find(item => item.name === "Public query"); assert(ref);
	await page.reload(); await page.getByRole("heading", { name: "Native browser action canary" }).waitFor();
	const replaced = await coreTool("browser.visible-act", { tabId, action: { type: "type", target: ref.ref, text: "must-not-enter-replacement-document" } });
	assert.equal(replaced.status, "failed"); assert.equal(await page.getByLabel("Public query", { exact: true }).inputValue(), "");
	const sensitive = await snapshot(readableTab.id); const secret = sensitive.interactive.find(item => item.name === "Sensitive field"); assert(secret);
	const refused = await coreTool("browser.visible-act", { tabId: readableTab.id, action: { type: "type", target: secret.ref, text: "must-not-enter-secret-field" } });
	assert(["failed", "blocked"].includes(refused.status));
	const privateScreenshot = await coreTool("browser.visible-screenshot", { tabId: readableTab.id }); assert.equal(privateScreenshot.status, "failed");
	receipt.phases.push({ phase: "native-Core-document-replacement-and-sensitive-field-refusal", passed: true });

	const navigated = await coreTool("browser.navigate-tab", { tabId, input: `${baseUrl}/visual` }); assert(!["failed", "blocked"].includes(navigated.status), JSON.stringify(navigated));
	await page.waitForURL(`${baseUrl}/visual`); await page.getByRole("heading", { name: "Native screenshot canary" }).waitFor();
	const screen = await coreTool("browser.visible-screenshot", { tabId }); assert.equal(screen.status, "verified", JSON.stringify(screen));
	assert(screen.output.width > 0 && screen.output.height > 0); const png = Buffer.from(screen.output.pngBase64, "base64");
	assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	await writeFile(join(evidence, "native-Core-screenshot.png"), png);
	receipt.phases.push({ phase: "native-Core-compressed-screenshot", passed: true, width: screen.output.width, height: screen.output.height, pngBytes: png.length });
	await coreTool("browser.close-tab", { tabId }); await getHome().bringToFront();
}
