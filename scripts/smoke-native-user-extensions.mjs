import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

/**
 * Proves the product-shell lane can keep the privileged Kestrel bridge while
 * loading an MV3 fixture into the user-browser Chromium profile. This is not
 * the isolated extension workbench and must not replace /Applications/Kestrel.app.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredApp = process.env.KESTREL_NATIVE_TEST_APP?.trim();
const app = configuredApp || (await buildNativeChromiumHost());
const executable = join(app, "Contents/MacOS/Kestrel");
const fixture = join(root, "tests/fixtures/native-extension");

const rejectProfile = await mkdtemp(join(tmpdir(), "kestrel-native-user-ext-reject-"));
const rejected = spawnSync(
	executable,
	[
		"--kestrel-extension-workbench",
		"--kestrel-user-extensions",
		"--kestrel-cache-path",
		rejectProfile,
	],
	{ encoding: "utf8", timeout: 10_000 },
);
await rm(rejectProfile, { recursive: true, force: true });
assert.equal(rejected.status, 1, `${rejected.stdout}${rejected.stderr}`);
assert.match(
	`${rejected.stdout}${rejected.stderr}`,
	/cannot run together/i,
);

const profile = await mkdtemp(join(tmpdir(), "kestrel-native-user-extensions-"));
const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(
		"<!doctype html><title>Native user extension test</title><h1>User browser extension probe</h1>",
	);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address !== "string");
const probeUrl = `http://127.0.0.1:${address.port}/probe`;

let browser;
let child;
let output = "";
try {
	child = spawn(
		executable,
		[
			"--kestrel-cache-path",
			profile,
			"--kestrel-user-extensions",
			"--kestrel-ephemeral-core",
			"--kestrel-renderer",
			"--kestrel-durable-profile",
			`--load-extension=${fixture}`,
			"--remote-debugging-port=0",
			"--kestrel-smoke-user-browser-url",
			probeUrl,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const exited = new Promise((resolveExit) =>
		child.once("exit", (code, signal) => resolveExit({ code, signal })),
	);

	let endpoint;
	for (let attempt = 0; attempt < 200; attempt++) {
		assert.equal(child.exitCode, null, output);
		const listening = output.match(
			/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/i,
		);
		if (listening) {
			endpoint = listening[1];
			break;
		}
		try {
			const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8"))
				.trim()
				.split("\n");
			if (port && path) {
				endpoint = `ws://127.0.0.1:${port}${path}`;
				break;
			}
		} catch {
			// DevTools port file can lag startup markers briefly.
		}
		await delay(100);
	}
	assert(endpoint, `Missing DevTools endpoint after user-extension shell start: ${output}`);

	for (let attempt = 0; attempt < 150; attempt++) {
		if (
			output.includes("KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED") &&
			output.includes("KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY") &&
			output.includes("KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK")
		) {
			break;
		}
		assert.equal(child.exitCode, null, output);
		await delay(100);
	}
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED/, output);
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY/, output);
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_BROWSER_LOAD_OK/, output);

	browser = await chromium.connectOverCDP(endpoint);
	const context = browser.contexts()[0];
	assert(context, "Expected a CDP browser context");

	let shellPage;
	let userPage;
	for (let attempt = 0; attempt < 80; attempt++) {
		const pages = context.pages();
		for (const page of pages) {
			const url = page.url();
			if (!shellPage && (url.includes("kestrel-shell/index.html") || url.startsWith("kestrel://")))
				shellPage = page;
			if (!userPage && url.includes("/probe")) userPage = page;
		}
		if (shellPage && userPage) break;
		await delay(100);
	}
	assert(shellPage, `Privileged shell page missing: ${output}`);
	assert(userPage, `User browser probe page missing: ${output}`);

	assert.equal(await shellPage.evaluate(() => typeof window.kestrel), "object");
	await shellPage.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
	for (let attempt = 0; attempt < 150 && !output.includes("KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK"); attempt++) {
		assert.equal(child.exitCode, null, output);
		await delay(100);
	}
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_CORE_SNAPSHOT_OK/, "The real renderer must receive a Core snapshot.");
	assert.equal(
		await shellPage.evaluate(() => document.documentElement.dataset.kestrelExtensionProbe || ""),
		"",
		"Privileged shell must not receive extension content scripts",
	);

	await userPage.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
	const first = await userPage.evaluate(() =>
		JSON.parse(document.documentElement.dataset.kestrelExtensionProbe),
	);
	assert.equal(first.manifest, 3);
	assert.equal(first.runs, 1);
	assert.match(first.id, /^[a-p]{32}$/);
	assert.equal(await userPage.evaluate(() => typeof window.kestrel), "undefined");

	await userPage.reload();
	await userPage.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
	assert.equal(
		await userPage.evaluate(
			() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe).runs,
		),
		2,
	);

	const evidence = join(root, ".tmp/native-user-extension-evidence");
	await mkdir(evidence, { recursive: true });
	await shellPage.screenshot({ path: join(evidence, "privileged-shell.png") });
	await userPage.screenshot({ path: join(evidence, "user-browser-extension.png") });

	const session = await browser.newBrowserCDPSession();
	await session.send("Browser.close");
	const result = await Promise.race([
		exited,
		delay(15_000, undefined, { ref: false }).then(() => {
			throw new Error(`Native user-extension shell shutdown timed out: ${output}`);
		}),
	]);
	assert.deepEqual(result, { code: 0, signal: null }, output);
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_EXTENSIONS_ENABLED/);
	assert.match(output, /KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY/);
	assert.doesNotMatch(output, /Electron Framework/);
	console.log(
		"Native user extensions passed: privileged shell bridge isolation, MV3 content script on user tabs, storage persistence, and clean shutdown.",
	);
} finally {
	await browser?.close().catch(() => {});
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await new Promise((resolveKill) => child.once("exit", resolveKill));
	}
	await new Promise((resolveClose) => server.close(resolveClose));
	await rm(profile, { recursive: true, force: true });
}
