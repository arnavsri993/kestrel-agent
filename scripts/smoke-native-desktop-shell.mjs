#!/usr/bin/env node

/**
 * Product-path desktop shell smoke against the native Chromium/CEF host.
 * Uses Playwright CDP (not Electron) so this gate does not require electron packages.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";
import {
	openKestrelDestination,
	selectSettingsSection,
} from "./desktop-browser-test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.KESTREL_NATIVE_TEST_APP
	? resolve(process.env.KESTREL_NATIVE_TEST_APP)
	: await buildNativeChromiumHost();
const executable = join(app, "Contents", "MacOS", "Kestrel");
const profile = await mkdtemp(
	join(tmpdir(), "kestrel-native-desktop-shell-"),
);

async function availableDebugPort() {
	const server = createPortServer();
	await new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	await new Promise((resolvePromise) => server.close(resolvePromise));
	return address.port;
}

const debugPort = await availableDebugPort();
let output = "";
const child = spawn(
	executable,
	[
		"--kestrel-cache-path",
		profile,
		"--kestrel-ephemeral-core",
		"--kestrel-renderer",
		`--remote-debugging-port=${debugPort}`,
		"--remote-debugging-address=127.0.0.1",
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

let inspector;
try {
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(
			() =>
				rejectPromise(
					new Error(`Timed out waiting for native desktop shell: ${output}`),
				),
			45_000,
		);
		const ready = () =>
			output.includes("KESTREL_NATIVE_CHROMIUM_HOST_READY") &&
			output.includes("KESTREL_NATIVE_CHROMIUM_RENDERER_BRIDGE_READY") &&
			output.includes("KESTREL_NATIVE_CHROMIUM_CORE_READY");
		const check = () => {
			if (ready()) {
				clearTimeout(timeout);
				resolvePromise();
			}
		};
		child.stdout.on("data", check);
		child.stderr.on("data", check);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		child.once("exit", (code) => {
			if (!ready()) {
				clearTimeout(timeout);
				rejectPromise(
					new Error(`Native Chromium host exited ${code}: ${output}`),
				);
			}
		});
		check();
	});

	inspector = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
		timeout: 15_000,
	});
	const pages = inspector.contexts().flatMap((context) => context.pages());
	const page = pages.find((candidate) => candidate.url() === "kestrel://app/index.html");
	assert(page, `Native desktop shell page missing. URLs: ${pages.map((p) => p.url()).join(", ")}`);

	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor({ timeout: 20_000 });
	await page.locator('summary[aria-label="Task settings"]').click();
	const taskSettings = page.locator(".task-settings[open]");
	await taskSettings.locator(".runtime-project-picker select").waitFor();
	await taskSettings.getByText(/Auto routes model, thinking level/).waitFor();
	await page.getByRole("button", { name: /^Model:/ }).click();
	const modelMenu = page.getByRole("dialog", {
		name: "Choose a provider, account, model, and thinking level",
	});
	await modelMenu.waitFor();
	await modelMenu.getByText("Account", { exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await modelMenu.waitFor({ state: "detached" });

	await openKestrelDestination(page, "Settings");
	await selectSettingsSection(page, "general", "General");
	await page.getByText("Communication style", { exact: true }).waitFor();
	await page.getByText("Run at login", { exact: true }).waitFor();

	const snapshot = await page.evaluate(async () => {
		const result = await window.kestrel.request({ type: "snapshot" });
		if (!result.ok) throw new Error(result.error ?? "snapshot failed");
		return result;
	});
	assert.equal(snapshot.ok, true);

	assert.match(
		output,
		/KESTREL_NATIVE_CHROMIUM_HOST_READY pid=\d+ credential_storage=disabled background_networking=disabled/,
	);
	assert.doesNotMatch(output, /\belectron\b/i);

	console.log(
		"Native Chromium desktop shell: CDP shell UI, settings, and Core bridge smoke passed without Electron.",
	);
} finally {
	await inspector?.close().catch(() => {});
	if (child.exitCode === null) child.kill("SIGTERM");
	await new Promise((resolvePromise) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolvePromise();
			return;
		}
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolvePromise();
		}, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolvePromise();
		});
	});
	await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
