import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { AgentRuntime } from "./runtime";

export type LspMessage = { jsonrpc: "2.0"; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

export interface LanguageServerTransport {
  send(message: LspMessage): void | Promise<void>;
  onMessage(listener: (message: LspMessage) => void): () => void;
  close(): void | Promise<void>;
}

export interface TextPosition { line: number; character: number }

export interface StdioLanguageServerOptions { command: string; args?: string[]; cwd: string; environment?: Record<string, string>; maximumMessageBytes?: number; }

export class StdioLanguageServerTransport implements LanguageServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(message: LspMessage) => void>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly maximumMessageBytes: number;

  constructor(options: StdioLanguageServerOptions) {
    const command = realpathSync(options.command);
    const metadata = lstatSync(command);
    const cwd = realpathSync(options.cwd);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !(metadata.mode & 0o111)) throw new Error("Language server command must be an executable regular file.");
    if ((options.args ?? []).length > 100 || (options.args ?? []).some((arg) => arg.length > 10_000 || /[\0\r\n]/.test(arg))) throw new Error("Language server arguments are invalid.");
    if (Object.entries(options.environment ?? {}).some(([name, value]) => !/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) || value.length > 20_000 || /\0/.test(value))) throw new Error("Language server environment is invalid.");
    this.maximumMessageBytes = Math.max(1_024, Math.min(10_000_000, options.maximumMessageBytes ?? 2_000_000));
    this.child = spawn(command, options.args ?? [], { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8", ...(options.environment ?? {}) } });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    let stderrBytes = 0;
    this.child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > 1_000_000) this.child.kill("SIGKILL"); });
  }

  send(message: LspMessage): void {
    if (this.closed || !this.child.stdin.writable) throw new Error("Language server transport is closed.");
    const body = Buffer.from(JSON.stringify(message));
    if (body.byteLength > this.maximumMessageBytes) throw new Error("Language server message exceeds the configured limit.");
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  onMessage(listener: (message: LspMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); resolve(); };
      this.child.once("exit", finish);
      timer = setTimeout(() => { this.child.kill("SIGKILL"); finish(); }, 2_000);
      timer.unref();
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > this.maximumMessageBytes + 8_192) { this.child.kill("SIGKILL"); return; }
    while (true) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      if (boundary > 8_192) { this.child.kill("SIGKILL"); return; }
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i);
      const length = Number(match?.[1]);
      if (!Number.isInteger(length) || length < 2 || length > this.maximumMessageBytes) { this.child.kill("SIGKILL"); return; }
      const end = boundary + 4 + length;
      if (this.buffer.byteLength < end) return;
      const body = this.buffer.subarray(boundary + 4, end);
      this.buffer = this.buffer.subarray(end);
      let message: LspMessage;
      try { message = JSON.parse(body.toString("utf8")) as LspMessage; } catch { this.child.kill("SIGKILL"); return; }
      if (message.jsonrpc !== "2.0") { this.child.kill("SIGKILL"); return; }
      for (const listener of this.listeners) listener(message);
    }
  }
}

export async function environmentLanguageServerClient(environment: NodeJS.ProcessEnv = process.env): Promise<{ client: LanguageServerClient; rootUri: string } | undefined> {
  const path = environment.KESTREL_LSP_CONFIG;
  if (!path) return undefined;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_000_000 || (metadata.mode & 0o077) !== 0) throw new Error("KESTREL_LSP_CONFIG must be an owner-only regular file no larger than 1 MB.");
  const parsed = JSON.parse(readFileSync(realpathSync(path), "utf8")) as Record<string, unknown>;
  if (parsed.version !== 1 || typeof parsed.command !== "string" || typeof parsed.cwd !== "string" || typeof parsed.rootUri !== "string" || !Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== "string")) throw new Error("Language server configuration is invalid.");
  const client = new LanguageServerClient(new StdioLanguageServerTransport({ command: parsed.command, args: parsed.args as string[], cwd: parsed.cwd }));
  await client.initialize(parsed.rootUri);
  return { client, rootUri: parsed.rootUri };
}

export class LanguageServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly diagnosticsWaiters = new Map<string, Array<{ resolve(value: unknown[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>>();
  private readonly openDocuments = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly transport: LanguageServerTransport, private readonly timeoutMs = 10_000) {
    this.unsubscribe = transport.onMessage((message) => this.receive(message));
  }

  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", { processId: null, rootUri, capabilities: { textDocument: { publishDiagnostics: {}, definition: {}, references: {} } }, clientInfo: { name: "Workstrand", version: "0.1.0" } });
    await this.notify("initialized", {});
    return result;
  }

  async diagnostics(input: { uri: string; languageId: string; text: string; version?: number }): Promise<unknown[]> {
    const result = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => { this.diagnosticsWaiters.set(input.uri, (this.diagnosticsWaiters.get(input.uri) ?? []).filter((item) => item.timer !== timer)); reject(new Error("Language server diagnostics timed out.")); }, this.timeoutMs);
      const waiter = { resolve, reject, timer };
      this.diagnosticsWaiters.set(input.uri, [...(this.diagnosticsWaiters.get(input.uri) ?? []), waiter]);
    });
    const priorVersion = this.openDocuments.get(input.uri);
    const version = Math.max(input.version ?? 1, (priorVersion ?? 0) + 1);
    if (priorVersion === undefined) await this.notify("textDocument/didOpen", { textDocument: { uri: input.uri, languageId: input.languageId, version, text: input.text } });
    else await this.notify("textDocument/didChange", { textDocument: { uri: input.uri, version }, contentChanges: [{ text: input.text }] });
    this.openDocuments.set(input.uri, version);
    return result;
  }

  definition(uri: string, position: TextPosition): Promise<unknown> {
    return this.request("textDocument/definition", { textDocument: { uri }, position });
  }

  references(uri: string, position: TextPosition, includeDeclaration = true): Promise<unknown> {
    return this.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration } });
  }

  async close(): Promise<void> {
    try {
      for (const uri of this.openDocuments.keys()) await this.notify("textDocument/didClose", { textDocument: { uri } });
      this.openDocuments.clear();
      await this.request("shutdown", null);
    } finally {
      await this.notify("exit");
      this.unsubscribe();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Language server client closed.")); }
      this.pending.clear();
      for (const waiters of this.diagnosticsWaiters.values()) for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error("Language server client closed.")); }
      this.diagnosticsWaiters.clear();
      await this.transport.close();
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Language server request timed out: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.transport.send({ jsonrpc: "2.0", id, method, params })).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Language server send failed."));
      });
    });
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return Promise.resolve(this.transport.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }));
  }

  private receive(message: LspMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Language server error ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined;
      if (typeof params?.uri !== "string" || !Array.isArray(params.diagnostics)) return;
      const waiters = this.diagnosticsWaiters.get(params.uri) ?? [];
      this.diagnosticsWaiters.delete(params.uri);
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(params.diagnostics); }
    }
  }
}

export function installCodeIntelligenceTools(runtime: AgentRuntime, client: LanguageServerClient, sessionId: string): void {
  const descriptor = (name: string, title: string, description: string) => ({ name, title, description, category: "execution" as const, riskLevel: "sensitive" as const, readOnly: true, requiresWorkspace: false, source: "builtin" as const, tags: ["lsp", "code", "untrusted-server"] });
  runtime.registerExternalTool({
    descriptor: descriptor("code.diagnostics", "Get code diagnostics", "Open an in-memory document in a configured language server and return published diagnostics."),
    inputSchema: { type: "object", properties: { uri: { type: "string" }, languageId: { type: "string" }, text: { type: "string" }, version: { type: "integer" } }, required: ["uri", "languageId", "text"] },
    execute: async (_context, input) => ({ diagnostics: await client.diagnostics({ uri: String(input.uri), languageId: String(input.languageId), text: String(input.text), version: Number(input.version ?? 1) }), trust: "untrusted_language_server" })
  });
  for (const [name, title, method] of [["code.definition", "Find definition", "definition"], ["code.references", "Find references", "references"]] as const) {
    runtime.registerExternalTool({
      descriptor: descriptor(name, title, `Query a configured language server for ${method}.`),
      inputSchema: { type: "object", properties: { uri: { type: "string" }, line: { type: "integer" }, character: { type: "integer" } }, required: ["uri", "line", "character"] },
      execute: async (_context, input) => ({ locations: await client[method](String(input.uri), { line: Number(input.line), character: Number(input.character) }), trust: "untrusted_language_server" })
    });
  }
  runtime.allowTool(sessionId, "code.diagnostics");
  runtime.allowTool(sessionId, "code.definition");
  runtime.allowTool(sessionId, "code.references");
}
