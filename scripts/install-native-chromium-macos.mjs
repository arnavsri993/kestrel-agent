#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the packaged native CEF host side-by-side as
 * `/Applications/Kestrel Native.app` by default. Canonical replacement of
 * `/Applications/Kestrel.app` requires KESTREL_INSTALL_NATIVE_CANONICAL=1 after
 * parity gates are explicitly accepted.
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
	console.warn(
		"Installing native Chromium as the canonical Kestrel.app. Confirm Electron retirement gates before treating this as the only supported desktop runtime.",
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
