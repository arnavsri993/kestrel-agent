import { describe, expect, it, vi } from "vitest";
import {
	githubUpdateFeed,
	shouldCheckForUpdates,
	startAutomaticUpdates,
	updaterFeedChannel,
} from "./update-channel";
import {
	buildContentFreeDiagnosticEnvelope,
	recordDiagnosticFailure,
} from "./diagnostic-report";

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
		const onCheckFailure = vi.fn();
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
				onCheckFailure,
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
		expect(onCheckFailure).not.toHaveBeenCalled();
	});

	it("reports a failed update check to the content-free diagnostics hook", async () => {
		const checkFailure = new Error(
			"network timeout for https://updates.example.invalid/latest-mac.yml?token=secret",
		);
		const onCheckFailure = vi.fn(recordDiagnosticFailure);
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			setFeedURL: vi.fn(),
			checkForUpdates: vi.fn(() => Promise.reject(checkFailure)),
		};

		expect(
			startAutomaticUpdates(updater, {
				packaged: true,
				channel: "stable",
				onCheckFailure,
			}),
		).toBe(true);
		await vi.waitFor(() => expect(onCheckFailure).toHaveBeenCalledOnce());
		expect(onCheckFailure).toHaveBeenCalledWith(checkFailure);
		const envelope = await buildContentFreeDiagnosticEnvelope();
		expect(envelope.lastFailureClass).toBe("timeout");
		expect(JSON.stringify(envelope)).not.toMatch(/updates\.example|secret/i);
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

	it("records an updater configuration failure without making startup fatal", () => {
		const configurationFailure = new Error("bad packaged config");
		const onCheckFailure = vi.fn();
		const updater = {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			channel: null as string | null,
			setFeedURL: vi.fn(() => {
				throw configurationFailure;
			}),
			checkForUpdates: vi.fn(() => Promise.resolve(null)),
		};

		expect(
			startAutomaticUpdates(updater, {
				packaged: true,
				channel: "stable",
				onCheckFailure,
			}),
		).toBe(false);
		expect(onCheckFailure).toHaveBeenCalledWith(configurationFailure);
		expect(updater.checkForUpdates).not.toHaveBeenCalled();
	});
});
