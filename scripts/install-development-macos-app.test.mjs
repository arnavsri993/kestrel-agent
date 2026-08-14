import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(
	import.meta.dirname,
	"install-development-macos-app.mjs",
);

function createBundle(root, name, identifier = "com.kestrel.desktop.dev") {
	const bundle = join(root, name);
	mkdirSync(join(bundle, "Contents"), { recursive: true });
	writeFileSync(
		join(bundle, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Kestrel</string>
<key>CFBundleDisplayName</key><string>Kestrel</string>
</dict></plist>
`,
	);
	writeFileSync(join(bundle, "Contents", "payload.txt"), name);
	return bundle;
}

function runInstaller(source, installRoot, searchRoots, trashRoot) {
	return execFileSync(process.execPath, [script, source], {
		encoding: "utf8",
		env: {
			...process.env,
			KESTREL_MACOS_INSTALL_ROOT: installRoot,
			KESTREL_MACOS_SEARCH_ROOTS: searchRoots.join(":"),
			KESTREL_MACOS_TRASH_ROOT: trashRoot,
			KESTREL_SKIP_LSREGISTER: "1",
		},
	});
}

const testSuite = process.platform === "darwin" ? describe : describe.skip;

testSuite("development macOS app installer", () => {
	it("keeps one canonical app and trashes duplicates", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-installer-test-"));
		const installRoot = join(root, "Applications");
		const desktopRoot = join(root, "Desktop");
		const trashRoot = join(root, "Trash");
		mkdirSync(installRoot);
		mkdirSync(desktopRoot);

		const sourceRoot = join(root, "release");
		mkdirSync(sourceRoot);
		const source = createBundle(sourceRoot, "Kestrel.app");
		const previous = createBundle(installRoot, "Kestrel.app");
		writeFileSync(join(previous, "Contents", "payload.txt"), "previous");
		const duplicate = createBundle(desktopRoot, "Kestrel 2.app");

		const output = runInstaller(
			source,
			installRoot,
			[installRoot, desktopRoot],
			trashRoot,
		);
		const canonical = join(installRoot, "Kestrel.app");

		expect(output).toContain(`Installed Kestrel at ${canonical}`);
		expect(existsSync(canonical)).toBe(true);
		expect(existsSync(join(canonical, "Contents", "payload.txt"))).toBe(true);
		expect(readPayload(canonical)).toBe("Kestrel.app");
		expect(existsSync(duplicate)).toBe(false);
		expect(existsSync(source)).toBe(true);
		expect(readdirSync(trashRoot)).toHaveLength(2);
	});

	it("is safe to run repeatedly", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-installer-repeat-"));
		const installRoot = join(root, "Applications");
		const trashRoot = join(root, "Trash");
		mkdirSync(installRoot);
		const sourceRoot = join(root, "release");
		mkdirSync(sourceRoot);
		const source = createBundle(sourceRoot, "Kestrel.app");

		runInstaller(source, installRoot, [installRoot], trashRoot);
		runInstaller(source, installRoot, [installRoot], trashRoot);

		expect(readdirSync(installRoot)).toEqual(["Kestrel.app"]);
		expect(readdirSync(trashRoot)).toHaveLength(1);
	});
});

function readPayload(bundle) {
	return readFileSync(join(bundle, "Contents", "payload.txt"), "utf8");
}
