import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-organize-tabs-verify-"));
const userData = join(root, "user-data");
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const executablePath = requireFromDesktop("electron");
const launchArgs = [resolve("apps/desktop")];

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const pageName = url.pathname === "/two" ? "Page two" : "Page one";
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(`<!doctype html><html><head><title>${pageName}</title></head><body><h1>${pageName}</h1></body></html>`);
});

await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const serverAddress = server.address();
assert(serverAddress && typeof serverAddress === "object");
const origin = `http://127.0.0.1:${serverAddress.port}`;

let application;
let page;

async function browserState() {
	const response = await page.evaluate(() =>
		window.kestrel.request({ type: "browser-get-state" }),
	);
	assert.equal(response.ok, true);
	return response.browserState;
}

async function waitForBrowserState(predicate, label) {
	const deadline = Date.now() + 30_000;
	let latest;
	while (Date.now() < deadline) {
		latest = await browserState();
		if (predicate(latest)) return latest;
		await new Promise((resolveWait) => setTimeout(resolveWait, 75));
	}
	throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
			KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
			KESTREL_TEST_USER_DATA: userData,
			KESTREL_REAL_USER_PROFILE: "1",
		},
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();

	// Duplicate page one, one page two, and one extra empty tab.
	const fixtureTabIds = await page.evaluate(async (urls) => {
		const ids = [];
		for (const input of urls) {
			const response = await window.kestrel.request({
				type: "browser-create-tab",
				input,
				active: false,
			});
			if (!response.ok || !("browserState" in response))
				throw new Error("Fixture tab could not be created.");
			const created = response.browserState.tabs.at(-1);
			if (!created) throw new Error("Fixture tab had no id.");
			ids.push(created.id);
		}
		return ids;
	}, [`${origin}/one`, `${origin}/one`, `${origin}/two`, ""]);

	await waitForBrowserState(
		(value) => value.tabs.filter((tab) => tab.url === `${origin}/one`).length >= 2,
		"duplicate fixture tabs",
	);

	const preview = await page.evaluate(async () => {
		const response = await window.kestrel.request({
			type: "browser-preview-organize-tabs",
		});
		if (!response.ok || !("browserOrganization" in response))
			throw new Error("Organize tabs preview failed.");
		return response.browserOrganization;
	});

	assert(
		preview.suggestedDeletions.some(
			(item) => item.reason === "Duplicate of another open tab",
		),
		"Preview should suggest closing a duplicate tab",
	);
	assert(
		preview.tabFolders.length >= 1,
		"Preview should suggest at least one folder for related localhost tabs",
	);

	await page.getByRole("button", { name: "Tab tools", exact: true }).click();
	await page.getByRole("menuitem", { name: "Organize tabs", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Organize tabs" });
	await dialog.waitFor();
	assert.equal(
		await dialog.getByText("Does this grouping fit?", { exact: true }).count(),
		0,
		"Poll should be removed",
	);
	await dialog.getByText("Suggested to close", { exact: true }).waitFor();
	assert(
		(await dialog.locator(".organize-tabs-deletion input:checked").count()) >= 1,
		"At least one deletion suggestion should be pre-selected",
	);

	if (await dialog.getByRole("button", { name: "Apply changes", exact: true }).isVisible()) {
		await dialog.getByRole("button", { name: "Apply changes", exact: true }).click();
	} else if (
		await dialog.getByRole("button", { name: "Close selected tabs", exact: true }).isVisible()
	) {
		await dialog.getByRole("button", { name: "Close selected tabs", exact: true }).click();
	} else {
		await dialog.getByRole("button", { name: "Group tabs", exact: true }).click();
	}
	await dialog.waitFor({ state: "detached" });

	const after = await waitForBrowserState(
		(value) =>
			value.tabFolders.length >= 1 &&
			value.tabs.filter((tab) => tab.url === `${origin}/one`).length === 1,
		"applied organize tabs",
	);
	assert(
		after.tabFolders.length >= 1,
		"Folders should exist after applying organization",
	);
	assert.equal(
		after.tabs.filter((tab) => tab.url === `${origin}/one`).length,
		1,
		"Duplicate tab should be closed after apply",
	);

	console.log(
		JSON.stringify({
			ok: true,
			folders: after.tabFolders.map((folder) => folder.name),
			tabCount: after.tabs.length,
			deletionsApplied: true,
		}),
	);
} finally {
	if (application) await application.close().catch(() => undefined);
	server.close();
	rmSync(root, { recursive: true, force: true });
}
