import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageServerClient, environmentLanguageServerClient, installCodeIntelligenceTools, type LanguageServerTransport, type LspMessage } from "./code-intelligence";
import { AgentRuntime } from "./runtime";

class LoopbackLanguageServer implements LanguageServerTransport {
  private listeners = new Set<(message: LspMessage) => void>();
  sent: LspMessage[] = [];
  async send(message: LspMessage): Promise<void> {
    this.sent.push(message);
    if (message.id !== undefined) {
      const id = message.id;
      queueMicrotask(() => this.emit({ jsonrpc: "2.0", id, result: message.method === "textDocument/definition" ? [{ uri: "file:///project/a.ts", range: {} }] : message.method === "textDocument/references" ? [{ uri: "file:///project/b.ts", range: {} }] : {} }));
    }
    if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
      const uri = (message.params as { textDocument: { uri: string } }).textDocument.uri;
      queueMicrotask(() => this.emit({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ severity: 1, message: "Example error" }] } }));
    }
  }
  onMessage(listener: (message: LspMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.listeners.clear(); }
  private emit(message: LspMessage): void { for (const listener of this.listeners) listener(message); }
}

describe("language server code intelligence", () => {
  it("negotiates LSP and serves approval-gated diagnostics, definitions, and references", async () => {
    const transport = new LoopbackLanguageServer();
    const client = new LanguageServerClient(transport);
    await client.initialize("file:///project");
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "LSP" });
    installCodeIntelligenceTools(runtime, client, session.id);
    expect((await runtime.callTool(session.id, "code.diagnostics", { uri: "file:///project/a.ts", languageId: "typescript", text: "bad" })).status).toBe("blocked");
    const diagnostics = await runtime.callTool(session.id, "code.diagnostics", { uri: "file:///project/a.ts", languageId: "typescript", text: "bad" }, { approvalStatus: "approved" });
    expect(diagnostics).toMatchObject({ status: "verified", output: { diagnostics: [{ message: "Example error" }], trust: "untrusted_language_server" } });
    await runtime.callTool(session.id, "code.diagnostics", { uri: "file:///project/a.ts", languageId: "typescript", text: "still bad", version: 2 }, { approvalStatus: "approved" });
    expect(transport.sent.some((message) => message.method === "textDocument/didChange")).toBe(true);
    const definition = await runtime.callTool(session.id, "code.definition", { uri: "file:///project/a.ts", line: 1, character: 2 }, { approvalStatus: "approved" });
    expect(definition.output?.locations).toEqual([{ uri: "file:///project/a.ts", range: {} }]);
    const references = await runtime.callTool(session.id, "code.references", { uri: "file:///project/a.ts", line: 1, character: 2 }, { approvalStatus: "approved" });
    expect(references.output?.locations).toEqual([{ uri: "file:///project/b.ts", range: {} }]);
    await client.close();
    database.close();
  });

  it("initializes and shuts down a configured owner-only stdio language server", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-lsp-"));
    const serverPath = join(root, "server.mjs");
    const configPath = join(root, "lsp.json");
    writeFileSync(serverPath, `let b=Buffer.alloc(0);const send=m=>{const p=Buffer.from(JSON.stringify(m));process.stdout.write('Content-Length: '+p.length+'\\r\\n\\r\\n');process.stdout.write(p)};process.stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){const x=b.indexOf('\\r\\n\\r\\n');if(x<0)return;const n=Number(b.subarray(0,x).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]);if(b.length<x+4+n)return;const m=JSON.parse(b.subarray(x+4,x+4+n));b=b.subarray(x+4+n);if(m.id)send({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{capabilities:{}}:[]});if(m.method==='exit')process.exit(0)}});`);
    writeFileSync(configPath, JSON.stringify({ version: 1, command: process.execPath, args: [serverPath], cwd: root, rootUri: pathToFileURL(root).toString() }), { mode: 0o600 });
    try {
      const configured = await environmentLanguageServerClient({ KESTREL_LSP_CONFIG: configPath });
      expect(await configured?.client.definition(pathToFileURL(join(root, "a.ts")).toString(), { line: 0, character: 0 })).toEqual([]);
      await configured?.client.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
