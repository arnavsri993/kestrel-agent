import { describe, expect, it, vi } from "vitest";
import { SystemReadinessSchema } from "@kestrel/shared-types";
import { NATIVE_READINESS_REQUEST_TYPES, nativeSystemReadiness } from "./native-readiness";

const now = new Date("2026-10-01T12:00:00.000Z");
function fixture() {
	const coreRequest = vi.fn(async (request: { type: string }): Promise<unknown> => request.type === "snapshot"
		? { ok: true, snapshot: {} } : { ok: true, providers: [{ id: "auto" }, { id: "ollama" }] });
	const workspaceConfiguration = vi.fn(async (): Promise<unknown> => ({ workspaceRoots: ["/project"], configuredWorkspaceRoots: ["/project"] }));
	const localStatus = vi.fn(async (): Promise<unknown> => ({ ok: true, localRuntime: { automaticSupported: false, managedRuntime: false, ollamaAvailable: true, source: "external", runtimeDownloadBytes: 1, localModels: [{ name: "local:test", size: 1 }], verifiedModel: "local:test", verifiedAt: "2026-09-30T12:00:00.000Z" } }));
	const computerUseStatus = vi.fn(async (): Promise<unknown> => ({ enabled: false, platform: "darwin", screenRecording: "not-determined", accessibility: "not-granted", captureReady: false, controlReady: false, checkedAt: now.toISOString() }));
	return { coreRequest, workspaceConfiguration, localStatus, computerUseStatus, now: () => now };
}
const check = (readiness: Awaited<ReturnType<typeof nativeSystemReadiness>>, id: string) => readiness.checks.find(item => item.id === id)!;

describe("native system readiness", () => {
	it("returns schema-valid live Core, route, workspace and historical local verification evidence without a model request", async () => {
		const input = fixture();
		const result = await nativeSystemReadiness(input);
		expect(SystemReadinessSchema.safeParse(result).success).toBe(true);
		expect(NATIVE_READINESS_REQUEST_TYPES.has("system-readiness")).toBe(true);
		expect(check(result, "core").status).toBe("pass");
		expect(check(result, "models")).toMatchObject({ status: "warning", detail: expect.stringContaining("1 model route is configured") });
		expect(check(result, "workspace").status).toBe("pass");
		expect(check(result, "local-model").detail).toContain("previously verified at 2026-09-30");
		expect(result.readyForLiveWork).toBe(false);
		expect(result.backupScope).toBe("native-core-data");
		expect(check(result, "backup").status).toBe("warning");
		expect(check(result, "distribution").status).toBe("fail");
		expect(check(result, "computer-use").detail).toContain("Disabled by default");
		expect(input.coreRequest.mock.calls.map(([request]) => request.type)).toEqual(["snapshot", "runtime-list-providers"]);
	});
	it("distinguishes a created backup receipt from a fresh content or restore check", async () => {
		const backupStatus = vi.fn(async () => ({ verified: true, createdAt: "2026-09-30T12:00:00.000Z" }));
		const result = await nativeSystemReadiness({ ...fixture(), backupStatus });
		expect(check(result, "backup")).toMatchObject({ status: "pass", detail: expect.stringContaining("did not re-read its contents or test restoration") });
		expect(result.readyForLiveWork).toBe(false);
		backupStatus.mockResolvedValue({ verified: true, createdAt: "2030-01-01T00:00:00.000Z" });
		expect(check(await nativeSystemReadiness({ ...fixture(), backupStatus }), "backup").status).toBe("warning");
		backupStatus.mockRejectedValue(new Error("unavailable"));
		expect(check(await nativeSystemReadiness({ ...fixture(), backupStatus }), "backup").status).toBe("warning");
	});
	it("reports permission probes without claiming a completed action", async () => {
		const input = fixture();
		input.computerUseStatus.mockResolvedValue({ enabled: true, platform: "darwin", screenRecording: "granted", accessibility: "granted", captureReady: true, controlReady: true, checkedAt: now.toISOString() });
		const result = await nativeSystemReadiness(input);
		expect(check(result, "computer-use")).toMatchObject({ status: "pass", detail: expect.stringContaining("not proof of a completed desktop action") });
	});
	it("handles a disconnected Core without interpreting unavailable routes as empty", async () => {
		const input = fixture(); input.coreRequest.mockRejectedValue(new Error("down"));
		const result = await nativeSystemReadiness(input);
		expect(check(result, "core").status).toBe("fail");
		expect(check(result, "models").detail).toContain("could not be checked");
		expect(input.coreRequest).toHaveBeenCalledTimes(1);
	});
	it("reports missing configured folders and zero routes", async () => {
		const input = fixture();
		input.coreRequest.mockImplementation(async request => request.type === "snapshot" ? { ok: true, snapshot: {} } : { ok: true, providers: [{ id: "auto" }] });
		input.workspaceConfiguration.mockResolvedValue({ workspaceRoots: [], configuredWorkspaceRoots: ["/missing"] });
		const result = await nativeSystemReadiness(input);
		expect(check(result, "models").status).toBe("fail");
		expect(check(result, "workspace").detail).toContain("1 configured folder is unavailable");
	});
	it("treats malformed provider lists, workspace probes and local results as unknown", async () => {
		const input = fixture();
		input.coreRequest.mockImplementation(async request => request.type === "snapshot" ? { ok: true, snapshot: {} } : { ok: true, providers: [{ id: "ollama" }, {}] });
		input.workspaceConfiguration.mockResolvedValue({ workspaceRoots: ["/unexpected"], configuredWorkspaceRoots: [] });
		input.localStatus.mockResolvedValue({ ok: true, localRuntime: { ollamaAvailable: true } });
		const result = await nativeSystemReadiness(input);
		for (const id of ["models", "workspace", "local-model"]) expect(check(result, id).detail).toContain("could not be checked");
	});
	it("does not report stale, disconnected, or future local verification as current", async () => {
		const input = fixture();
		input.localStatus.mockResolvedValue({ ok: true, localRuntime: { automaticSupported: false, managedRuntime: false, ollamaAvailable: true, source: "external", runtimeDownloadBytes: 1, localModels: [], verifiedModel: "local:test", verifiedAt: "2030-01-01T00:00:00.000Z" } });
		expect(check(await nativeSystemReadiness(input), "local-model").detail).toContain("No previously verified selected model");
	});
});
