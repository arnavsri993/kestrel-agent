import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-honcho-"));
const screenshotPath = resolve(
	"artifacts/screenshots/desktop/setup-revised/settings-honcho-memory.png",
);
mkdirSync(dirname(screenshotPath), { recursive: true });
const requests = [];
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const bodyText = Buffer.concat(chunks).toString("utf8");
	requests.push({
		method: request.method,
		url: request.url,
		body: bodyText ? JSON.parse(bodyText) : undefined,
		authorization: request.headers.authorization,
	});
	if (request.method === "POST" && request.url === "/v3/workspaces") {
		const body = JSON.parse(bodyText);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				id: body.id,
				metadata: { fixture: true },
				configuration: {},
				created_at: "2026-07-23T12:00:00.000Z",
			}),
		);
		return;
	}
	response.writeHead(404, { "content-type": "application/json" });
	response.end(JSON.stringify({ detail: "Not found" }));
});
await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

let application;
try {
	application = await electron.launch({
		args: [resolve("apps/desktop/out/main/index.js")],
		env: {
			...process.env,
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
	await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
	await page.reload();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: /^Memory/ }).click();

	const setting = page.locator(".honcho-memory-setting");
	await setting.getByText("Honcho remote memory", { exact: true }).waitFor();
	await setting
		.getByText("Provider configuration and reasoning controls", {
			exact: true,
		})
		.click();
	await setting.getByLabel("Server URL").fill(baseUrl);
	await setting
		.getByText(
			"I understand that enabling Honcho sends the disclosed data to the configured server.",
			{ exact: true },
		)
		.click();
	await setting.getByRole("button", { name: "Enable Honcho" }).click();
	await setting
		.getByText("Honcho memory settings saved.", { exact: true })
		.waitFor();
	await setting.getByText("ready", { exact: true }).waitFor();

	const enabledTools = await page.evaluate(async () => {
		const sessions = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		if (!sessions.ok || !sessions.sessions?.[0])
			throw new Error("Runtime session unavailable.");
		const tools = await window.kestrel.request({
			type: "runtime-discover-tools",
			sessionId: sessions.sessions[0].id,
			query: "honcho",
		});
		if (!tools.ok) throw new Error(tools.error);
		return tools.tools?.map((tool) => tool.name) ?? [];
	});
	assert.deepEqual(enabledTools, [
		"honcho.conclude",
		"honcho.context",
		"honcho.profile",
		"honcho.reasoning",
		"honcho.search",
	]);

	await setting.getByRole("button", { name: "Verify connection" }).click();
	await setting
		.getByText("Honcho workspace verified.", { exact: true })
		.waitFor();
	await setting.getByText("verified", { exact: true }).waitFor();
	assert.equal(
		requests.filter(
			(request) =>
				request.method === "POST" && request.url === "/v3/workspaces",
		).length,
		2,
	);
	assert.equal(
		requests.some((request) => request.authorization),
		false,
	);

	await page.setViewportSize({ width: 1320, height: 900 });
	await setting.scrollIntoViewIfNeeded();
	await page.screenshot({ path: screenshotPath });
	await page.setViewportSize({ width: 640, height: 760 });
	await setting.scrollIntoViewIfNeeded();
	assert.equal(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		),
		false,
	);

	await setting.getByRole("button", { name: "Disable" }).click();
	await setting
		.getByText("Honcho is disabled; local memory remains active.", {
			exact: true,
		})
		.waitFor();
	const disabledTools = await page.evaluate(async () => {
		const sessions = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		const tools = await window.kestrel.request({
			type: "runtime-discover-tools",
			sessionId: sessions.ok ? (sessions.sessions?.[0]?.id ?? "") : "",
			query: "honcho",
		});
		return tools.ok ? (tools.tools?.map((tool) => tool.name) ?? []) : [];
	});
	assert.deepEqual(disabledTools, []);
	assert.deepEqual(runtimeErrors, []);
	process.stdout.write(
		`Honcho disclosure, explicit self-host enablement, five tools, live verification, disable cleanup, compact reflow, and screenshot passed. Screenshot: ${screenshotPath}\n`,
	);
} finally {
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(temporaryRoot, { recursive: true, force: true });
}
