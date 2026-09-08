import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	systemPreferences: {},
}));

import { ComputerUseManager } from "./computer-use";

describe("computer-use preference and native permission status", () => {
	it("defaults off, persists atomically, and reports non-prompting permission state", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		const settingsPath = join(root, "nested", "computer-use.json");
		let screenRecording: unknown = "not-determined";
		let accessibility = false;
		const probe = {
			screenRecording: () => screenRecording,
			accessibility: () => accessibility,
		};

		try {
			const manager = new ComputerUseManager(settingsPath, {
				platform: "darwin",
				now: () => "2026-09-02T12:00:00.000Z",
				permissionProbe: probe,
			});

			expect(await manager.load()).toEqual({ version: 1, enabled: false });
			expect(await manager.status()).toMatchObject({
				enabled: false,
				screenRecording: "not-determined",
				accessibility: "not-granted",
				captureReady: false,
				controlReady: false,
			});

			await manager.setEnabled(true);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				version: 1,
				enabled: true,
			});

			screenRecording = "granted";
			accessibility = true;
			expect(await manager.status()).toMatchObject({
				enabled: true,
				screenRecording: "granted",
				accessibility: "granted",
				captureReady: true,
				controlReady: true,
				checkedAt: "2026-09-02T12:00:00.000Z",
			});

			const restarted = new ComputerUseManager(settingsPath, {
				platform: "darwin",
				permissionProbe: probe,
			});
			expect((await restarted.load()).enabled).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports native permission surfaces as unavailable off macOS", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		try {
			const manager = new ComputerUseManager(join(root, "settings.json"), {
				platform: "linux",
			});
			expect(await manager.status()).toMatchObject({
				platform: "linux",
				screenRecording: "unavailable",
				accessibility: "unavailable",
				captureReady: false,
				controlReady: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not leave the in-memory preference enabled when persistence fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		const blocker = join(root, "not-a-directory");
		writeFileSync(blocker, "block");
		try {
			const manager = new ComputerUseManager(join(blocker, "settings.json"), {
				platform: "darwin",
				permissionProbe: {
					screenRecording: () => "granted",
					accessibility: () => true,
				},
			});

			await expect(manager.setEnabled(true)).rejects.toThrow();
			expect((await manager.status()).enabled).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
