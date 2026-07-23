import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../runtime";

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
  close(): void | Promise<void>;
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

  constructor(endpoint: string, private readonly options: { authorization?: string; fetcher?: typeof fetch } = {}) {
    this.url = new URL(endpoint);
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
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_000_000) throw new Error("MCP HTTP response exceeded 1 MB.");
    const contentType = response.headers.get("content-type") ?? "";
    const payloads = contentType.includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())).filter((value) => value && value !== "[DONE]")
      : [text];
    for (const payload of payloads) this.events.emit("message", JSON.parse(payload) as JsonRpcMessage);
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.events.on("message", listener); return () => this.events.off("message", listener); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) await (this.options.fetcher ?? fetch)(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...(this.options.authorization ? { authorization: this.options.authorization } : {}) } });
    this.events.removeAllListeners();
  }
}

export class StdioMcpTransport implements McpTransport {
  private readonly events = new EventEmitter();
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";

  constructor(config: { command: string; args?: string[]; cwd: string; environment?: Record<string, string> }) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", LANG: process.env.LANG ?? "en_US.UTF-8", ...config.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (Buffer.byteLength(this.buffer) > 1_000_000) {
        this.child.kill("SIGTERM");
        this.events.emit("error", new Error("MCP stdio message exceeded 1 MB."));
        return;
      }
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.events.emit("message", JSON.parse(line) as JsonRpcMessage); }
        catch { this.events.emit("error", new Error("MCP server wrote invalid JSON to stdout.")); }
      }
    });
  }

  send(message: JsonRpcMessage): void {
    const encoded = JSON.stringify(message);
    if (encoded.includes("\n")) throw new Error("MCP stdio messages must be newline-delimited single-line JSON.");
    this.child.stdin.write(`${encoded}\n`);
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => { this.child.kill("SIGTERM"); resolvePromise(); }, 2_000);
      this.child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
    });
  }
}

export class McpClient {
  private readonly pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private initialized = false;
  private unsubscribe?: () => void;

  constructor(private readonly transport: McpTransport, private readonly timeoutMs = 30_000) {
    this.unsubscribe = transport.onMessage((message) => this.receive(message));
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "kestrel", title: "Workstrand", version: "0.1.0", description: "Local-first personal agent" }
    });
    const negotiated = String((result as Record<string, unknown>).protocolVersion ?? "");
    if (negotiated !== MCP_PROTOCOL_VERSION) throw new Error(`Unsupported MCP protocol version ${negotiated}.`);
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
    return result as Record<string, unknown>;
  }

  async listTools(): Promise<McpTool[]> {
    this.requireInitialized();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
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
    const request = this.request("tools/call", { name, arguments: args });
    if (signal) {
      if (signal.aborted) throw signal.reason;
      const abort = () => { void this.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { reason: "Cancelled by Workstrand" } }); };
      signal.addEventListener("abort", abort, { once: true });
      try { return await request as McpToolResult; }
      finally { signal.removeEventListener("abort", abort); }
    }
    return await request as McpToolResult;
  }

  async listResources(): Promise<Array<Record<string, unknown>>> { return this.paginatedList("resources/list", "resources"); }
  async listResourceTemplates(): Promise<Array<Record<string, unknown>>> { return this.paginatedList("resources/templates/list", "resourceTemplates"); }
  async readResource(uri: string): Promise<Record<string, unknown>> { this.requireInitialized(); return await this.request("resources/read", { uri }) as Record<string, unknown>; }
  async listPrompts(): Promise<Array<Record<string, unknown>>> { return this.paginatedList("prompts/list", "prompts"); }
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<Record<string, unknown>> { this.requireInitialized(); return await this.request("prompts/get", { name, arguments: args }) as Record<string, unknown>; }

  async close(): Promise<void> {
    this.unsubscribe?.();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("MCP client closed.")); }
    this.pending.clear();
    await this.transport.close();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Request timeout" } });
        reject(new Error(`MCP ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      void this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async paginatedList(method: string, field: string): Promise<Array<Record<string, unknown>>> {
    this.requireInitialized();
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const result = await this.request(method, cursor ? { cursor } : {}) as Record<string, unknown>;
      const page = result[field];
      if (!Array.isArray(page) || page.some((item) => !item || typeof item !== "object")) throw new Error(`MCP ${method} returned an invalid ${field} array.`);
      items.push(...page as Array<Record<string, unknown>>);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return items;
  }

  private receive(message: JsonRpcMessage): void {
    if (!("id" in message) || !("result" in message || "error" in message) || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if ("error" in message) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("MCP client must initialize before operation.");
  }
}

export class McpRuntimeServer {
  private initialized = false;

  constructor(private readonly runtime: AgentRuntime, private readonly sessionId: string) {}

  async handle(message: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
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
          serverInfo: { name: "kestrel-runtime", title: "Workstrand Runtime", version: "0.1.0", description: "Policy-scoped Workstrand tools" }
        }
      };
      if (!this.initialized) throw new Error("MCP server is not initialized.");
      if (message.method === "tools/list") return {
        jsonrpc: "2.0", id: message.id, result: {
          tools: this.runtime.modelTools(this.sessionId).map((tool) => ({
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
