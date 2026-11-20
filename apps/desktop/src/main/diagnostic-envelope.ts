/** Only explicitly validated, content-free scalars can enter the report. */
export interface DiagnosticMetadata {
 appVersion?: unknown;
 platform?: unknown;
 arch?: unknown;
 runtime?: unknown;
 node?: unknown;
 electron?: unknown;
 packaged?: unknown;
 distribution?: unknown;
 readiness?: { readyForLiveWork?: unknown; checks?: Array<{ status?: unknown }> };
 lastFailureClass?: unknown;
 lastFailureAt?: unknown;
}
export interface ContentFreeDiagnosticEnvelope {
 version: 1;
 generatedAt: string;
 appVersion: string;
 platform: string;
 arch: string;
 runtime?: "electron" | "native-chromium";
 node?: string;
 electron?: string;
 packaged: boolean;
 distribution: "developer" | "signed" | "unknown";
 readinessSummary?: { readyForLiveWork: boolean; pass: number; warning: number; fail: number };
 lastFailureClass?: string;
 lastFailureAt?: string;
 note: string;
}
const version = (value: unknown): string | undefined => typeof value === "string" && value.length <= 64 && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,4})?)?$/i.test(value) ? value : undefined;
const platforms = new Set(["darwin", "linux", "win32", "freebsd", "openbsd", "aix", "sunos"]);
const architectures = new Set(["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"]);
const failures = new Set(["cancelled", "timeout", "network", "permission", "distribution", "runtime"]);
export function buildDiagnosticEnvelope(input: DiagnosticMetadata): ContentFreeDiagnosticEnvelope {
 const runtime = input.runtime === "electron" || input.runtime === "native-chromium" ? input.runtime : undefined;
 const node = version(input.node);
 const electron = runtime === "electron" ? version(input.electron) : undefined;
 const failure = typeof input.lastFailureClass === "string" && failures.has(input.lastFailureClass) ? input.lastFailureClass : undefined;
 const failureAt = failure && typeof input.lastFailureAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.lastFailureAt) && Number.isFinite(Date.parse(input.lastFailureAt)) ? input.lastFailureAt : undefined;
 const checks = Array.isArray(input.readiness?.checks) ? input.readiness.checks.slice(0, 1000) : [];
 return {
  version: 1, generatedAt: new Date().toISOString(), appVersion: version(input.appVersion) ?? "unknown",
  platform: typeof input.platform === "string" && platforms.has(input.platform) ? input.platform : "unknown",
  arch: typeof input.arch === "string" && architectures.has(input.arch) ? input.arch : "unknown",
  ...(runtime ? { runtime } : {}), ...(node ? { node } : {}), ...(electron ? { electron } : {}),
  packaged: input.packaged === true,
  distribution: input.distribution === "developer" || input.distribution === "signed" ? input.distribution : "unknown",
  ...(input.readiness ? { readinessSummary: { readyForLiveWork: input.readiness.readyForLiveWork === true,
   pass: checks.filter(check => check?.status === "pass").length,
   warning: checks.filter(check => check?.status === "warning").length,
   fail: checks.filter(check => check?.status === "fail").length } } : {}),
  ...(failure ? { lastFailureClass: failure } : {}), ...(failureAt ? { lastFailureAt: failureAt } : {}),
  note: "Content-free local diagnostic envelope. No prompts, page content, credentials, file paths, or personal memory are included. Share only after review.",
 };
}
