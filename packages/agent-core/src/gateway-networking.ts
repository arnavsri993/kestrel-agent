import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { IncomingHttpHeaders } from "node:http";
import { spawn } from "node:child_process";
import type { RemoteScope, RemoteTrustedIdentity } from "./remote";

export interface TrustedProxyConfiguration {
  trustedSources: string[];
  userHeader: string;
  requiredHeaders: string[];
  allowUsers: string[];
  allowLoopback: boolean;
  maximumScopes: RemoteScope[];
}

export interface TrustedProxyRequest {
  remoteAddress?: string;
  headers: IncomingHttpHeaders;
}

function headerName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(normalized)) throw new Error("Trusted proxy header name is invalid.");
  return normalized;
}

function normalizedAddress(value: string): string {
  const zoneIndex = value.indexOf("%");
  const withoutZone = (zoneIndex >= 0 ? value.slice(0, zoneIndex) : value).toLowerCase();
  return withoutZone.startsWith("::ffff:") && isIP(withoutZone.slice(7)) === 4 ? withoutZone.slice(7) : withoutZone;
}

function loopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

function blockList(values: string[]): BlockList {
  if (values.length === 0 || values.length > 64) throw new Error("Trusted proxy sources must contain 1 to 64 addresses or CIDRs.");
  const output = new BlockList();
  for (const value of values) {
    const parts = value.split("/");
    if (parts.length > 2) throw new Error("Trusted proxy CIDR prefix is invalid.");
    const [rawAddress, rawPrefix] = parts;
    const address = normalizedAddress(rawAddress ?? "");
    const family = isIP(address);
    if (!family) throw new Error("Trusted proxy source must be an IP address or CIDR.");
    if (rawPrefix === undefined) output.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    else {
      const prefix = Number(rawPrefix);
      const maximum = family === 4 ? 32 : 128;
      if (!/^\d+$/.test(rawPrefix) || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) throw new Error("Trusted proxy CIDR prefix is invalid.");
      output.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
    }
  }
  return output;
}

function localAddresses(): Set<string> {
  const values = new Set<string>();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) values.add(normalizedAddress(entry.address));
  }
  return values;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0]?.trim() : undefined;
  return typeof value === "string" ? value.trim() : undefined;
}

export class TrustedProxyAuthorizer {
  private readonly sources: BlockList;
  private readonly userHeader: string;
  private readonly requiredHeaders: string[];
  private readonly allowUsers: Set<string>;
  private readonly maximumScopes: Set<RemoteScope>;

  constructor(private readonly configuration: TrustedProxyConfiguration, private readonly interfaces: () => Set<string> = localAddresses) {
    this.sources = blockList(configuration.trustedSources);
    this.userHeader = headerName(configuration.userHeader);
    this.requiredHeaders = [...new Set(configuration.requiredHeaders.map(headerName))];
    if (configuration.requiredHeaders.length > 32 || this.requiredHeaders.length !== configuration.requiredHeaders.length) throw new Error("Trusted proxy required headers are invalid or contain duplicates.");
    this.allowUsers = new Set(configuration.allowUsers.map((user) => user.trim().toLowerCase()).filter(Boolean));
    if (configuration.allowUsers.length > 500 || this.allowUsers.size !== configuration.allowUsers.length) throw new Error("Trusted proxy user allowlist is invalid or contains duplicates.");
    this.maximumScopes = new Set(configuration.maximumScopes);
    if (this.maximumScopes.size === 0 || [...this.maximumScopes].some((scope) => !["read", "tasks", "approve"].includes(scope))) throw new Error("Trusted proxy maximum scopes are invalid.");
  }

  authorize(request: TrustedProxyRequest): RemoteTrustedIdentity {
    const address = normalizedAddress(request.remoteAddress ?? "");
    const family = isIP(address);
    if (!family || !this.sources.check(address, family === 4 ? "ipv4" : "ipv6")) throw new Error("Trusted proxy request came from an untrusted source.");
    if (loopback(address) && !this.configuration.allowLoopback) throw new Error("Trusted proxy loopback source is not allowed.");
    if (!loopback(address)) {
      let hostAddresses: Set<string>;
      try { hostAddresses = this.interfaces(); } catch { throw new Error("Trusted proxy local-interface check failed."); }
      if (hostAddresses.has(address)) throw new Error("Trusted proxy source matches a local host interface.");
    }
    for (const required of this.requiredHeaders) if (!headerValue(request.headers, required)) throw new Error(`Trusted proxy required header ${required} is missing.`);
    const user = headerValue(request.headers, this.userHeader);
    if (!user || user.length > 320 || /[\r\n\0]/.test(user)) throw new Error("Trusted proxy user identity is missing or invalid.");
    const normalizedUser = user.toLowerCase();
    if (this.allowUsers.size && !this.allowUsers.has(normalizedUser)) throw new Error("Trusted proxy user is not allowed.");
    const declared = headerValue(request.headers, "x-workstrand-scopes");
    const requestedScopes = declared?.split(",").map((scope) => scope.trim()).filter(Boolean);
    if (requestedScopes?.some((scope) => !["read", "tasks", "approve"].includes(scope))) throw new Error("Trusted proxy declared an invalid scope.");
    if (requestedScopes?.some((scope) => !this.maximumScopes.has(scope as RemoteScope))) throw new Error("Trusted proxy declared a scope above its configured maximum.");
    const scopes = requestedScopes === undefined ? [...this.maximumScopes] : requestedScopes as RemoteScope[];
    return { kind: "trusted-proxy", identity: normalizedUser, scopes: [...new Set(scopes)] };
  }
}

export type TailscaleExposureMode = "off" | "serve" | "funnel";
export interface TailscaleExposureConfiguration {
  mode: TailscaleExposureMode;
  executable?: string;
  serviceName?: string;
  resetOnExit: boolean;
  publicExposureApproved: boolean;
}
export interface TailscaleExposureStatus { mode: TailscaleExposureMode; active: boolean; url?: string; detail: string; }
export interface GatewayCommandRunner { run(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>; }

class SpawnGatewayCommandRunner implements GatewayCommandRunner {
  run(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false; let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, exitCode = 1) => {
        if (settled) return; settled = true; if (timer) clearTimeout(timer);
        if (error) reject(error); else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode });
      };
      const capture = (target: Buffer[]) => (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 1_000_000) { child.kill("SIGKILL"); finish(new Error("Tailscale command output exceeded 1 MB.")); } else target.push(chunk); };
      child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
      child.once("error", (error) => finish(new Error(`Could not start Tailscale CLI: ${error.message}`)));
      child.once("close", (code) => finish(undefined, code ?? 1));
      timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("Tailscale command timed out.")); }, timeoutMs);
      timer.unref();
    });
  }
}

export class TailscaleExposureManager {
  private appliedMode: TailscaleExposureMode = "off";
  constructor(private readonly configuration: TailscaleExposureConfiguration, private readonly runner: GatewayCommandRunner = new SpawnGatewayCommandRunner()) {
    if (configuration.serviceName && !/^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(configuration.serviceName)) throw new Error("Tailscale service name must use svc:<dns-label> format.");
    if (configuration.serviceName && configuration.mode !== "serve") throw new Error("Tailscale service names apply only to Serve mode.");
    if (configuration.mode === "funnel" && !configuration.publicExposureApproved) throw new Error("Tailscale Funnel requires explicit public exposure approval.");
  }

  async apply(origin: string): Promise<TailscaleExposureStatus> {
    if (this.configuration.mode === "off") return { mode: "off", active: false, detail: "Tailscale exposure is off; the Tailscale daemon is not changed." };
    let target: URL;
    try { target = new URL(origin); } catch { throw new Error("Tailscale Serve and Funnel require a loopback gateway origin."); }
    if (!["127.0.0.1", "[::1]", "::1", "localhost"].includes(target.hostname)) throw new Error("Tailscale Serve and Funnel require a loopback gateway origin.");
    if (target.protocol !== "http:") throw new Error("Tailscale exposure expects loopback HTTP and terminates HTTPS itself.");
    const executable = this.configuration.executable ?? "tailscale";
    const status = await this.runner.run(executable, ["status", "--json"], 15_000);
    if (status.exitCode !== 0) throw new Error(`Tailscale is unavailable or logged out: ${status.stderr.slice(0, 500)}`);
    let dnsName = "";
    try {
      const parsed = JSON.parse(status.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown; Online?: unknown } };
      if (parsed.BackendState !== "Running" || parsed.Self?.Online !== true || typeof parsed.Self.DNSName !== "string") throw new Error();
      dnsName = parsed.Self.DNSName.replace(/\.$/, "");
    } catch { throw new Error("Tailscale status did not report an online device with MagicDNS."); }
    const action = this.configuration.mode;
    const args = [action, "--bg", "--yes", ...(this.configuration.serviceName ? [`--service=${this.configuration.serviceName}`] : []), target.toString().replace(/\/$/, "")];
    const result = await this.runner.run(executable, args, 30_000);
    if (result.exitCode !== 0) throw new Error(`Tailscale ${action} failed: ${result.stderr.slice(0, 500)}`);
    this.appliedMode = action;
    const advertisedHost = this.configuration.serviceName ? `${this.configuration.serviceName.slice(4)}.${dnsName.split(".").slice(1).join(".")}` : dnsName;
    return { mode: action, active: true, url: `https://${advertisedHost}/`, detail: action === "serve" ? "Tailnet-only HTTPS exposure is active." : "Public Tailscale Funnel exposure is active; paired bearer authentication remains required." };
  }

  async close(): Promise<void> {
    if (!this.configuration.resetOnExit || this.appliedMode === "off") return;
    const executable = this.configuration.executable ?? "tailscale";
    const result = await this.runner.run(executable, [this.appliedMode, "reset"], 15_000);
    if (result.exitCode !== 0) throw new Error(`Tailscale reset failed: ${result.stderr.slice(0, 500)}`);
    this.appliedMode = "off";
  }
}

export type BonjourMode = "off" | "minimal" | "full";
export interface BonjourConfiguration {
  mode: BonjourMode;
  displayName: string;
  tlsEnabled: boolean;
  tlsSha256?: string;
  tailnetDns?: string;
  sshPort?: number;
  cliPath?: string;
}
export interface GatewayProcessHandle { stop(): Promise<void>; }
export interface GatewayProcessRunner { start(executable: string, args: string[]): Promise<GatewayProcessHandle>; }

class SpawnGatewayProcessRunner implements GatewayProcessRunner {
  start(executable: string, args: string[]): Promise<GatewayProcessHandle> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
      });
      let settled = false;
      const error = (cause: Error) => { if (!settled) { settled = true; reject(new Error(`Bonjour advertiser could not start: ${cause.message}`)); } };
      child.once("error", error);
      child.stderr.once("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (/error|failed|denied/i.test(text)) error(new Error(text.slice(0, 500)));
      });
      child.once("spawn", () => {
        settled = true;
        resolve({ stop: () => new Promise<void>((done) => { if (child.exitCode !== null || child.killed) { done(); return; } child.once("close", () => done()); child.kill("SIGTERM"); }) });
      });
    });
  }
}

export class BonjourAdvertiser {
  private handle: GatewayProcessHandle | undefined;
  constructor(private readonly configuration: BonjourConfiguration, private readonly runner: GatewayProcessRunner = new SpawnGatewayProcessRunner(), private readonly platform = process.platform) {
    if (!configuration.displayName.trim() || Buffer.byteLength(configuration.displayName) > 63 || /[\0\r\n]/.test(configuration.displayName)) throw new Error("Bonjour display name is invalid.");
    if (configuration.tlsSha256 && !/^[a-f0-9]{64}$/.test(configuration.tlsSha256)) throw new Error("Bonjour TLS fingerprint is invalid.");
    if (configuration.mode === "full" && configuration.sshPort !== undefined && (!Number.isInteger(configuration.sshPort) || configuration.sshPort < 1 || configuration.sshPort > 65_535)) throw new Error("Bonjour SSH port is invalid.");
    if (configuration.tailnetDns && (!/^[a-z0-9](?:[a-z0-9.-]{0,242}[a-z0-9])?$/i.test(configuration.tailnetDns) || Buffer.byteLength(`tailnetDns=${configuration.tailnetDns}`) > 255)) throw new Error("Bonjour tailnet DNS hint is invalid.");
    if (configuration.cliPath && (/[\0\r\n]/.test(configuration.cliPath) || Buffer.byteLength(`cliPath=${configuration.cliPath}`) > 255)) throw new Error("Bonjour CLI path hint is invalid.");
  }

  async start(origin: string): Promise<{ active: boolean; mode: BonjourMode; serviceType: string; detail: string }> {
    if (this.configuration.mode === "off") return { active: false, mode: "off", serviceType: "_workstrand-gw._tcp", detail: "Bonjour advertising is off." };
    if (this.platform !== "darwin") throw new Error("Built-in Bonjour advertising currently requires macOS dns-sd.");
    if (this.handle) throw new Error("Bonjour advertising is already active.");
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("Bonjour gateway origin is invalid.");
    }
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Bonjour gateway port is invalid.");
    const records = [
      "role=gateway",
      `displayName=${this.configuration.displayName}`,
      `gatewayPort=${port}`,
      "transport=gateway",
      ...(this.configuration.tlsEnabled ? ["gatewayTls=1"] : []),
      ...(this.configuration.tlsSha256 ? [`gatewayTlsSha256=${this.configuration.tlsSha256}`] : []),
      ...(this.configuration.mode === "full" && this.configuration.tailnetDns ? [`tailnetDns=${this.configuration.tailnetDns}`] : []),
      ...(this.configuration.mode === "full" && this.configuration.sshPort ? [`sshPort=${this.configuration.sshPort}`] : []),
      ...(this.configuration.mode === "full" && this.configuration.cliPath ? [`cliPath=${this.configuration.cliPath}`] : [])
    ];
    this.handle = await this.runner.start("/usr/bin/dns-sd", ["-R", this.configuration.displayName, "_workstrand-gw._tcp", "local.", String(port), ...records]);
    return { active: true, mode: this.configuration.mode, serviceType: "_workstrand-gw._tcp", detail: "LAN discovery is active. TXT records are unauthenticated hints; clients must verify TLS and pairing." };
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    await handle?.stop();
  }
}
