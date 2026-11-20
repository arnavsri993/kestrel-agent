import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeComputerUseManager, type NativeComputerUsePlatform } from "./native-computer-use";
import { RendererRequestSchema } from "@kestrel/shared-types";
import { NATIVE_READINESS_REQUEST_TYPES } from "./native-readiness";
import { dispatchNativeComputerHostRequest } from "../../../../apps/native-chromium-host/resources/native-computer-host-routing.mjs";

const identity = {
	displayId: 1, logicalBounds: { x: 0, y: 0, width: 100, height: 80 },
	foregroundProcessId: 10, frontmostWindowId: 20,
	frontmostWindowBounds: { x: 0, y: 0, width: 100, height: 80 },
};
const capture = (capturedAt = "2026-01-01T00:00:00.000Z") => ({
	...identity, width: 100, height: 80, capturedAt,
	pngBase64: Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(50)).toString("base64"),
});
const permissions = { screenRecording: "granted", accessibility: "granted" };
function fixture(now = Date.parse("2026-01-01T00:00:00.000Z")) {
	let time = now;
	const root = mkdtempSync(join(tmpdir(), "kestrel-native-computer-"));
	const hooks = {
		permissions: vi.fn(async () => permissions),
		capture: vi.fn(async () => capture()),
		currentIdentity: vi.fn(async () => identity),
		act: vi.fn(async () => {}),
		openSettings: vi.fn(async () => {}),
	} satisfies NativeComputerUsePlatform;
	const manager = new NativeComputerUseManager(join(root, "computer-use.json"), hooks, () => time);
	return { root, hooks, manager, setNow: (value: number) => { time = value; } };
}

describe("native whole-desktop computer use", () => {
	it("routes disabled status and disable requests through the native host contract without capture", async () => {
		const { root, hooks, manager } = fixture();
		try {
			for (const request of [{ type: "computer-use-status" }, { type: "computer-use-update", enabled: false }]) {
				const parsed = RendererRequestSchema.safeParse(request);
				expect(parsed.success).toBe(true);
				if (!parsed.success) continue;
				expect(NATIVE_READINESS_REQUEST_TYPES.has(parsed.data.type)).toBe(true);
				await expect(dispatchNativeComputerHostRequest(manager, parsed.data)).resolves.toMatchObject({ ok: true, computerUseStatus: { enabled: false } });
			}
			expect(hooks.permissions).toHaveBeenCalled();
			expect(hooks.capture).not.toHaveBeenCalled();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("defaults disabled and rejects capture/action before platform capture", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await expect(manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal)).rejects.toThrow(/disabled/);
			expect(hooks.capture).not.toHaveBeenCalled();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("requires granted permissions and consumes the matching capture once", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await manager.setEnabled(true);
			const frame = await manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal) as { captureId: string };
			const action = { type: "click" as const, x: 10, y: 10, captureId: frame.captureId };
			await manager.handleBackendRequest({ operation: "desktop-act", action }, new AbortController().signal);
			expect(hooks.act).toHaveBeenCalledTimes(1);
			await expect(manager.handleBackendRequest({ operation: "desktop-act", action }, new AbortController().signal)).rejects.toThrow(/matching fresh/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("does not capture when the nonprompting permission probe is denied", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await manager.setEnabled(true);
			hooks.permissions.mockResolvedValue({ screenRecording: "denied", accessibility: "denied" });
			await expect(manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal)).rejects.toThrow(/Screen Recording permission is denied/);
			expect(hooks.capture).not.toHaveBeenCalled();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("reports macOS 13 capture as unavailable and never claims control readiness", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await manager.setEnabled(true);
			hooks.permissions.mockResolvedValue({ screenRecording: "unavailable", accessibility: "granted" });
			expect(await manager.status()).toMatchObject({ enabled: true, screenRecording: "unavailable", accessibility: "granted", captureReady: false, controlReady: false });
			await expect(manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal)).rejects.toThrow(/macOS 14 or newer/);
			expect(hooks.capture).not.toHaveBeenCalled();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("disables immediately and stays disabled in memory when preference persistence fails", async () => {
		const { root, hooks, manager } = fixture();
		const settingsPath = join(root, "computer-use.json");
		try {
			writeFileSync(settingsPath, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
			expect((await manager.load()).enabled).toBe(true);
			unlinkSync(settingsPath);
			mkdirSync(settingsPath, { mode: 0o700 });
			const disabling = manager.setEnabled(false);
			await expect(manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal)).rejects.toThrow(/disabled/);
			await expect(disabling).rejects.toThrow(/disabled for this run, but the preference could not be saved/);
			await expect(dispatchNativeComputerHostRequest(manager, { type: "computer-use-update", enabled: false })).resolves.toMatchObject({
				ok: false, error: expect.stringContaining("disabled for this run, but the preference could not be saved"),
			});
			await expect(dispatchNativeComputerHostRequest(manager, { type: "computer-use-status" })).resolves.toMatchObject({ ok: true, computerUseStatus: { enabled: false } });
			expect(hooks.capture).not.toHaveBeenCalled();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("does not let an older pending capture replace a newer one", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await manager.setEnabled(true);
			let resolveOld!: (value: ReturnType<typeof capture>) => void;
			const oldCapture = new Promise<ReturnType<typeof capture>>(resolve => { resolveOld = resolve; });
			hooks.capture.mockReturnValueOnce(oldCapture).mockResolvedValueOnce(capture());
			const older = manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal);
			const newer = await manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal) as { captureId: string };
			resolveOld(capture());
			await expect(older).rejects.toThrow(/superseded/);
			await expect(manager.handleBackendRequest({ operation: "desktop-act", action: { type: "key", key: "Enter", captureId: newer.captureId } }, new AbortController().signal)).resolves.toEqual({ performed: true });
			expect(hooks.act).toHaveBeenCalledTimes(1);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("reports uncertain outcome if disable races with action submission", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await manager.setEnabled(true);
			const frame = await manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal) as { captureId: string };
			let finish!: () => void;
			let started!: () => void;
			const actStarted = new Promise<void>(resolve => { started = resolve; });
			hooks.act.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; started(); }));
			const pending = manager.handleBackendRequest({ operation: "desktop-act", action: { type: "key", key: "Enter", captureId: frame.captureId } }, new AbortController().signal);
			await actStarted;
			const disabled = manager.setEnabled(false);
			const uncertain = expect(pending).rejects.toMatchObject({ outcomeUncertain: true });
			finish();
			await disabled;
			await uncertain;
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects stale, mismatched, and changed-window captures", async () => {
		const { root, manager, setNow } = fixture();
		try {
			await manager.setEnabled(true);
			const stale = await manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal) as { captureId: string };
			setNow(Date.parse("2026-01-01T00:00:31.000Z"));
			await expect(manager.handleBackendRequest({ operation: "desktop-act", action: { type: "key", key: "Enter", captureId: stale.captureId } }, new AbortController().signal)).rejects.toThrow(/expired/);
		} finally { rmSync(root, { recursive: true, force: true }); }
		const second = fixture();
		try {
			await second.manager.setEnabled(true);
			await second.manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal);
			await expect(second.manager.handleBackendRequest({ operation: "desktop-act", action: { type: "click", x: 3, y: 3, captureId: "00000000-0000-4000-8000-000000000000" } }, new AbortController().signal)).rejects.toThrow(/matching fresh/);
			const fresh = await second.manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal) as { captureId: string };
			second.hooks.currentIdentity.mockResolvedValue({ ...identity, frontmostWindowId: 21 });
			await expect(second.manager.handleBackendRequest({ operation: "desktop-act", action: { type: "click", x: 3, y: 3, captureId: fresh.captureId } }, new AbortController().signal)).rejects.toThrow(/changed since/);
			expect(second.hooks.act).not.toHaveBeenCalled();
		} finally { rmSync(second.root, { recursive: true, force: true }); }
	});

	it("does not trust a symlinked enabled preference", async () => {
		const { root, manager } = fixture();
		try {
			const outside = join(root, "outside.json");
			writeFileSync(outside, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
			symlinkSync(outside, join(root, "computer-use.json"));
			expect((await manager.load()).enabled).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("invalidates unused capture authority when the Core or native owner resets", async () => {
		const { root, hooks, manager } = fixture();
		try {
			await manager.setEnabled(true);
			const frame = await manager.handleBackendRequest({ operation: "desktop-screenshot" }, new AbortController().signal) as { captureId: string };
			manager.invalidate();
			await expect(manager.handleBackendRequest({ operation: "desktop-act", action: { type: "key", key: "Enter", captureId: frame.captureId } }, new AbortController().signal)).rejects.toThrow(/matching fresh/);
			expect(hooks.act).not.toHaveBeenCalled();
			expect((await manager.status()).enabled).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("bounds preference reads and keeps malformed startup state disabled until an explicit change", async () => {
		const { root, manager } = fixture();
		try {
			const setting = join(root, "computer-use.json");
			writeFileSync(setting, " ".repeat(4096) + JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
			expect((await manager.load()).enabled).toBe(false);
			writeFileSync(setting, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
			expect((await manager.status()).enabled).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("does not trust linked or nonprivate enabled preferences", async () => {
		const { root, manager } = fixture();
		try {
			const setting = join(root, "computer-use.json");
			writeFileSync(setting, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
			linkSync(setting, join(root, "hardlink.json"));
			expect((await manager.load()).enabled).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
		const second = fixture();
		try {
			const setting = join(second.root, "computer-use.json");
			writeFileSync(setting, JSON.stringify({ version: 1, enabled: true }), { mode: 0o644 });
			chmodSync(setting, 0o644);
			expect((await second.manager.load()).enabled).toBe(false);
		} finally { rmSync(second.root, { recursive: true, force: true }); }
	});
});
