import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BrowserExtensionManager,
	extractCrxOrZip,
	parseExtensionIdFromUrlOrId,
} from "./browser-extension-manager";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-ext-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("parseExtensionIdFromUrlOrId", () => {
	it("parses extension ID from full Chrome Web Store URLs", () => {
		expect(
			parseExtensionIdFromUrlOrId(
				"https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm",
			),
		).toBe("cjpalhdlnbpafiamejdnhcphjbkeiagm");

		expect(
			parseExtensionIdFromUrlOrId(
				"https://chrome.google.com/webstore/detail/bitwarden-password-manage/nngceckbapebfimnlniiiahkandclblb?hl=en",
			),
		).toBe("nngceckbapebfimnlniiiahkandclblb");
	});

	it("parses raw extension IDs", () => {
		expect(
			parseExtensionIdFromUrlOrId("cjpalhdlnbpafiamejdnhcphjbkeiagm"),
		).toBe("cjpalhdlnbpafiamejdnhcphjbkeiagm");
	});

	it("returns null for invalid inputs", () => {
		expect(parseExtensionIdFromUrlOrId("not-a-valid-id")).toBeNull();
		expect(parseExtensionIdFromUrlOrId("")).toBeNull();
	});
});

describe("BrowserExtensionManager", () => {
	it("installs, lists, toggles, and uninstalls unpacked extensions", async () => {
		const tempBase = createTempDir();
		const extensionDir = join(tempBase, "my-extension");
		mkdirSync(extensionDir, { recursive: true });

		writeFileSync(
			join(extensionDir, "manifest.json"),
			JSON.stringify({
				manifest_version: 3,
				name: "Custom Ad Blocker",
				version: "1.2.0",
				description: "Blocks annoying ads and trackers.",
			}),
			"utf8",
		);

		const manager = new BrowserExtensionManager(tempBase);
		expect(manager.list()).toEqual([]);

		const installed = await manager.installFromUnpacked(extensionDir);
		expect(installed).toMatchObject({
			name: "Custom Ad Blocker",
			version: "1.2.0",
			description: "Blocks annoying ads and trackers.",
			enabled: true,
			source: "unpacked",
		});

		expect(manager.list()).toHaveLength(1);

		// Toggle off
		const toggledOff = await manager.toggle(installed.id, false);
		expect(toggledOff.enabled).toBe(false);
		expect(manager.list()[0]?.enabled).toBe(false);

		// Toggle back on
		const toggledOn = await manager.toggle(installed.id, true);
		expect(toggledOn.enabled).toBe(true);

		// Re-instantiating manager restores persisted state
		const reloadedManager = new BrowserExtensionManager(tempBase);
		expect(reloadedManager.list()).toHaveLength(1);
		expect(reloadedManager.list()[0]?.name).toBe("Custom Ad Blocker");

		// Uninstall
		await manager.uninstall(installed.id);
		expect(manager.list()).toEqual([]);
	});
});
