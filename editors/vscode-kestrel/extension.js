"use strict";
const vscode = require("vscode");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

function contained(root, requested, write = false) {
  if (!path.isAbsolute(requested)) throw new Error("ACP paths must be absolute.");
  const canonicalRoot = fs.realpathSync(root);
  const candidate = write && !fs.existsSync(requested) ? path.resolve(requested) : fs.realpathSync(requested);
  const parent = write && !fs.existsSync(candidate) ? fs.realpathSync(path.dirname(candidate)) : candidate;
  for (const value of [candidate, parent]) if (value !== canonicalRoot && !value.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("ACP path escapes the open workspace.");
  return candidate;
}

class RpcPeer {
  constructor(child, handlers, log) { this.child = child; this.handlers = handlers; this.log = log; this.nextId = 0; this.pending = new Map(); this.buffer = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => this.accept(chunk)); child.stderr.on("data", (chunk) => log.append(chunk.toString())); child.on("exit", (code) => this.close(new Error(`Kestrel ACP exited with ${code ?? "signal"}.`))); }
  request(method, params) { const id = ++this.nextId; this.send({ jsonrpc: "2.0", id, method, params }); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  accept(chunk) { this.buffer += chunk; if (Buffer.byteLength(this.buffer) > 2_000_000) return this.close(new Error("ACP message exceeded 2 MB.")); for (;;) { const index = this.buffer.indexOf("\n"); if (index < 0) break; const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); if (line.trim()) void this.dispatch(JSON.parse(line)); } }
  async dispatch(message) { if (message.id !== undefined && !message.method) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message || "ACP request failed.")) : pending.resolve(message.result); return; } if (!message.method) return; const handler = this.handlers[message.method]; if (message.id === undefined) { await handler?.(message.params); return; } try { const result = handler ? await handler(message.params) : (() => { throw new Error(`Unsupported ACP client method ${message.method}.`); })(); this.send({ jsonrpc: "2.0", id: message.id, result }); } catch (error) { this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Client request failed." } }); } }
  close(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); if (!this.child.killed) this.child.kill("SIGTERM"); }
}

class KestrelEditorClient {
  constructor(root, output, status) { this.root = root; this.output = output; this.status = status; this.terminals = new Map(); this.sessionId = undefined; this.peer = undefined; }
  async start(prompt) {
    const config = vscode.workspace.getConfiguration("kestrel"); const executable = config.get("acpExecutable", "kestrel-acp"); const model = config.get("model", ""); const providers = config.get("providers", []); const args = ["--workspace", this.root]; if (model) args.push("--model", model); if (providers.length) args.push("--providers", providers.join(","));
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, cwd: this.root, env: process.env }); this.peer = new RpcPeer(child, this.handlers(), this.output); this.status.text = "$(sync~spin) Kestrel"; this.status.show();
    await this.peer.request("initialize", { protocolVersion: 1, clientInfo: { name: "Kestrel VS Code", version: "0.1.0" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    const session = await this.peer.request("session/new", { cwd: this.root, mcpServers: config.get("mcpServers", []) }); this.sessionId = session.sessionId; this.output.show(true); this.output.appendLine(`Kestrel task ${this.sessionId}`); this.output.appendLine(`You: ${prompt}`);
    const result = await this.peer.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: prompt }] }); this.output.appendLine(`\n[${result.stopReason}]`); this.status.text = "$(check) Kestrel";
  }
  handlers() { return {
    "session/update": async ({ update }) => { if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") this.output.append(update.content.text); else if (update.sessionUpdate === "tool_call") this.output.appendLine(`\n▶ ${update.title}`); else if (update.sessionUpdate === "tool_call_update") this.output.appendLine(`\n  ${update.status}`); return {}; },
    "session/request_permission": async ({ toolCall, options }) => { const allow = await vscode.window.showWarningMessage(`${toolCall.title}\n${JSON.stringify(toolCall.rawInput ?? {}, null, 2)}`, { modal: true }, "Allow once", "Reject"); const option = options.find((item) => item.kind === (allow === "Allow once" ? "allow_once" : "reject_once")); return { outcome: { outcome: "selected", optionId: option.optionId } }; },
    "fs/read_text_file": async ({ path: requested, line, limit }) => { const target = contained(this.root, requested); const text = (await vscode.workspace.fs.readFile(vscode.Uri.file(target))).toString(); const lines = text.split(/\r?\n/); return { content: line ? lines.slice(line - 1, limit ? line - 1 + limit : undefined).join("\n") : text }; },
    "fs/write_text_file": async ({ path: requested, content }) => { const target = contained(this.root, requested, true); await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(content)); await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false }); return {}; },
    "terminal/create": async (params) => this.createTerminal(params),
    "terminal/wait_for_exit": async ({ terminalId }) => this.terminals.get(terminalId).exit,
    "terminal/output": async ({ terminalId }) => { const item = this.terminals.get(terminalId); return { output: item.output, truncated: item.truncated, ...(item.exitStatus ? { exitStatus: item.exitStatus } : {}) }; },
    "terminal/kill": async ({ terminalId }) => { this.terminals.get(terminalId)?.process.kill("SIGTERM"); return {}; },
    "terminal/release": async ({ terminalId }) => { this.terminals.get(terminalId)?.terminal.dispose(); this.terminals.delete(terminalId); return {}; }
  }; }
  createTerminal(params) { const id = `kestrel-${Date.now()}-${Math.random().toString(16).slice(2)}`; const emitter = new EventEmitter(); const closeEmitter = new EventEmitter(); const pty = { onDidWrite: (listener) => { emitter.on("write", listener); return { dispose: () => emitter.off("write", listener) }; }, onDidClose: (listener) => { closeEmitter.on("close", listener); return { dispose: () => closeEmitter.off("close", listener) }; }, open: () => {}, close: () => {} }; const terminal = vscode.window.createTerminal({ name: `Kestrel · ${params.command}`, pty }); terminal.show(true); const environment = { ...process.env, ...Object.fromEntries((params.env ?? []).map((item) => [item.name, item.value])) }; const child = spawn(params.command, params.args ?? [], { cwd: contained(this.root, params.cwd || this.root), env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] }); const item = { process: child, terminal, output: "", truncated: false, exitStatus: undefined }; const limit = Math.min(Number(params.outputByteLimit ?? 1_000_000), 1_000_000); const capture = (chunk) => { const text = chunk.toString(); emitter.emit("write", text.replace(/\n/g, "\r\n")); item.output += text; if (Buffer.byteLength(item.output) > limit) { item.output = Buffer.from(item.output).subarray(-limit).toString("utf8"); item.truncated = true; } }; child.stdout.on("data", capture); child.stderr.on("data", capture); item.exit = new Promise((resolve) => child.once("exit", (code, signal) => { item.exitStatus = { exitCode: code, signal }; closeEmitter.emit("close", code ?? 1); resolve(item.exitStatus); })); this.terminals.set(id, item); return { terminalId: id }; }
  cancel() { if (this.peer && this.sessionId) this.peer.notify("session/cancel", { sessionId: this.sessionId }); }
  dispose() { this.cancel(); this.peer?.close(new Error("Editor extension stopped.")); for (const item of this.terminals.values()) { item.process.kill("SIGTERM"); item.terminal.dispose(); } }
}

function activate(context) { const output = vscode.window.createOutputChannel("Kestrel"); const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20); let active; context.subscriptions.push(output, status, vscode.commands.registerCommand("kestrel.startTask", async () => { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return void vscode.window.showErrorMessage("Open a workspace before starting Kestrel."); const prompt = await vscode.window.showInputBox({ title: "Kestrel task", prompt: "What should Kestrel do?", ignoreFocusOut: true }); if (!prompt) return; active?.dispose(); active = new KestrelEditorClient(root, output, status); try { await active.start(prompt); } catch (error) { status.text = "$(error) Kestrel"; output.appendLine(`\nError: ${error instanceof Error ? error.message : error}`); output.show(); } }), vscode.commands.registerCommand("kestrel.cancelTask", () => active?.cancel()), { dispose: () => active?.dispose() }); }
function deactivate() {}
module.exports = { activate, deactivate, contained, RpcPeer };
