import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { buildDiagnosticEnvelope, type DiagnosticMetadata } from "./diagnostic-envelope";
import { NativePrivateFileError, writeNativePrivateFile } from "./native-private-file";
export { NATIVE_DIAGNOSTIC_REQUEST_TYPES } from "./native-diagnostic-requests";

const Request = z.object({ type: z.literal("export-diagnostic-report") }).strict();
type Response = { ok: true; diagnosticReportSaved: true } | { ok: true; cancelled: true } | { ok: false; error: string };
interface Options {
 selectSaveFile(signal: AbortSignal): Promise<string | null>;
 diagnosticMetadata(): Promise<DiagnosticMetadata>;
}
class Cancelled extends Error {}
const validPath = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && Buffer.byteLength(path, "utf8") <= 4096 &&
 !/[\u0000-\u001f\u007f-\u009f]/u.test(path) && basename(path) !== "." && basename(path) !== "..";

/** The selected path and report remain in the host and never reach the renderer. */
export class NativeDiagnosticHost {
 private closed = false;
 private readonly abort = new AbortController();
 private active: Promise<Response> | undefined;
 constructor(private readonly options: Options) {}
 handle(raw: unknown, externalSignal?: AbortSignal): Promise<Response> {
  if (!Request.safeParse(raw).success) return Promise.resolve({ ok: false, error: "Invalid diagnostic report request." });
  if (this.closed) return Promise.resolve({ ok: false, error: "Diagnostic export is closed." });
  if (this.active) return Promise.resolve({ ok: false, error: "Another diagnostic export is already in progress." });
  const signal = externalSignal ? AbortSignal.any([this.abort.signal, externalSignal]) : this.abort.signal;
  const check = () => { if (this.closed || signal.aborted) throw new Cancelled(); };
  const external = async <T>(callback: () => Promise<T>): Promise<T> => {
   check(); let onAbort!: () => void;
   const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new Cancelled()); signal.addEventListener("abort", onAbort, { once: true }); });
   try { const result = await Promise.race([callback(), interrupted]); check(); return result; }
   finally { signal.removeEventListener("abort", onAbort); }
  };
  const operation: Promise<Response> = Promise.resolve().then(async (): Promise<Response> => {
   const metadata = await external(() => this.options.diagnosticMetadata());
   const { note: _note, ...report } = buildDiagnosticEnvelope(metadata);
   const data = Buffer.from(JSON.stringify(report, null, 2) + "\n", "utf8");
   const selected = await external(() => this.options.selectSaveFile(signal));
   if (selected === null) return { ok: true, cancelled: true };
   if (!validPath(selected)) throw new Error("Invalid path.");
   const parent = await realpath(dirname(selected)); check();
   const path = join(parent, basename(selected));
   if (!validPath(path)) throw new Error("Invalid path.");
   await writeNativePrivateFile(path, parent, data, check, error => error instanceof Cancelled);
   return { ok: true, diagnosticReportSaved: true };
  }).catch((error: unknown): Response => {
   if (error instanceof Cancelled) return { ok: true, cancelled: true };
   if (error instanceof NativePrivateFileError && error.created) return { ok: false, error: "The new diagnostic report was preserved and may be incomplete. Choose a different filename to retry." };
   return { ok: false, error: "The diagnostic report could not be saved. Choose a new filename in an existing writable folder." };
  });
  this.active = operation;
  void operation.then(() => { if (this.active === operation) this.active = undefined; });
  return operation;
 }
 async close(): Promise<void> { this.closed = true; this.abort.abort(); await this.active; }
}
