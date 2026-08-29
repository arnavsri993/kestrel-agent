import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-smoke-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop")];
let application;
const server = createServer((_request, response) => {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(
		`<!doctype html><html><head><title>Kestrel browser smoke</title></head><body><label>Name <input id="name"></label><div style="height: 1600px" aria-hidden="true"></div><button id="submit">Submit</button><output id="result">Waiting</output><script>let activationCount = 0; document.querySelector("#submit").addEventListener("click", () => { activationCount += 1; document.querySelector("#result").textContent = "Hello " + document.querySelector("#name").value + " / activation " + activationCount; });</script></body></html>`,
	);
});
await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");
const browserOrigin = `http://127.0.0.1:${address.port}`;

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: { ...process.env, KESTREL_TEST_USER_DATA: join(root, "user-data") },
	});
	const page = await application.firstWindow();
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	await page.locator('summary[aria-label="Task settings"]').click();
	const taskSettings = page.locator(".task-settings[open]");
	await taskSettings.locator(".runtime-project-picker select").waitFor();
	await taskSettings.getByText(/Auto routes model, thinking level/).waitFor();
	await page.getByRole("button", { name: /^Model:/ }).click();
	const modelMenu = page.getByRole("menu", {
		name: "Choose provider, model, and thinking level",
	});
	await modelMenu.waitFor();
	assert.equal(
		await modelMenu
			.getByRole("switch", { name: "Automatically choose a model" })
			.getAttribute("aria-checked"),
		"true",
	);
	await page.keyboard.press("Escape");
	await modelMenu.waitFor({ state: "detached" });
	assert.equal(
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.isDisabled(),
		true,
	);
	await openKestrelDestination(page, "Settings");
	await page
		.locator(".settings-nav")
		.getByRole("button", { name: /^General/ })
		.click();
	await page.getByText("Communication style", { exact: true }).waitFor();
	await page.getByText("Run at login", { exact: true }).waitFor();

	const petDecoder = await page.evaluate(async () => {
		const result = await window.kestrel.request({
			type: "pet-decoder-diagnostic",
		});
		if (!result.ok) throw new Error(result.error);
		return result.petDecoderDiagnostic;
	});
	assert.deepEqual(
		{ decoder: petDecoder?.decoder, ok: petDecoder?.ok },
		{ decoder: "sharp", ok: true },
	);
	assert.match(petDecoder?.version ?? "", /^\d+\.\d+\.\d+/);

	const typedReceiptSentinel = "receipt-typed-body-sentinel";
	const browserSmoke = await page.evaluate(
		async ({ browserOrigin, typedReceiptSentinel }) => {
			const sessions = await window.kestrel.request({
				type: "runtime-list-sessions",
			});
			if (!sessions.ok || !sessions.sessions?.length)
				throw new Error("No runtime session is available.");
			let sessionId;
			for (const candidate of sessions.sessions) {
				const discovered = await window.kestrel.request({
					type: "runtime-discover-tools",
					sessionId: candidate.id,
					query: "browser.create",
				});
				if (
					discovered.ok &&
					discovered.tools?.some((tool) => tool.name === "browser.create")
				) {
					sessionId = candidate.id;
					break;
				}
			}
			if (!sessionId)
				throw new Error("Packaged browser tools were not installed.");
			const call = async (toolName, input, idempotencyKey) => {
				const result = await window.kestrel.request({
					type: "runtime-call-tool",
					sessionId,
					toolName,
					input,
					approvalStatus: "approved",
					...(idempotencyKey ? { idempotencyKey } : {}),
				});
				if (!result.ok) throw new Error(result.error);
				if (result.execution?.status !== "verified")
					throw new Error(
						`${toolName} was not verified: ${result.execution?.status}${result.execution?.error ? ` — ${result.execution.error}` : ""}`,
					);
				return result.execution.output;
			};
			const created = await call(
				"browser.create",
				{ allowedOrigins: [browserOrigin] },
				"desktop-smoke-create",
			);
			const browserSessionId = String(created?.browserSessionId ?? "");
			if (!browserSessionId) throw new Error("Browser session ID is missing.");
			let browserResult;
			try {
				await call(
					"browser.navigate",
					{ browserSessionId, url: `${browserOrigin}/smoke` },
					"desktop-smoke-navigate",
				);
				await call(
					"browser.act",
					{
						browserSessionId,
						action: {
							type: "type",
							target: "#name",
							text: typedReceiptSentinel,
						},
					},
					"desktop-smoke-type",
				);
				let snapshot;
				let clickAttempts = 0;
				// This fixture's handler only assigns local text, so one bounded retry
				// cannot repeat an external or non-idempotent effect. Production browser
				// clicks deliberately remain one-shot.
				for (let clickAttempt = 0; clickAttempt < 2; clickAttempt += 1) {
					clickAttempts += 1;
					await call(
						"browser.act",
						{ browserSessionId, action: { type: "click", target: "#submit" } },
						`desktop-smoke-click-${clickAttempt}`,
					);
					for (
						let snapshotAttempt = 0;
						snapshotAttempt < 20;
						snapshotAttempt += 1
					) {
						snapshot = await call("browser.snapshot", { browserSessionId });
						if (
							JSON.stringify(snapshot?.accessibilityTree).includes(
								`Hello ${typedReceiptSentinel}`,
							)
						)
							break;
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					if (
						JSON.stringify(snapshot?.accessibilityTree).includes(
							`Hello ${typedReceiptSentinel}`,
						)
					)
						break;
				}
				const screenshot = await call("browser.screenshot", {
					browserSessionId,
				});
				browserResult = {
					title: snapshot?.title,
					snapshotText: JSON.stringify(snapshot?.accessibilityTree),
					clickAttempts,
					screenshotWidth: screenshot?.width,
					screenshotHeight: screenshot?.height,
					pngBase64: screenshot?.pngBase64,
				};
			} finally {
				await call(
					"browser.close",
					{ browserSessionId },
					"desktop-smoke-close",
				);
			}
			const receiptResponse = await window.kestrel.request({
				type: "runtime-list-action-receipts",
				sessionId,
			});
			if (!receiptResponse.ok) throw new Error(receiptResponse.error);
			const browserReceipts = (receiptResponse.receipts ?? []).filter(
				(receipt) => receipt.toolName.startsWith("browser."),
			);
			return { ...browserResult, browserReceipts };
		},
		{ browserOrigin, typedReceiptSentinel },
	);
	assert.equal(browserSmoke.title, "Kestrel browser smoke");
	assert.match(
		browserSmoke.snapshotText,
		new RegExp(`Hello ${typedReceiptSentinel} / activation 1`),
	);
	assert.equal(
		browserSmoke.clickAttempts,
		1,
		"Browser click required the smoke-only retry.",
	);
	assert.equal(typeof browserSmoke.screenshotWidth, "number");
	assert.equal(typeof browserSmoke.screenshotHeight, "number");
	assert.match(browserSmoke.pngBase64, /^iVBOR/);
	assert.ok(browserSmoke.browserReceipts.length >= 5);
	assert.equal(
		browserSmoke.browserReceipts.every(
			(receipt) =>
				receipt.trust === "local_encrypted_bounded" &&
				receipt.outcome === "verified",
		),
		true,
	);
	assert.equal(
		JSON.stringify(browserSmoke.browserReceipts).includes(typedReceiptSentinel),
		false,
	);
	assert.equal(
		browserSmoke.browserReceipts.some(
			(receipt) =>
				receipt.toolName === "browser.navigate" &&
				receipt.destination.label.startsWith(browserOrigin),
		),
		true,
	);
	await page.screenshot({
		path: join(root, "desktop-smoke.png"),
		fullPage: true,
	});
	process.stdout.write(
		`Rendered ${packagedExecutable ? "packaged" : "development"} desktop, native Sharp ${petDecoder.version}, isolated browser tools, and privacy-bounded action receipts passed.\n`,
	);
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
