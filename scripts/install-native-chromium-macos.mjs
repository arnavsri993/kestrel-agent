#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the packaged native CEF host. The Chromium-primary product path
 * (`pnpm install:mac:dev`) sets KESTREL_INSTALL_NATIVE_CANONICAL=1 so the
 * canonical Dock app is `/Applications/Kestrel.app`. Without that flag, this
 * script installs side-by-side as `/Applications/Kestrel Native.app`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
	process.argv[2] ?? join(root, "release", "native-mac-arm64", "Kestrel.app"),
);
const installRoot = resolve(process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications");
const canonical = process.env.KESTREL_INSTALL_NATIVE_CANONICAL === "1";
const destination = join(
	installRoot,
	canonical ? "Kestrel.app" : "Kestrel Native.app",
);

if (!existsSync(source)) {
	throw new Error(
		`Native Chromium package missing at ${source}. Run corepack pnpm package:mac:native first.`,
	);
}

if (canonical) {
	console.log(
		"Installing native Chromium as the canonical /Applications/Kestrel.app.",
	);
	const result = spawnSync(
		process.execPath,
		[join(root, "scripts", "install-development-macos-app.mjs"), source],
		{
			stdio: "inherit",
			env: {
				...process.env,
				KESTREL_MACOS_INSTALL_ROOT: installRoot,
			},
		},
	);
	process.exit(result.status ?? 1);
}

const ditto = spawnSync(
	"/usr/bin/ditto",
	["--rsrc", "--extattr", "--acl", source, destination],
	{ stdio: "inherit" },
);
if (ditto.status !== 0)
	throw new Error("Could not install the side-by-side native Chromium app.");
console.log(`Installed native Chromium side-by-side at ${destination}.`);
