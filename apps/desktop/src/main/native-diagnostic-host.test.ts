import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeDiagnosticHost, NATIVE_DIAGNOSTIC_REQUEST_TYPES } from "./native-diagnostic-host";

const roots: string[] = [];
const hosts: NativeDiagnosticHost[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "diagnostic-host-")); roots.push(path); return path; }
const request = { type: "export-diagnostic-report" };
const metadata = { appVersion: "1.2.3", platform: "darwin", arch: "arm64", runtime: "native-chromium", node: "24.1.0", packaged: true, readiness: { readyForLiveWork: true, checks: [{ status: "pass" }, { status: "warning" }, { status: "fail" }] } };
function host(selectSaveFile: (signal: AbortSignal) => Promise<string | null>, value: unknown = metadata) {
 const diagnosticMetadata = vi.fn(async () => value as typeof metadata);
 const instance = new NativeDiagnosticHost({ selectSaveFile, diagnosticMetadata }); hosts.push(instance); return { instance, diagnosticMetadata };
}
afterEach(async () => { await Promise.all(hosts.splice(0).map(item => item.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("native diagnostic host", () => {
 it("saves only bounded safe metadata in a private file and returns no contents or path", async () => {
  const folder = await root(); const path = join(folder, "report.json");
  const { instance } = host(async () => path, { ...metadata, appVersion: "1.2.3/secret", node: "token-xyz", electron: "99.0.0", rawError: "credential", readiness: { readyForLiveWork: true, checks: [{ status: "pass", path: folder }, { status: "secret" }] } });
  const result = await instance.handle(request);
  expect(result).toEqual({ ok: true, diagnosticReportSaved: true });
  const report = JSON.parse(await readFile(path, "utf8"));
  expect(report).toMatchObject({ appVersion: "unknown", runtime: "native-chromium", readinessSummary: { pass: 1, warning: 0, fail: 0 } });
  expect(JSON.stringify(report)).not.toMatch(/credential|token-xyz|99\.0\.0|secret|diagnostic-host-/);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
 });
 it("rejects caller-supplied paths, blobs and extra keys before opening a panel", async () => {
  const picker = vi.fn(async () => null); const { instance, diagnosticMetadata } = host(picker);
  expect([...NATIVE_DIAGNOSTIC_REQUEST_TYPES]).toEqual([request.type]);
  for (const raw of [null, {}, { ...request, path: "/tmp/injected" }, { ...request, report: "private" }]) expect(await instance.handle(raw)).toEqual({ ok: false, error: "Invalid diagnostic report request." });
  expect(picker).not.toHaveBeenCalled(); expect(diagnosticMetadata).not.toHaveBeenCalled();
 });
 it("refuses an existing file or symlink and preserves its contents", async () => {
  const folder = await root(); const existing = join(folder, "existing"); const link = join(folder, "link");
  await writeFile(existing, "preserved"); await symlink(existing, link);
  for (const path of [existing, link]) {
   const { instance } = host(async () => path); const result = await instance.handle(request);
   expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(folder);
  }
  expect(await readFile(existing, "utf8")).toBe("preserved");
 });
 it("cancels a disconnected panel and ignores its late selection", async () => {
  const folder = await root(); const path = join(folder, "late"); const picker = deferred<string | null>(); const started = deferred<AbortSignal>();
  const { instance } = host(signal => { started.resolve(signal); return picker.promise; });
  const controller = new AbortController(); const result = instance.handle(request, controller.signal); const signal = await started.promise;
  expect(await instance.handle(request)).toEqual({ ok: false, error: "Another diagnostic export is already in progress." });
  controller.abort(); expect(signal.aborted).toBe(true); expect(await result).toEqual({ ok: true, cancelled: true });
  picker.resolve(path); await Promise.resolve(); await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
 });
 it("closes while metadata is pending, never opens a panel, and ignores the late result", async () => {
  const pending = deferred<typeof metadata>(); const picker = vi.fn(async () => null);
  const instance = new NativeDiagnosticHost({ selectSaveFile: picker, diagnosticMetadata: () => pending.promise }); hosts.push(instance);
  const result = instance.handle(request); await Promise.resolve(); await instance.close();
  expect(await result).toEqual({ ok: true, cancelled: true }); pending.resolve(metadata); await Promise.resolve();
  expect(picker).not.toHaveBeenCalled();
 });
});
