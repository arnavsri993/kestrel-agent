import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";
import type { KestrelDatabase } from "@kestrel/database";
import type { AgentRuntime } from "./runtime";

export type BrowserAction =
  | { type: "click"; target: string }
  | { type: "type"; target: string; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; x: number; y: number };

export interface BrowserSnapshot { url: string; title: string; accessibilityTree: unknown; }
export interface ScreenshotFrame { width: number; height: number; rgba: Uint8Array; png?: Uint8Array; }
export interface BrowserViewport { name: string; width: number; height: number; deviceScaleFactor?: number; }
export interface BrowserDiagnostic { kind: "console" | "network"; level: "warning" | "error"; message: string; url?: string; timestamp: string; }
export interface BrowserDownload { id: string; filename: string; bytes: number; status: "progressing" | "completed" | "cancelled" | "failed"; sha256?: string; createdAt: string; }
export type DesktopAction = { type: "click"; x: number; y: number } | { type: "type"; text: string } | { type: "key"; key: "Enter" | "Escape" | "Tab" | "Backspace" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" };

export interface BrowserAutomationBackend {
  createSession(input: { allowedOrigins: string[]; isolated: true }): Promise<string>;
  navigate(sessionId: string, url: string, signal: AbortSignal): Promise<void>;
  act(sessionId: string, action: BrowserAction, signal: AbortSignal): Promise<void>;
  snapshot(sessionId: string, signal: AbortSignal): Promise<BrowserSnapshot>;
  screenshot(sessionId: string, signal: AbortSignal): Promise<ScreenshotFrame>;
  setViewport?(sessionId: string, viewport: BrowserViewport, signal: AbortSignal): Promise<void>;
  diagnostics?(sessionId: string, signal: AbortSignal): Promise<BrowserDiagnostic[]>;
  authHandoff?(sessionId: string, visible: boolean, signal: AbortSignal): Promise<void>;
  upload?(sessionId: string, selector: string, paths: string[], signal: AbortSignal): Promise<void>;
  downloads?(sessionId: string, signal: AbortSignal): Promise<BrowserDownload[]>;
  desktopScreenshot?(signal: AbortSignal): Promise<ScreenshotFrame>;
  desktopAct?(action: DesktopAction, signal: AbortSignal): Promise<void>;
  close(sessionId: string): Promise<void>;
}

interface BrowserSessionRecord { id: string; backendSessionId: string; ownerSessionId: string; allowedOrigins: string[]; createdAt: string; }
const MAX_BROWSER_SESSIONS_PER_OWNER = 8;

export class BrowserController {
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  constructor(private readonly backend: BrowserAutomationBackend, private readonly now: () => Date = () => new Date()) {}

  async create(ownerSessionId: string, allowedOrigins: string[]): Promise<{ browserSessionId: string }> {
    if (allowedOrigins.length === 0) throw new Error("Browser sessions require at least one allowed origin.");
    const origins = [...new Set(allowedOrigins.map((value) => {
      const url = new URL(value);
      const loopbackHttp =
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (
        (url.protocol !== "https:" && !loopbackHttp) ||
        url.origin === "null" ||
        url.username ||
        url.password
      )
        throw new Error(
          "Browser origins must use HTTPS except explicit loopback HTTP development origins, and cannot include embedded credentials.",
        );
      return url.origin;
    }))];
    if ([...this.sessions.values()].filter((session) => session.ownerSessionId === ownerSessionId).length >= MAX_BROWSER_SESSIONS_PER_OWNER) {
      throw new Error(`A browser owner can have at most ${MAX_BROWSER_SESSIONS_PER_OWNER} sessions.`);
    }
    const backendSessionId = await this.backend.createSession({ allowedOrigins: origins, isolated: true });
    if ([...this.sessions.values()].filter((session) => session.ownerSessionId === ownerSessionId).length >= MAX_BROWSER_SESSIONS_PER_OWNER) {
      await this.backend.close(backendSessionId).catch(() => undefined);
      throw new Error(`A browser owner can have at most ${MAX_BROWSER_SESSIONS_PER_OWNER} sessions.`);
    }
    const id = `browser-${randomUUID()}`;
    this.sessions.set(id, { id, backendSessionId, ownerSessionId, allowedOrigins: origins, createdAt: this.now().toISOString() });
    return { browserSessionId: id };
  }

  async navigate(ownerSessionId: string, id: string, urlValue: string, signal: AbortSignal): Promise<{ url: string; trust: "untrusted_browser" }> {
    const session = this.require(ownerSessionId, id);
    const url = new URL(urlValue);
    if (!session.allowedOrigins.includes(url.origin)) throw new Error(`Browser navigation to ${url.origin} is outside this session's origin allowlist.`);
    url.username = ""; url.password = ""; url.hash = "";
    await this.backend.navigate(session.backendSessionId, url.toString(), signal);
    return { url: url.toString(), trust: "untrusted_browser" };
  }

  async act(ownerSessionId: string, id: string, action: BrowserAction, signal: AbortSignal): Promise<{ performed: true }> {
    const session = this.require(ownerSessionId, id);
    if ((action.type === "click" || action.type === "type") && (!action.target || action.target.length > 2_000)) throw new Error("Browser action target is invalid.");
    if (action.type === "type" && action.text.length > 20_000) throw new Error("Browser typing is limited to 20,000 characters per action.");
    if (action.type === "scroll" && (![action.x, action.y].every(Number.isFinite) || Math.abs(action.x) > 100_000 || Math.abs(action.y) > 100_000)) throw new Error("Browser scroll exceeds limits.");
    await this.backend.act(session.backendSessionId, action, signal);
    return { performed: true };
  }

  async snapshot(ownerSessionId: string, id: string, signal: AbortSignal): Promise<BrowserSnapshot & { trust: "untrusted_browser" }> {
    const session = this.require(ownerSessionId, id);
    const snapshot = await this.backend.snapshot(session.backendSessionId, signal);
    if (JSON.stringify(snapshot.accessibilityTree).length > 2_000_000) throw new Error("Browser accessibility snapshot exceeds 2 MB.");
    return { ...snapshot, trust: "untrusted_browser" };
  }

  async screenshot(ownerSessionId: string, id: string, signal: AbortSignal): Promise<ScreenshotFrame> {
    const session = this.require(ownerSessionId, id);
    const frame = await this.backend.screenshot(session.backendSessionId, signal);
    if (frame.width < 1 || frame.height < 1 || frame.width * frame.height * 4 !== frame.rgba.byteLength) throw new Error("Browser backend returned an invalid screenshot frame.");
    if (frame.png && frame.png.byteLength > 10_000_000) throw new Error("Browser screenshot exceeds 10 MB.");
    return frame;
  }

  async setViewport(ownerSessionId: string, id: string, viewport: BrowserViewport, signal: AbortSignal): Promise<{ viewport: BrowserViewport }> {
    const session = this.require(ownerSessionId, id);
    if (!this.backend.setViewport) throw new Error("The active browser backend does not support viewport control.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(viewport.name) || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 240 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160) throw new Error("Browser viewport is invalid or outside supported bounds.");
    if (viewport.deviceScaleFactor !== undefined && (!Number.isFinite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor < 0.5 || viewport.deviceScaleFactor > 4)) throw new Error("Browser device scale factor must be between 0.5 and 4.");
    await this.backend.setViewport(session.backendSessionId, viewport, signal);
    return { viewport };
  }

  async diagnostics(ownerSessionId: string, id: string, signal: AbortSignal): Promise<{ diagnostics: BrowserDiagnostic[]; trust: "untrusted_browser" }> {
    const session = this.require(ownerSessionId, id);
    const diagnostics = this.backend.diagnostics ? await this.backend.diagnostics(session.backendSessionId, signal) : [];
    if (diagnostics.length > 2_000 || JSON.stringify(diagnostics).length > 2_000_000) throw new Error("Browser diagnostics exceed safety limits.");
    return { diagnostics, trust: "untrusted_browser" };
  }

  async authHandoff(ownerSessionId: string, id: string, visible: boolean, signal: AbortSignal): Promise<{ visible: boolean }> {
    const session = this.require(ownerSessionId, id);
    if (!this.backend.authHandoff) throw new Error("The active browser backend does not support interactive authentication handoff.");
    await this.backend.authHandoff(session.backendSessionId, visible, signal);
    return { visible };
  }

  async upload(ownerSessionId: string, id: string, selector: string, paths: string[], workspaceRoot: string | undefined, signal: AbortSignal): Promise<{ files: string[] }> {
    const session = this.require(ownerSessionId, id);
    if (!this.backend.upload) throw new Error("The active browser backend does not support file uploads.");
    if (!workspaceRoot || paths.length < 1 || paths.length > 20 || !selector || selector.length > 2_000) throw new Error("Browser upload requires a granted workspace, selector, and 1 to 20 files.");
    const root = realpathSync(workspaceRoot);
    const canonical = paths.map((path) => {
      const candidate = realpathSync(resolve(root, path));
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("Browser upload file escapes the granted workspace.");
      if (!statSync(candidate).isFile() || statSync(candidate).size > 100_000_000) throw new Error("Browser upload requires regular files no larger than 100 MB.");
      return candidate;
    });
    await this.backend.upload(session.backendSessionId, selector, canonical, signal);
    return { files: canonical.map((path) => path.slice(root.length + 1)) };
  }

  async downloads(ownerSessionId: string, id: string, signal: AbortSignal): Promise<{ downloads: BrowserDownload[] }> {
    const session = this.require(ownerSessionId, id);
    if (!this.backend.downloads) throw new Error("The active browser backend does not support controlled downloads.");
    return { downloads: await this.backend.downloads(session.backendSessionId, signal) };
  }

  async desktopScreenshot(signal: AbortSignal): Promise<ScreenshotFrame> {
    if (!this.backend.desktopScreenshot) throw new Error("The active backend does not support whole-desktop capture.");
    const frame = await this.backend.desktopScreenshot(signal);
    if (frame.width < 1 || frame.height < 1 || frame.width * frame.height * 4 !== frame.rgba.byteLength || !frame.png || frame.png.byteLength > 20_000_000) throw new Error("Desktop backend returned an invalid screenshot.");
    return frame;
  }

  async desktopAct(action: DesktopAction, signal: AbortSignal): Promise<{ performed: true }> {
    if (!this.backend.desktopAct) throw new Error("The active backend does not support whole-desktop input.");
    if (action.type === "click" && (!Number.isInteger(action.x) || !Number.isInteger(action.y) || action.x < 0 || action.y < 0 || action.x > 20_000 || action.y > 20_000)) throw new Error("Desktop click coordinates are invalid.");
    if (action.type === "type" && (!action.text || action.text.length > 20_000)) throw new Error("Desktop typing is limited to 20,000 characters.");
    await this.backend.desktopAct(action, signal);
    return { performed: true };
  }

  async close(ownerSessionId: string, id: string): Promise<{ closed: true }> {
    const session = this.require(ownerSessionId, id);
    await this.backend.close(session.backendSessionId);
    this.sessions.delete(id);
    return { closed: true };
  }

  private require(ownerSessionId: string, id: string): BrowserSessionRecord {
    const session = this.sessions.get(id);
    if (!session || session.ownerSessionId !== ownerSessionId) throw new Error("Browser session is unavailable to this agent session.");
    return session;
  }
}

export interface VisualComparison { id: string; baselineSha256: string; actualSha256: string; width: number; height: number; changedPixels: number; differenceRatio: number; passed: boolean; threshold: number; createdAt: string; }

export interface VisualValidationResult extends VisualComparison {
  suite: string;
  viewport: BrowserViewport;
  consoleErrors: number;
  networkErrors: number;
  baselinePath: string;
  actualPath: string;
  diffPath: string;
  diagnosticsPath: string;
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodeRgbaPng(frame: ScreenshotFrame): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(frame.width, 0); header.writeUInt32BE(frame.height, 4);
  header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((frame.width * 4 + 1) * frame.height);
  for (let row = 0; row < frame.height; row += 1) {
    const target = row * (frame.width * 4 + 1); scanlines[target] = 0;
    Buffer.from(frame.rgba.buffer, frame.rgba.byteOffset + row * frame.width * 4, frame.width * 4).copy(scanlines, target + 1);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${label} must use only letters, numbers, dots, dashes, or underscores.`);
  return value;
}

export class VisualValidator {
  private readonly key = "engineering.visual-comparisons";
  private readonly root?: string;
  constructor(private readonly database: KestrelDatabase, artifactRootOrNow?: string | (() => Date), now: () => Date = () => new Date()) {
    this.now = typeof artifactRootOrNow === "function" ? artifactRootOrNow : now;
    if (typeof artifactRootOrNow === "string") {
      mkdirSync(artifactRootOrNow, { recursive: true, mode: 0o700 });
      this.root = realpathSync(artifactRootOrNow);
    }
  }
  private readonly now: () => Date;
  compare(baseline: ScreenshotFrame, actual: ScreenshotFrame, threshold = 0): VisualComparison {
    if (baseline.width !== actual.width || baseline.height !== actual.height) throw new Error("Screenshot dimensions differ; normalize the viewport before comparison.");
    if (threshold < 0 || threshold > 1) throw new Error("Visual threshold must be between 0 and 1.");
    let changedPixels = 0;
    for (let offset = 0; offset < baseline.rgba.length; offset += 4) {
      if (baseline.rgba[offset] !== actual.rgba[offset] || baseline.rgba[offset + 1] !== actual.rgba[offset + 1] || baseline.rgba[offset + 2] !== actual.rgba[offset + 2] || baseline.rgba[offset + 3] !== actual.rgba[offset + 3]) changedPixels += 1;
    }
    const differenceRatio = changedPixels / (baseline.width * baseline.height);
    const comparison: VisualComparison = {
      id: `visual-${randomUUID()}`, baselineSha256: createHash("sha256").update(baseline.rgba).digest("hex"), actualSha256: createHash("sha256").update(actual.rgba).digest("hex"),
      width: actual.width, height: actual.height, changedPixels, differenceRatio, passed: differenceRatio <= threshold, threshold, createdAt: this.now().toISOString()
    };
    this.database.setPrivateState(this.key, [...this.list(), comparison]);
    return comparison;
  }
  list(): VisualComparison[] { return this.database.getPrivateState<VisualComparison[]>(this.key) ?? []; }

  baseline(suiteValue: string, viewport: BrowserViewport, frame: ScreenshotFrame): { baselinePath: string; sha256: string } {
    const directory = this.validationDirectory(suiteValue, viewport.name);
    const baselinePath = resolve(directory, "baseline.png");
    const rgbaPath = resolve(directory, "baseline.rgba");
    writeFileSync(baselinePath, frame.png ?? encodeRgbaPng(frame), { mode: 0o600 });
    writeFileSync(rgbaPath, frame.rgba, { mode: 0o600 });
    writeFileSync(resolve(directory, "baseline.json"), JSON.stringify({ width: frame.width, height: frame.height, sha256: createHash("sha256").update(frame.rgba).digest("hex"), updatedAt: this.now().toISOString() }, null, 2), { mode: 0o600 });
    return { baselinePath, sha256: createHash("sha256").update(frame.rgba).digest("hex") };
  }

  validate(suiteValue: string, viewport: BrowserViewport, actual: ScreenshotFrame, diagnostics: BrowserDiagnostic[], threshold = 0, gates: { consoleErrors?: boolean; networkErrors?: boolean } = {}): VisualValidationResult {
    const directory = this.validationDirectory(suiteValue, viewport.name);
    const metadataPath = resolve(directory, "baseline.json");
    const rgbaPath = resolve(directory, "baseline.rgba");
    if (!existsSync(metadataPath) || !existsSync(rgbaPath)) throw new Error(`Visual baseline is missing for ${suiteValue}/${viewport.name}. Capture an approved baseline first.`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { width: number; height: number };
    const baselineRgba = readFileSync(rgbaPath);
    const baseline: ScreenshotFrame = { width: metadata.width, height: metadata.height, rgba: baselineRgba };
    const comparison = this.compare(baseline, actual, threshold);
    const diff = new Uint8Array(actual.rgba.byteLength);
    for (let offset = 0; offset < actual.rgba.length; offset += 4) {
      const changed = baseline.rgba[offset] !== actual.rgba[offset] || baseline.rgba[offset + 1] !== actual.rgba[offset + 1] || baseline.rgba[offset + 2] !== actual.rgba[offset + 2] || baseline.rgba[offset + 3] !== actual.rgba[offset + 3];
      diff[offset] = changed ? 255 : actual.rgba[offset]! >> 2; diff[offset + 1] = changed ? 0 : actual.rgba[offset + 1]! >> 2; diff[offset + 2] = changed ? 96 : actual.rgba[offset + 2]! >> 2; diff[offset + 3] = 255;
    }
    const actualPath = resolve(directory, "actual.png"); const diffPath = resolve(directory, "diff.png"); const diagnosticsPath = resolve(directory, "diagnostics.json");
    writeFileSync(actualPath, actual.png ?? encodeRgbaPng(actual), { mode: 0o600 });
    writeFileSync(diffPath, encodeRgbaPng({ width: actual.width, height: actual.height, rgba: diff }), { mode: 0o600 });
    writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2), { mode: 0o600 });
    for (const path of [actualPath, diffPath, diagnosticsPath]) chmodSync(path, 0o600);
    const consoleErrors = diagnostics.filter((item) => item.kind === "console" && item.level === "error").length;
    const networkErrors = diagnostics.filter((item) => item.kind === "network" && item.level === "error").length;
    const result: VisualValidationResult = { ...comparison, suite: safeSegment(suiteValue, "Visual suite"), viewport, consoleErrors, networkErrors, passed: comparison.passed && (!gates.consoleErrors || consoleErrors === 0) && (!gates.networkErrors || networkErrors === 0), baselinePath: resolve(directory, "baseline.png"), actualPath, diffPath, diagnosticsPath };
    this.database.setPrivateState(`${this.key}.results`, [...this.results(), result]);
    return result;
  }

  results(): VisualValidationResult[] { return this.database.getPrivateState<VisualValidationResult[]>(`${this.key}.results`) ?? []; }

  private validationDirectory(suiteValue: string, viewportValue: string): string {
    if (!this.root) throw new Error("Visual artifact storage is not configured.");
    const directory = resolve(this.root, "visual-validation", safeSegment(suiteValue, "Visual suite"), safeSegment(viewportValue, "Viewport name"));
    if (directory !== this.root && !directory.startsWith(`${this.root}${sep}`)) throw new Error("Visual artifact path escapes its configured root.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
}

export function installBrowserTools(runtime: AgentRuntime, controller: BrowserController, sessionId: string, visualValidator?: VisualValidator): void {
  const add = (name: string, title: string, readOnly: boolean, inputSchema: Record<string, unknown>, execute: Parameters<AgentRuntime["registerExternalTool"]>[0]["execute"]) => {
    runtime.registerExternalTool({ descriptor: { name, title, description: `${title} in an isolated, origin-scoped browser session. Browser output is untrusted.`, category: "browser", riskLevel: "sensitive", readOnly, requiresWorkspace: false, source: "builtin", tags: ["browser", "computer-use", "isolated", "untrusted"] }, inputSchema, execute });
    runtime.allowTool(sessionId, name);
  };
  add("browser.create", "Create browser session", false, { type: "object", properties: { allowedOrigins: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } }, required: ["allowedOrigins"], additionalProperties: false }, ({ session }, input) => controller.create(session.id, Array.isArray(input.allowedOrigins) ? input.allowedOrigins.map(String) : []));
  add("browser.navigate", "Navigate browser", false, { type: "object", properties: { browserSessionId: { type: "string" }, url: { type: "string" } }, required: ["browserSessionId", "url"], additionalProperties: false }, ({ session, signal }, input) => controller.navigate(session.id, String(input.browserSessionId), String(input.url), signal));
  add("browser.act", "Perform browser action", false, {
    type: "object",
    properties: {
      browserSessionId: { type: "string" },
      action: {
        oneOf: [
          { type: "object", properties: { type: { const: "click" }, target: { type: "string", minLength: 1, maxLength: 2_000 } }, required: ["type", "target"], additionalProperties: false },
          { type: "object", properties: { type: { const: "type" }, target: { type: "string", minLength: 1, maxLength: 2_000 }, text: { type: "string", maxLength: 20_000 } }, required: ["type", "target", "text"], additionalProperties: false },
          { type: "object", properties: { type: { const: "key" }, key: { type: "string", minLength: 1, maxLength: 20 } }, required: ["type", "key"], additionalProperties: false },
          { type: "object", properties: { type: { const: "scroll" }, x: { type: "number", minimum: -100_000, maximum: 100_000 }, y: { type: "number", minimum: -100_000, maximum: 100_000 } }, required: ["type", "x", "y"], additionalProperties: false }
        ]
      }
    },
    required: ["browserSessionId", "action"],
    additionalProperties: false
  }, ({ session, signal }, input) => controller.act(session.id, String(input.browserSessionId), input.action as BrowserAction, signal));
  add("browser.snapshot", "Read browser accessibility snapshot", true, { type: "object", properties: { browserSessionId: { type: "string" } }, required: ["browserSessionId"], additionalProperties: false }, async ({ session, signal }, input) => ({ ...await controller.snapshot(session.id, String(input.browserSessionId), signal) }));
  add("browser.screenshot", "Capture browser screenshot", true, { type: "object", properties: { browserSessionId: { type: "string" } }, required: ["browserSessionId"], additionalProperties: false }, async ({ session, signal }, input) => {
    const frame = await controller.screenshot(session.id, String(input.browserSessionId), signal);
    return { width: frame.width, height: frame.height, pngBase64: frame.png ? Buffer.from(frame.png).toString("base64") : "", trust: "untrusted_browser" };
  });
  add("browser.viewport", "Set browser viewport", false, { type: "object", properties: { browserSessionId: { type: "string" }, viewport: { type: "object", properties: { name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }, width: { type: "integer", minimum: 240, maximum: 3840 }, height: { type: "integer", minimum: 240, maximum: 2160 }, deviceScaleFactor: { type: "number", minimum: 0.5, maximum: 4 } }, required: ["name", "width", "height"], additionalProperties: false } }, required: ["browserSessionId", "viewport"], additionalProperties: false }, ({ session, signal }, input) => controller.setViewport(session.id, String(input.browserSessionId), input.viewport as BrowserViewport, signal));
  add("browser.diagnostics", "Read browser diagnostics", true, { type: "object", properties: { browserSessionId: { type: "string" } }, required: ["browserSessionId"], additionalProperties: false }, ({ session, signal }, input) => controller.diagnostics(session.id, String(input.browserSessionId), signal));
  add("browser.auth-handoff", "Hand browser to user for authentication", false, { type: "object", properties: { browserSessionId: { type: "string" }, visible: { type: "boolean" } }, required: ["browserSessionId", "visible"], additionalProperties: false }, ({ session, signal }, input) => controller.authHandoff(session.id, String(input.browserSessionId), Boolean(input.visible), signal));
  runtime.registerExternalTool({ descriptor: { name: "browser.upload", title: "Upload workspace files", description: "Set a browser file input to bounded files contained by the current granted workspace.", category: "browser", riskLevel: "sensitive", readOnly: false, requiresWorkspace: true, source: "builtin", tags: ["browser", "upload", "files", "workspace"] }, inputSchema: { type: "object", properties: { browserSessionId: { type: "string" }, selector: { type: "string", minLength: 1, maxLength: 2_000 }, paths: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 4_000 } } }, required: ["browserSessionId", "selector", "paths"], additionalProperties: false }, execute: ({ session, signal, workspaceRoot }, input) => controller.upload(session.id, String(input.browserSessionId), String(input.selector), Array.isArray(input.paths) ? input.paths.map(String) : [], workspaceRoot, signal) });
  runtime.allowTool(sessionId, "browser.upload");
  add("browser.downloads", "List controlled browser downloads", true, { type: "object", properties: { browserSessionId: { type: "string" } }, required: ["browserSessionId"], additionalProperties: false }, ({ session, signal }, input) => controller.downloads(session.id, String(input.browserSessionId), signal));
  add("computer.screenshot", "Capture whole desktop", true, { type: "object", properties: {}, additionalProperties: false }, async ({ signal }) => { const frame = await controller.desktopScreenshot(signal); return { width: frame.width, height: frame.height, pngBase64: Buffer.from(frame.png!).toString("base64"), trust: "untrusted_desktop" }; });
  add("computer.act", "Control whole desktop", false, { type: "object", properties: { action: { oneOf: [{ type: "object", properties: { type: { const: "click" }, x: { type: "integer", minimum: 0, maximum: 20_000 }, y: { type: "integer", minimum: 0, maximum: 20_000 } }, required: ["type", "x", "y"], additionalProperties: false }, { type: "object", properties: { type: { const: "type" }, text: { type: "string", minLength: 1, maxLength: 20_000 } }, required: ["type", "text"], additionalProperties: false }, { type: "object", properties: { type: { const: "key" }, key: { enum: ["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] } }, required: ["type", "key"], additionalProperties: false }] } }, required: ["action"], additionalProperties: false }, ({ signal }, input) => controller.desktopAct(input.action as DesktopAction, signal));
  if (visualValidator) add("visual.validate-matrix", "Validate responsive visual matrix", false, {
    type: "object",
    properties: {
      browserSessionId: { type: "string" },
      suite: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      viewports: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: { name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }, width: { type: "integer", minimum: 240, maximum: 3840 }, height: { type: "integer", minimum: 240, maximum: 2160 }, deviceScaleFactor: { type: "number", minimum: 0.5, maximum: 4 } }, required: ["name", "width", "height"], additionalProperties: false } },
      updateBaselines: { type: "boolean" }, threshold: { type: "number", minimum: 0, maximum: 1 }, failOnConsoleErrors: { type: "boolean" }, failOnNetworkErrors: { type: "boolean" }
    },
    required: ["browserSessionId", "suite", "viewports", "updateBaselines", "threshold"], additionalProperties: false
  }, async ({ session, signal, progress }, input) => {
    const browserSessionId = String(input.browserSessionId); const suite = String(input.suite); const viewports = input.viewports as BrowserViewport[]; const updateBaselines = Boolean(input.updateBaselines); const threshold = Number(input.threshold);
    const results: VisualValidationResult[] = [];
    for (const viewport of viewports) {
      await controller.setViewport(session.id, browserSessionId, viewport, signal);
      const frame = await controller.screenshot(session.id, browserSessionId, signal);
      const { diagnostics } = await controller.diagnostics(session.id, browserSessionId, signal);
      if (updateBaselines) visualValidator.baseline(suite, viewport, frame);
      const result = visualValidator.validate(suite, viewport, frame, diagnostics, threshold, { consoleErrors: Boolean(input.failOnConsoleErrors), networkErrors: Boolean(input.failOnNetworkErrors) });
      results.push(result); progress({ viewport: viewport.name, passed: result.passed, differenceRatio: result.differenceRatio, consoleErrors: result.consoleErrors, networkErrors: result.networkErrors });
    }
    return { suite, passed: results.every((result) => result.passed), results };
  });
  add("browser.close", "Close browser session", false, { type: "object", properties: { browserSessionId: { type: "string" } }, required: ["browserSessionId"], additionalProperties: false }, ({ session }, input) => controller.close(session.id, String(input.browserSessionId)));
}
