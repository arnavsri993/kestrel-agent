#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Routes desktop development to the native Chromium host by default.
 * Set KESTREL_DESKTOP_RUNTIME=electron for the legacy Electron watcher.
 * The Chromium lane never opens the Electron Application Support profile.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "chromium").toLowerCase();

if (runtime === "chromium" || runtime === "native") {
	const child = spawn(
		process.execPath,
		[
			join(root, "scripts", "dev-native-chromium-host.mjs"),
			"--user-extensions",
			"--durable",
		],
		{ stdio: "inherit", cwd: root, env: process.env },
	);
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		process.exit(code ?? 1);
	});
} else if (runtime === "electron") {
	const child = spawn(
		"corepack",
		["pnpm", "--filter", "@kestrel/desktop", "dev"],
		{ stdio: "inherit", cwd: root, env: process.env, shell: false },
	);
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		process.exit(code ?? 1);
	});
} else {
	console.error(
		`Unknown KESTREL_DESKTOP_RUNTIME=${runtime}. Use chromium or electron.`,
	);
	process.exit(1);
}
