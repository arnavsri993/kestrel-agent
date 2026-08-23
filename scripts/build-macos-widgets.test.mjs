import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMacOSWidgets } from "./build-macos-widgets.mjs";

const macSuite = process.platform === "darwin" ? describe : describe.skip;

macSuite("macOS widget packaging", () => {
	it(
		"builds a signed WidgetKit extension inside an app bundle",
		{ timeout: 20_000 },
		() => {
			const root = mkdtempSync(join(tmpdir(), "kestrel-widget-bundle-test-"));
			try {
				const appPath = join(root, "Kestrel.app");
				mkdirSync(join(appPath, "Contents"), { recursive: true });
				writeFileSync(
					join(appPath, "Contents", "Info.plist"),
					`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>`,
				);

				const appexPath = buildMacOSWidgets({
					appPath,
					architecture: "arm64",
					signIdentity: "-",
				});

				expect(
					existsSync(join(appexPath, "Contents", "MacOS", "KestrelWidgets")),
				).toBe(true);
				expect(existsSync(join(appexPath, "Contents", "Info.plist"))).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
