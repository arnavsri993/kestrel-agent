#!/usr/bin/env node

/**
 * Write electron-updater-compatible latest-mac.yml for native Chromium
 * DMG + ZIP artifacts (no electron-builder / blockmap).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hashArtifact(path) {
	const bytes = readFileSync(path);
	return {
		bytes: bytes.byteLength,
		sha512: createHash("sha512").update(bytes).digest("base64"),
	};
}

export function renderLatestMacYml({
	version,
	dmgPath,
	zipPath,
	releaseDate = new Date().toISOString(),
}) {
	if (!version) throw new Error("version is required");
	const dmgName = basename(dmgPath);
	const zipName = basename(zipPath);
	const dmg = hashArtifact(dmgPath);
	const zip = hashArtifact(zipPath);
	return [
		`version: ${version}`,
		`files:`,
		`  - url: ${dmgName}`,
		`    sha512: ${dmg.sha512}`,
		`    size: ${dmg.bytes}`,
		`  - url: ${zipName}`,
		`    sha512: ${zip.sha512}`,
		`    size: ${zip.bytes}`,
		`path: ${zipName}`,
		`sha512: ${zip.sha512}`,
		`releaseDate: '${releaseDate}'`,
		``,
	].join("\n");
}

export function writeNativeLatestMac({
	releaseRoot = join(root, "release"),
	version = JSON.parse(
		readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
	).version,
	releaseDate = new Date().toISOString(),
} = {}) {
	const dmgPath = join(releaseRoot, `Kestrel-Apple-Silicon-${version}.dmg`);
	const zipPath = join(releaseRoot, `Kestrel-Apple-Silicon-${version}.zip`);
	if (!existsSync(dmgPath))
		throw new Error(`Native DMG missing at ${dmgPath}`);
	if (!existsSync(zipPath))
		throw new Error(`Native ZIP missing at ${zipPath}`);
	const body = renderLatestMacYml({
		version,
		dmgPath,
		zipPath,
		releaseDate,
	});
	const out = join(releaseRoot, "latest-mac.yml");
	writeFileSync(out, body, { mode: 0o644 });
	return out;
}

function isDirectExecution() {
	const entry = process.argv[1];
	return Boolean(
		entry && pathToFileURL(resolve(entry)).href === import.meta.url,
	);
}

if (isDirectExecution()) {
	const out = writeNativeLatestMac({
		releaseRoot: resolve(process.argv[2] ?? join(root, "release")),
	});
	console.log(`Wrote native Chromium updater feed at ${out}`);
}
