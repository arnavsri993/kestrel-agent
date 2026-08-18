import { describe, expect, it, vi } from "vitest";
import {
	shouldCheckForUpdates,
	startAutomaticUpdates,
	updaterFeedChannel,
} from "./update-channel";

describe("internet update channel", () => {
	it("maps product channels to electron-builder feed names", () => {
		expect(updaterFeedChannel("stable")).toBe("latest");
		expect(updaterFeedChannel("beta")).toBe("beta");
		expect(updaterFeedChannel("development")).toBeUndefined();
	});

	it("never checks from development or an unpackaged process", () => {
		expect(shouldCheckForUpdates(true, "development")).toBe(false);
		expect(shouldCheckForUpdates(false, "stable")).toBe(false);
		expect(shouldCheckForUpdates(true, "stable")).toBe(true);
		expect(shouldCheckForUpdates(true, "stable", true)).toBe(false);
	});

	it("starts a stable check immediately and downloads it for the next quit", async () => {
		const checkForUpdates = vi.fn(() => Promise.resolve(null));
		const subscribeToUpdate = vi.fn();
		const onUpdateDownloaded = vi.fn();
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			checkForUpdates,
		};

		expect(
			startAutomaticUpdates(updater, {
				packaged: true,
				channel: "stable",
				subscribeToUpdate,
				onUpdateDownloaded,
			}),
		).toBe(true);
		await Promise.resolve();

		expect(updater).toMatchObject({
			autoDownload: true,
			autoInstallOnAppQuit: true,
			allowPrerelease: false,
			channel: "latest",
		});
		expect(subscribeToUpdate).toHaveBeenCalledWith(onUpdateDownloaded);
		expect(checkForUpdates).toHaveBeenCalledOnce();
	});

	it("keeps beta builds on GitHub's prerelease channel", async () => {
		const checkForUpdates = vi.fn(() => Promise.resolve(null));
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			checkForUpdates,
		};

		expect(
			startAutomaticUpdates(updater, { packaged: true, channel: "beta" }),
		).toBe(true);
		await Promise.resolve();

		expect(updater).toMatchObject({
			autoDownload: true,
			autoInstallOnAppQuit: true,
			allowPrerelease: true,
			channel: "beta",
		});
		expect(checkForUpdates).toHaveBeenCalledOnce();
	});

	it("does not contact the network from development or when disabled", async () => {
		const checkForUpdates = vi.fn(() => Promise.resolve(null));
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			checkForUpdates,
		};

		expect(
			startAutomaticUpdates(updater, {
				packaged: true,
				channel: "development",
			}),
		).toBe(false);
		expect(
			startAutomaticUpdates(updater, {
				packaged: true,
				channel: "stable",
				updatesDisabled: true,
			}),
		).toBe(false);
		await Promise.resolve();
		expect(checkForUpdates).not.toHaveBeenCalled();
	});
});
