import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { AgentRuntime } from "../runtime";
import { McpClient, StdioMcpTransport, bridgeMcpTools } from "./mcp";
import type { PluginRegistry } from "./plugins";

interface PluginMcpServerConfig {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

const forbiddenEnvironmentNames = new Set([
  "BASH_ENV",
  "ENV",
  "HOME",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
  "SHELL",
  "ZDOTDIR"
]);

export interface PluginMcpConnection {
  pluginName: string;
  serverName: string;
  toolNames: string[];
  connectedAt: string;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function parseConfig(path: string, pluginRoot: string): Map<string, PluginMcpServerConfig> {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 256_000) throw new Error("Plugin MCP configuration exceeds 256 KB.");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Plugin MCP configuration is invalid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Plugin MCP configuration is invalid.");
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Plugin MCP configuration requires an mcpServers object.");
  const output = new Map<string, PluginMcpServerConfig>();
  for (const [serverName, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(serverName) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Plugin MCP server entry is invalid.");
    const config = raw as Record<string, unknown>;
    if (config.command !== "node") throw new Error("Plugin MCP servers currently require the bundled Node.js runtime.");
    const args = Array.isArray(config.args) ? config.args.map((value) => String(value)) : [];
    if (args.length === 0 || args.length > 100 || args.some((arg) => arg.length > 10_000 || arg.startsWith("-"))) throw new Error("Plugin MCP Node arguments are invalid.");
    const cwdValue = typeof config.cwd === "string" ? config.cwd : ".";
    const cwd = realpathSync(resolve(pluginRoot, cwdValue));
    if (!within(pluginRoot, cwd) || !statSync(cwd).isDirectory()) throw new Error("Plugin MCP cwd escapes the plugin root.");
    const entry = realpathSync(resolve(cwd, args[0]!));
    if (!within(pluginRoot, entry) || !statSync(entry).isFile() || ![".js", ".mjs", ".cjs"].some((suffix) => entry.endsWith(suffix))) throw new Error("Plugin MCP entry point escapes the plugin root or is unsupported.");
    const environment: Record<string, string> = {};
    if (config.env !== undefined) {
      if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) throw new Error("Plugin MCP env must be an object.");
      for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
        if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(key) || typeof value !== "string" || value.length > 10_000) throw new Error("Plugin MCP environment entry is invalid.");
        if (forbiddenEnvironmentNames.has(key) || key.startsWith("DYLD_") || key.startsWith("LD_")) throw new Error(`Plugin MCP environment variable ${key} is not allowed.`);
        environment[key] = value;
      }
    }
    output.set(serverName, { command: process.execPath, args: [entry, ...args.slice(1)], cwd, environment });
  }
  return output;
}

export class PluginMcpManager {
  private readonly active = new Map<string, { client: McpClient; connection: PluginMcpConnection }>();

  constructor(private readonly plugins: PluginRegistry, private readonly runtime: AgentRuntime, private readonly now: () => Date = () => new Date()) {}

  list(): PluginMcpConnection[] {
    return [...this.active.values()].map(({ connection }) => connection);
  }

  attachSession(sessionId: string): void {
    this.runtime.getSession(sessionId);
    for (const { connection } of this.active.values()) {
      for (const toolName of connection.toolNames) this.runtime.allowTool(sessionId, toolName);
    }
  }

  async connect(pluginName: string, sessionId: string): Promise<PluginMcpConnection[]> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin.enabled) throw new Error("Plugin must be enabled before connecting its MCP servers.");
    if (!plugin.mcpServersPath || !existsSync(plugin.mcpServersPath)) throw new Error("Plugin does not declare MCP servers.");
    const servers = parseConfig(plugin.mcpServersPath, plugin.root);
    const connected: PluginMcpConnection[] = [];
    try {
      for (const [serverName, config] of servers) {
        const key = `${pluginName}:${serverName}`;
        if (this.active.has(key)) {
          const connection = this.active.get(key)!.connection;
          for (const toolName of connection.toolNames) this.runtime.allowTool(sessionId, toolName);
          connected.push(connection);
          continue;
        }
        const client = new McpClient(new StdioMcpTransport(config));
        const toolNames = await bridgeMcpTools(client, this.runtime, sessionId, `${pluginName}.${serverName}`);
        const connection = { pluginName, serverName, toolNames, connectedAt: this.now().toISOString() };
        this.active.set(key, { client, connection });
        connected.push(connection);
      }
      return connected;
    } catch (error) {
      await this.disconnect(pluginName);
      throw error;
    }
  }

  async disconnect(pluginName: string): Promise<void> {
    const matches = [...this.active.entries()].filter(([, value]) => value.connection.pluginName === pluginName);
    for (const [key, value] of matches) {
      for (const toolName of value.connection.toolNames) this.runtime.unregisterExternalTool(toolName);
      await value.client.close();
      this.active.delete(key);
    }
  }

  async close(): Promise<void> {
    for (const pluginName of new Set(this.list().map((connection) => connection.pluginName))) await this.disconnect(pluginName);
  }
}
