import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../runtime";
import { readBoundedResponseBytes } from "../bounded-http";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

type JsonRpcId = string | number;
export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export interface McpTransport {
  send(message: JsonRpcMessage): void | Promise<void>;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  close(): void | Promise<void>;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("MCP client timeout must be a finite positive integer.");
  }
  return timeoutMs;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class StreamableHttpMcpTransport implements McpTransport {
  private readonly events = new EventEmitter();
  private readonly url: URL;
  private sessionId: string | undefined;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(endpoint: string, private readonly options: { authorization?: string; fetcher?: typeof fetch } = {}) {
    try { this.url = new URL(endpoint); } catch { throw new Error("MCP HTTP endpoints require credential-free HTTPS or loopback HTTP."); }
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(this.url.hostname);
    if ((this.url.protocol !== "https:" && !(this.url.protocol === "http:" && loopback)) || this.url.username || this.url.password || this.url.hash) throw new Error("MCP HTTP endpoints require credential-free HTTPS or loopback HTTP.");
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP HTTP transport is closed.");
    const response = await (this.options.fetcher ?? fetch)(this.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(this.options.authorization ? { authorization: this.options.authorization } : {})
      },
      body: JSON.stringify(message)
    });
    if (!response.ok) throw new Error(`MCP HTTP request failed with ${response.status}.`);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    if (response.status === 202 || !response.body) return;
    const bytes = await readBoundedResponseBytes(response, 1_000_000, "MCP HTTP response exceeded 1 MB.");
    const text = Buffer.from(bytes).toString("utf8");
    const contentType = response.headers.get("content-type") ?? "";
    const payloads = contentType.includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())).filter((value) => value && value !== "[DONE]")
      : [text];
    for (const payload of payloads) this.events.emit("message", JSON.parse(payload) as JsonRpcMessage);
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.events.on("message", listener); return () => this.events.off("message", listener); }
  onError(listener: (error: Error) => void): () => void { this.events.on("transport-error", listener); return () => this.events.off("transport-error", listener); }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      try {
        if (this.sessionId) await (this.options.fetcher ?? fetch)(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...(this.options.authorization ? { authorization: this.options.authorization } : {}) } });
      } finally {
        this.events.removeAllListeners();
      }
    })();
    return this.closePromise;
  }
}

export class StdioMcpTransport implements McpTransport {
  private static readonly MAX_MESSAGE_BYTES = 1_000_000;
  private static readonly MAX_STDERR_RECORD_BYTES = 1_000_000;
  private static readonly MAX_STDERR_BURST_BYTES = 1_000_000;
  private static readonly STDERR_BURST_WINDOW_MS = 1_000;
  private readonly events = new EventEmitter();
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderrRecordBytes = 0;
  private stderrBurstBytes = 0;
  private stderrBurstUpdatedAt = Date.now();
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(config: { command: string; args?: string[]; cwd: string; environment?: Record<string, string> }) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", LANG: process.env.LANG ?? "en_US.UTF-8", ...config.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      this.buffer += chunk.toString("utf8");
      if (Buffer.byteLength(this.buffer) > StdioMcpTransport.MAX_MESSAGE_BYTES) {
        this.child.kill("SIGTERM");
        this.reportError(new Error("MCP stdio message exceeded 1 MB."));
        return;
      }
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.events.emit("message", JSON.parse(line) as JsonRpcMessage); }
        catch {
          this.child.kill("SIGTERM");
          this.reportError(new Error("MCP server wrote invalid JSON to stdout."));
          return;
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      for (let offset = 0; offset < chunk.byteLength; offset += 1) {
        if (chunk[offset] === 0x0a) this.stderrRecordBytes = 0;
        else this.stderrRecordBytes += 1;
        if (
          this.stderrRecordBytes >
          StdioMcpTransport.MAX_STDERR_RECORD_BYTES
        ) {
          this.child.kill("SIGTERM");
          this.reportError(
            new Error("MCP server stderr record exceeded 1 MB."),
          );
          return;
        }
      }
      const now = Date.now();
      const elapsed = Math.max(0, now - this.stderrBurstUpdatedAt);
      this.stderrBurstUpdatedAt = now;
      this.stderrBurstBytes =
        Math.max(
          0,
          this.stderrBurstBytes -
            elapsed *
              (StdioMcpTransport.MAX_STDERR_BURST_BYTES /
                StdioMcpTransport.STDERR_BURST_WINDOW_MS),
        ) + chunk.byteLength;
      if (
        this.stderrBurstBytes >
        StdioMcpTransport.MAX_STDERR_BURST_BYTES
      ) {
        this.child.kill("SIGTERM");
        this.reportError(
          new Error("MCP server stderr burst exceeded 1 MB per second."),
        );
      }
    });
    this.child.once("error", (error) => this.reportError(new Error(`MCP stdio server failed: ${error.message}`)));
    this.child.once("exit", (code, signal) => {
      if (!this.closing && !this.failure) this.reportError(new Error(`MCP stdio server exited unexpectedly (${signal ?? code ?? "unknown"}).`));
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing) this.reportError(new Error(`MCP stdio input failed: ${error.message}`));
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closing || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error("MCP stdio transport is closed.");
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > StdioMcpTransport.MAX_MESSAGE_BYTES) throw new Error("MCP stdio message exceeds 1 MB.");
    if (encoded.includes("\n")) throw new Error("MCP stdio messages must be newline-delimited single-line JSON.");
    await new Promise<void>((resolvePromise, reject) => {
      this.child.stdin.write(`${encoded}\n`, (error) => error ? reject(error) : resolvePromise());
    });
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.on("transport-error", listener);
    if (this.failure) queueMicrotask(() => listener(this.failure!));
    return () => this.events.off("transport-error", listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        await new Promise<void>((resolvePromise) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(terminate);
            clearTimeout(force);
            this.child.off("exit", finish);
            resolvePromise();
          };
          const terminate = setTimeout(() => this.child.kill("SIGTERM"), 1_000);
          const force = setTimeout(() => { this.child.kill("SIGKILL"); finish(); }, 2_000);
          terminate.unref();
          force.unref();
          this.child.once("exit", finish);
          this.child.stdin.end();
        });
      } finally {
        this.events.removeAllListeners();
      }
    })();
    return this.closePromise;
  }

  private reportError(error: Error): void {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.events.emit("transport-error", error);
  }
}

export class McpClient {
  private static readonly MAX_PAGINATION_PAGES = 100;
  private readonly pending = new Map<JsonRpcId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
    cleanup(): void;
  }>();
  private nextId = 0;
  private initialized = false;
  private unsubscribeMessage: (() => void) | undefined;
  private unsubscribeError: (() => void) | undefined;
  private failure?: Error;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly timeoutMs: number;

  constructor(private readonly transport: McpTransport, timeoutMs = 30_000) {
    this.timeoutMs = validateTimeout(timeoutMs);
    this.unsubscribeMessage = transport.onMessage((message) => this.receive(message));
    this.unsubscribeError = transport.onError((error) => this.fail(error));
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "kestrel", title: "Kestrel", version: "0.1.0", description: "Local-first personal agent" }
    });
    const negotiated = String((result as Record<string, unknown>).protocolVersion ?? "");
    if (negotiated !== MCP_PROTOCOL_VERSION) throw new Error(`Unsupported MCP protocol version ${negotiated}.`);
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
    return result as Record<string, unknown>;
  }

  async listTools(): Promise<McpTool[]> {
    this.requireInitialized();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > McpClient.MAX_PAGINATION_PAGES) throw new Error("MCP tools/list pagination exceeded 100 pages.");
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as Record<string, unknown>;
      if (!Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid tool array.");
      for (const raw of result.tools) {
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object") throw new Error("MCP server returned an invalid tool descriptor.");
        tools.push({
          name: tool.name,
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.outputSchema && typeof tool.outputSchema === "object" ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
          ...(tool.annotations && typeof tool.annotations === "object" ? { annotations: tool.annotations as Record<string, unknown> } : {})
        });
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    this.requireInitialized();
    return await this.request("tools/call", { name, arguments: args }, signal) as McpToolResult;
  }

  async listResources(): Promise<Array<Record<string, unknown>>> { return this.paginatedList("resources/list", "resources"); }
  async listResourceTemplates(): Promise<Array<Record<string, unknown>>> { return this.paginatedList("resources/templates/list", "resourceTemplates"); }
  async readResource(uri: string): Promise<Record<string, unknown>> { this.requireInitialized(); return await this.request("resources/read", { uri }) as Record<string, unknown>; }
  async listPrompts(): Promise<Array<Record<string, unknown>>> { return this.paginatedList("prompts/list", "prompts"); }
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<Record<string, unknown>> { this.requireInitialized(); return await this.request("prompts/get", { name, arguments: args }) as Record<string, unknown>; }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.unsubscribeMessage?.();
    this.unsubscribeError?.();
    this.unsubscribeMessage = undefined;
    this.unsubscribeError = undefined;
    this.rejectPending(new Error("MCP client closed."));
    this.closePromise = (async () => { await this.transport.close(); })();
    return this.closePromise;
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP client is closed."));
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        const pending = this.takePending(id);
        if (!pending) return;
        pending.reject(this.abortError(signal!));
        void this.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "Cancelled by Kestrel" }
        }).catch(() => undefined);
      };
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        if (!pending) return;
        void this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Request timeout" } }).catch(() => undefined);
        pending.reject(new Error(`MCP ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, cleanup });
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
      }
      void this.send({ jsonrpc: "2.0", id, method, params }).catch(() => undefined);
    });
  }

  private async paginatedList(method: string, field: string): Promise<Array<Record<string, unknown>>> {
    this.requireInitialized();
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > McpClient.MAX_PAGINATION_PAGES) throw new Error(`MCP ${method} pagination exceeded 100 pages.`);
      const result = await this.request(method, cursor ? { cursor } : {}) as Record<string, unknown>;
      const page = result[field];
      if (!Array.isArray(page) || page.some((item) => !item || typeof item !== "object")) throw new Error(`MCP ${method} returned an invalid ${field} array.`);
      items.push(...page as Array<Record<string, unknown>>);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return items;
  }

  private receive(message: JsonRpcMessage): void {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.fail(new Error("MCP transport emitted a non-object JSON-RPC message."));
      return;
    }
    if (!("id" in message) || !("result" in message || "error" in message) || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.takePending(message.id);
    if ("error" in message) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private takePending(id: JsonRpcId): {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
    cleanup(): void;
  } | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    return pending;
  }

  private abortError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    return new Error(typeof signal.reason === "string" && signal.reason ? signal.reason : "MCP request cancelled.");
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP client is closed.");
    if (this.failure) throw this.failure;
    try { await this.transport.send(message); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error("MCP transport failed.");
      this.fail(failure);
      throw failure;
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("MCP client must initialize before operation.");
  }
}

export interface McpRuntimeAccess {
  allowMutatingTools: boolean;
}

export class McpRuntimeServer {
  private initialized = false;

  constructor(private readonly runtime: AgentRuntime, private readonly sessionId: string) {}

  async handle(message: JsonRpcMessage, access: McpRuntimeAccess = { allowMutatingTools: true }): Promise<JsonRpcMessage | undefined> {
    if (!("method" in message)) return undefined;
    if (!("id" in message)) {
      if (message.method === "notifications/initialized") this.initialized = true;
      return undefined;
    }
    try {
      if (message.method === "initialize") return {
        jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kestrel-runtime", title: "Kestrel Runtime", version: "0.1.0", description: "Policy-scoped Kestrel tools" }
        }
      };
      if (!this.initialized) throw new Error("MCP server is not initialized.");
      if (message.method === "tools/list") return {
        jsonrpc: "2.0", id: message.id, result: {
          tools: this.runtime.modelTools(this.sessionId).filter((tool) => access.allowMutatingTools || tool.descriptor.readOnly).map((tool) => ({
            name: tool.descriptor.name,
            title: tool.descriptor.title,
            description: tool.descriptor.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.descriptor.readOnly }
          }))
        }
      };
      if (message.method === "tools/call") {
        const name = String(message.params?.name ?? "");
        const tool = this.runtime.modelTools(this.sessionId).find((candidate) => candidate.descriptor.name === name);
        if (!access.allowMutatingTools && !tool?.descriptor.readOnly)
          throw new Error("Mutating MCP tools require task authorization.");
        const args = message.params?.arguments;
        const execution = await this.runtime.callTool(this.sessionId, name, args && typeof args === "object" ? args as Record<string, unknown> : {}, {
          approvalStatus: "pending",
          idempotencyKey: `mcp-server:${randomUUID()}`
        });
        return {
          jsonrpc: "2.0", id: message.id, result: {
            content: [{ type: "text", text: JSON.stringify(execution.output ?? { error: execution.error }) }],
            structuredContent: execution.output ?? { status: execution.status, error: execution.error },
            isError: execution.status !== "verified"
          }
        };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    } catch (error) {
      return { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" } };
    }
  }
}

function safeToolName(serverId: string, toolName: string): string {
  const suffix = `${serverId}.${toolName}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z]+/, "");
  return `mcp.${suffix || "tool"}`;
}

export async function bridgeMcpTools(client: McpClient, runtime: AgentRuntime, sessionId: string, serverId: string): Promise<string[]> {
  await client.initialize();
  const names: string[] = [];
  for (const tool of await client.listTools()) {
    const name = safeToolName(serverId, tool.name);
    runtime.registerExternalTool({
      descriptor: {
        name,
        title: tool.title ?? tool.name,
        description: tool.description ?? `Tool from MCP server ${serverId}.`,
        category: "extension",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: false,
        source: "mcp",
        tags: ["mcp", serverId, tool.name]
      },
      inputSchema: tool.inputSchema,
      execute: async ({ signal }, input) => {
        const result = await client.callTool(tool.name, input, signal);
        if (result.isError) throw new Error(JSON.stringify(result.content).slice(0, 2_000));
        return {
          content: result.content,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          isError: false
        };
      }
    });
    runtime.allowTool(sessionId, name);
    names.push(name);
  }
  return names;
}
