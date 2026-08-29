import { describe, expect, it, vi } from "vitest";
import {
	githubUpdateFeed,
	shouldCheckForUpdates,
	startAutomaticUpdates,
	updaterFeedChannel,
} from "./update-channel";

describe("internet update channel", () => {
	it("maps product channels to electron-builder feed names", () => {
		expect(updaterFeedChannel("stable")).toBe("latest");
		expect(updaterFeedChannel("development")).toBeUndefined();
	});

	it("pins the stable feed to the public Kestrel GitHub repository", () => {
		expect(githubUpdateFeed()).toEqual({
			provider: "github",
			owner: "arnavsri993",
			repo: "kestrel-agent",
			releaseType: "release",
			channel: "latest",
		});
	});

	it("never checks from development or an unpackaged process", () => {
		expect(shouldCheckForUpdates(true, "development")).toBe(false);
		expect(shouldCheckForUpdates(false, "stable")).toBe(false);
		expect(shouldCheckForUpdates(true, "stable")).toBe(true);
		expect(shouldCheckForUpdates(true, "stable", true)).toBe(false);
	});

	it("starts a non-blocking stable check and downloads it for the next quit", async () => {
		const checkForUpdates = vi.fn(() => Promise.resolve(null));
		const setFeedURL = vi.fn();
		const subscribeToUpdate = vi.fn();
		const onUpdateDownloaded = vi.fn();
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: true,
			channel: null as string | null,
			setFeedURL,
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
		expect(checkForUpdates).not.toHaveBeenCalled();
		expect(setFeedURL).toHaveBeenCalledWith(githubUpdateFeed());
		expect(updater).toMatchObject({
			autoDownload: true,
			autoInstallOnAppQuit: true,
			allowPrerelease: false,
			channel: "latest",
		});
		expect(subscribeToUpdate).toHaveBeenCalledWith(onUpdateDownloaded);

		await Promise.resolve();
		expect(checkForUpdates).toHaveBeenCalledOnce();
	});

	it("does not contact GitHub from development or when disabled", async () => {
		const checkForUpdates = vi.fn(() => Promise.resolve(null));
		const setFeedURL = vi.fn();
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			setFeedURL,
			checkForUpdates,
		};

		expect(
			startAutomaticUpdates(updater, {
				packaged: false,
				channel: "stable",
			}),
		).toBe(false);
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
		expect(setFeedURL).not.toHaveBeenCalled();
		expect(checkForUpdates).not.toHaveBeenCalled();
	});

	it("treats an updater configuration failure as non-fatal", () => {
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			setFeedURL: vi.fn(() => {
				throw new Error("bad packaged config");
			}),
			checkForUpdates: vi.fn(() => Promise.resolve(null)),
		};

		expect(
			startAutomaticUpdates(updater, {
				packaged: true,
				channel: "stable",
			}),
		).toBe(false);
		expect(updater.checkForUpdates).not.toHaveBeenCalled();
	});
});
