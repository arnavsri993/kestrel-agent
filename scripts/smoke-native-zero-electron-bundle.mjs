#!/usr/bin/env node

/**
 * Prove a packaged native Chromium Kestrel.app has zero Electron frameworks /
 * helpers on the runnable bundle path (retirement Dock evidence, Linux-safe
 * when KESTREL_NATIVE_TEST_APP points at a copied .app tree).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const app = resolve(
	process.env.KESTREL_NATIVE_TEST_APP ??
		"release/native-mac-arm64/Kestrel.app",
);

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		out.push(path);
		if (statSync(path).isDirectory()) walk(path, out);
	}
	return out;
}

assert.ok(existsSync(app), `Native app missing at ${app}`);
const executable = join(app, "Contents", "MacOS", "Kestrel");
assert.ok(existsSync(executable), `Native executable missing at ${executable}`);

const frameworks = join(app, "Contents", "Frameworks");
assert.ok(
	existsSync(join(frameworks, "Chromium Embedded Framework.framework")),
	"Packaged app must embed Chromium Embedded Framework.framework",
);

const paths = walk(app);
const electronHits = paths.filter((path) =>
	/Electron\.framework|Electron Helper|electron\.asar|app\.asar\.unpacked\/electron/i.test(
		path,
	),
);
assert.equal(
	electronHits.length,
	0,
	`Packaged native app still contains Electron residue:\n${electronHits.join("\n")}`,
);

const info = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
assert.match(info, /CFBundleExecutable[\s\S]*<string>Kestrel<\/string>/);
assert.doesNotMatch(info, /Electron/i);
assert.ok(
	existsSync(join(app, "Contents", "Resources", "agent-core")),
	"Agent Core sidecar must ship inside the native Chromium bundle",
);

console.log(
	`verify:zero-electron-bundle ok — ${app} is CEF-hosted with no Electron.framework`,
);
