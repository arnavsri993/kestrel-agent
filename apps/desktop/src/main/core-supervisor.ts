import { EventEmitter } from "node:events";
import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import { AgentStreamEventSchema, BackgroundJobsEventSchema, CoreResponseSchema, RuntimeEventSchema, type CoreRequest, type CoreResponse } from "@kestrel/shared-types";
import type { BrowserBackendWireRequest } from "./electron-browser-service";

interface WireResponse { requestId: string; response: unknown }

export class CoreSupervisor extends EventEmitter {
  private child: UtilityProcess | undefined;
  private pending = new Map<string, { resolve: (value: CoreResponse) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private requestNumber = 0;
  private restarts = 0;
  private stopping = false;
  private readonly browserRequests = new Map<string, AbortController>();

  constructor(private readonly browserHandler?: (request: BrowserBackendWireRequest, signal: AbortSignal) => Promise<unknown>, private readonly closeBrowsers?: () => Promise<void>) { super(); }

  async start(config: { databasePath: string; encryptionKeyBase64: string; workspaceRoots: string[]; pluginRoots: string[]; managedPluginRoots: string[]; learnedSkillRoot: string; secureEnvironment: NodeJS.ProcessEnv }): Promise<void> {
    this.stopping = false;
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !["OPENAI_API_KEY", "OPENAI_API_KEY_SECONDARY", "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_SECONDARY", "GEMINI_API_KEY", "BRAVE_SEARCH_API_KEY", "GITHUB_TOKEN", "HONCHO_API_KEY", "FAL_KEY", "KESTREL_REMOTE_TARGETS", "KESTREL_GOOGLE_WORKSPACE_OAUTH"].includes(key))) as Record<string, string>;
    const child = utilityProcess.fork(join(__dirname, "utility.js"), [], { serviceName: "Kestrel Agent Core", env: inheritedEnvironment });
    this.child = child;
    child.on("message", (message) => this.onMessage(message as WireResponse));
    child.on("exit", (code) => this.onExit(code));
    child.postMessage({ type: "bootstrap", config });
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { this.off("start-error", onError); resolve(); };
      const onError = (error: Error) => { this.off("ready", onReady); reject(error); };
      this.once("ready", onReady);
      this.once("start-error", onError);
      setTimeout(() => onError(new Error("Agent Core did not become ready within 10 seconds.")), 10000).unref();
    });
  }

  request(request: CoreRequest): Promise<CoreResponse> {
    if (!this.child) return Promise.reject(new Error("Agent Core is unavailable."));
    const requestId = `core-${++this.requestNumber}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Agent Core request timed out."));
      }, request.type === "media-transcribe" ? 125000 : 15000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.child?.postMessage({ type: "request", requestId, request });
    });
  }

  private onMessage(message: WireResponse | { type: "ready" } | { type: "start-error"; error: string } | { type: "runtime-event"; event: unknown } | { type: "agent-stream"; event: unknown } | { type: "background-jobs"; event: unknown } | { type: "automation-error"; error: string } | { type: "browser-backend-request"; requestId: string; request: BrowserBackendWireRequest } | { type: "browser-backend-cancel"; requestId: string }): void {
    if ("type" in message && message.type === "ready") { this.restarts = 0; this.emit("ready"); return; }
    if ("type" in message && message.type === "start-error") { this.emit("start-error", new Error(message.error)); return; }
    if ("type" in message && message.type === "runtime-event") { this.emit("runtime-event", RuntimeEventSchema.parse(message.event)); return; }
    if ("type" in message && message.type === "agent-stream") { this.emit("agent-stream", AgentStreamEventSchema.parse(message.event)); return; }
    if ("type" in message && message.type === "background-jobs") { this.emit("background-jobs", BackgroundJobsEventSchema.parse(message.event)); return; }
    if ("type" in message && message.type === "automation-error") { this.emit("automation-error", new Error(message.error)); return; }
    if ("type" in message && message.type === "browser-backend-cancel") { this.browserRequests.get(message.requestId)?.abort(new Error("Browser operation cancelled.")); return; }
    if ("type" in message && message.type === "browser-backend-request") {
      if (!this.browserHandler || !this.child) { this.child?.postMessage({ type: "browser-backend-response", requestId: message.requestId, ok: false, error: "Browser backend is unavailable." }); return; }
      const controller = new AbortController();
      this.browserRequests.set(message.requestId, controller);
      void this.browserHandler(message.request, controller.signal)
        .then((result) => this.child?.postMessage({ type: "browser-backend-response", requestId: message.requestId, ok: true, result }))
        .catch((error) => this.child?.postMessage({ type: "browser-backend-response", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : "Browser backend failed." }))
        .finally(() => this.browserRequests.delete(message.requestId));
      return;
    }
    if (!("requestId" in message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    pending.resolve(CoreResponseSchema.parse(message.response));
  }

  private onExit(code: number | null): void {
    this.child = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(new Error("Agent Core stopped before responding.")); }
    this.pending.clear();
    for (const controller of this.browserRequests.values()) controller.abort(new Error("Agent Core stopped."));
    this.browserRequests.clear();
    void this.closeBrowsers?.();
    if (this.stopping || code === 0) return;
    this.restarts += 1;
    this.emit("crash", { code, restarts: this.restarts });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.browserRequests.values()) controller.abort(new Error("Agent Core is stopping."));
    this.browserRequests.clear();
    await this.closeBrowsers?.();
    const child = this.child;
    if (!child) return;
    child.postMessage({ type: "shutdown" });
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once("exit", finish);
      const timeout = setTimeout(() => { child.kill(); finish(); }, 2000);
      timeout.unref();
    });
  }
}
