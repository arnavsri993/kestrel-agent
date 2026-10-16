import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
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
const requireParity = process.argv.includes("--require-extension-parity");
const { createFileChromiumExtensionHostPort } = await tsImport(
	"../apps/desktop/src/main/file-chromium-extension-host-port.ts", import.meta.url,
);

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
const registeredFixture = join(profile, 'extension with "quotes" and spaces');
await cp(fixture, registeredFixture, { recursive: true });
// Verified CRX installs retain a manifest public key. Check that registry IDs
// match Chromium's key-derived identity as well as the unit-tested path case.
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const manifest = JSON.parse(await readFile(join(registeredFixture, "manifest.json"), "utf8"));
manifest.key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
await writeFile(join(registeredFixture, "manifest.json"), JSON.stringify(manifest));
// Register through the real host port rather than passing a fixture on every
// launch. This proves the persisted startup path, not Web Store installation.
const extensionPort = createFileChromiumExtensionHostPort({ profileRoot: profile });
const registeredExtension = await extensionPort.loadExtension(registeredFixture, { allowFileAccess: false });
let blockedRequests = 0;
const server = createServer((request, response) => {
	if (request.url?.startsWith("/kestrel-extension-blocked")) blockedRequests++;
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
let extensionId;
let tabsQuerySupported = true;
try {
	for (let launch = 0; launch < 2; launch++) {
		// Both processes load only the registration written by the actual host port.
		output = "";
		await rm(join(profile, "DevToolsActivePort"), { force: true });
		child = spawn(
			executable,
			[
				"--kestrel-cache-path",
				profile,
				"--kestrel-user-extensions",
				"--kestrel-ephemeral-core",
				"--kestrel-renderer",
				"--kestrel-durable-profile",
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
		assert.match(output, /KESTREL_NATIVE_CHROMIUM_USER_EXTENSION_PATHS count=1/, output);
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
		assert.equal(first.runs, launch === 0 ? 1 : 3, JSON.stringify(first));
		assert.match(first.id, /^[a-p]{32}$/);
		assert.equal(first.id, registeredExtension.id, "The host registry must identify Chromium's actual extension");
		if (launch === 0) extensionId = first.id;
		else assert.equal(first.id, extensionId, "Extension identity must survive restart");
		assert.equal(first.tab.url, first.tab.senderUrl, "chrome.tabs.get must return the actual user page");
		tabsQuerySupported &&= first.tabFound;
		assert.deepEqual(first.scripting, { bridge: "undefined", nativeQuery: "undefined" });
		assert.equal(await userPage.evaluate(() => document.documentElement.dataset.kestrelExtensionScriptInjected), "true");
		assert.equal(await userPage.evaluate(() => typeof window.kestrel), "undefined");
		assert.equal(await userPage.evaluate(async () => {
			try { await fetch("/kestrel-extension-blocked"); return false; }
			catch { return true; }
		}), true, "DNR must block the request, not merely accept a rule");
		assert.equal(blockedRequests, 0, "A blocked request must never reach the server");
		assert.equal(await userPage.evaluate(async () => (await fetch("/kestrel-extension-allowed")).ok), true);

		if (launch === 0) {
			await userPage.reload();
			await userPage.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
			assert.equal(
				await userPage.evaluate(
					() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe).runs,
				),
				2,
			);
		}

		const evidence = join(root, ".tmp/native-user-extension-evidence");
		await mkdir(evidence, { recursive: true });
		await shellPage.screenshot({ path: join(evidence, `privileged-shell-${launch}.png`) });
		// First-run React setup intentionally hides the web plane. In this fixture
		// exercise the same bounded host command used by the browser layout before
		// capturing the real native user view; a zero-sized hidden page is not proof.
		const bounds = await shellPage.evaluate(() => window.kestrel.request({
			type: "browser-set-content-bounds",
			bounds: { x: 16, y: 160, width: 800, height: 500 }, visible: true,
		}));
		assert.equal(bounds.ok, true);
		await userPage.waitForFunction(() => innerWidth > 0 && innerHeight > 0);
		await userPage.screenshot({ path: join(evidence, `user-browser-extension-${launch}.png`) });

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
		await browser.close().catch(() => {});
		browser = undefined;
		child = undefined;
	}
	console.log(
		"Native user extension checks passed: real renderer/Core, MV3 messaging, tabs.get, scripting, actual DNR blocking, bridge isolation, extension identity/storage after a full app restart without reloading the extension, and clean shutdown.",
	);
	const checks = {
		realKestrelRendererAndCore: true,
		mv3ContentScriptsAndWorkerMessaging: true,
		storageAndIdentityAfterAppRestart: true,
		persistedHostPortStartupRegistration: true,
		tabsGet: true,
		scripting: true,
		declarativeNetRequestActuallyBlocks: true,
		privilegedShellIsolation: true,
		tabsQuery: tabsQuerySupported,
		kestrelExtensionManagerInstallAndLiveToggle: false,
		toolbarActionPopups: false,
		chromeWebStoreInstall: false,
		chromeWebStoreUpdates: false,
	};
	const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
	const evidence = join(root, ".tmp/native-user-extension-evidence");
	await writeFile(join(evidence, "compatibility.json"), JSON.stringify({
		version: 1,
		app: resolve(app),
		executableSha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
		checkedAt: new Date().toISOString(),
		checks,
		missing,
		fullExtensionParity: missing.length === 0,
	}, null, 2) + "\n");
	console.log(`Native extension parity ${missing.length === 0 ? "passed" : "BLOCKED"}: ${missing.join(", ") || "all checks passed"}.`);
	if (requireParity) assert.deepEqual(missing, [], "Electron retirement requires complete Chrome extension acceptance; fixture success alone is insufficient.");
} finally {
	await browser?.close().catch(() => {});
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await new Promise((resolveKill) => child.once("exit", resolveKill));
	}
	await new Promise((resolveClose) => server.close(resolveClose));
	await rm(profile, { recursive: true, force: true });
}
