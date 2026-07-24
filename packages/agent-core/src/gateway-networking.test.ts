import { describe, expect, it } from "vitest";
import { BonjourAdvertiser, TailscaleExposureManager, TrustedProxyAuthorizer, type GatewayCommandRunner, type GatewayProcessRunner } from "./gateway-networking";

describe("trusted proxy gateway authentication", () => {
  const configuration = {
    trustedSources: ["10.0.0.0/24"],
    userHeader: "x-auth-user",
    requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
    allowUsers: ["operator@example.test"],
    allowLoopback: false,
    maximumScopes: ["read", "tasks"] as const
  };

  it("enforces source CIDRs, required headers, users, local-interface spoof guards, and scope caps", () => {
    const authorizer = new TrustedProxyAuthorizer({ ...configuration, maximumScopes: [...configuration.maximumScopes] }, () => new Set(["192.168.1.4"]));
    const headers = { "x-auth-user": "Operator@Example.Test", "x-forwarded-proto": "https", "x-forwarded-host": "workstrand.example", "x-workstrand-scopes": "read" };
    expect(authorizer.authorize({ remoteAddress: "10.0.0.8", headers })).toEqual({ kind: "trusted-proxy", identity: "operator@example.test", scopes: ["read"] });
    expect(() => authorizer.authorize({ remoteAddress: "10.0.1.8", headers })).toThrow("untrusted source");
    expect(() => authorizer.authorize({ remoteAddress: "10.0.0.8", headers: { ...headers, "x-auth-user": "other@example.test" } })).toThrow("not allowed");
    expect(() => authorizer.authorize({ remoteAddress: "10.0.0.8", headers: { ...headers, "x-forwarded-proto": "" } })).toThrow("required header");
    expect(() => authorizer.authorize({ remoteAddress: "10.0.0.8", headers: { ...headers, "x-workstrand-scopes": "approve" } })).toThrow("configured maximum");
    expect(() => new TrustedProxyAuthorizer({ ...configuration, trustedSources: ["192.168.1.4"], maximumScopes: [...configuration.maximumScopes] }, () => new Set(["192.168.1.4"])).authorize({ remoteAddress: "192.168.1.4", headers })).toThrow("local host interface");
  });

  it("requires deliberate loopback proxy trust", () => {
    const headers = { "x-auth-user": "operator@example.test", "x-forwarded-proto": "https", "x-forwarded-host": "workstrand.example" };
    const denied = new TrustedProxyAuthorizer({ ...configuration, trustedSources: ["127.0.0.1"], maximumScopes: [...configuration.maximumScopes] });
    expect(() => denied.authorize({ remoteAddress: "127.0.0.1", headers })).toThrow("loopback source");
    const allowed = new TrustedProxyAuthorizer({ ...configuration, trustedSources: ["127.0.0.1"], allowLoopback: true, maximumScopes: [...configuration.maximumScopes] });
    expect(allowed.authorize({ remoteAddress: "127.0.0.1", headers })).toMatchObject({ identity: "operator@example.test", scopes: ["read", "tasks"] });
  });
});

describe("managed Tailscale exposure", () => {
  it("publishes loopback through tailnet-only Serve and resets only what it applied", async () => {
    const calls: string[][] = [];
    const runner: GatewayCommandRunner = { run: async (_executable, args) => {
      calls.push(args);
      return args[0] === "status"
        ? { exitCode: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "agent.example.ts.net." } }), stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    } };
    const manager = new TailscaleExposureManager({ mode: "serve", serviceName: "svc:workstrand", resetOnExit: true, publicExposureApproved: false }, runner);
    expect(await manager.apply("http://127.0.0.1:18789")).toEqual({ mode: "serve", active: true, url: "https://workstrand.example.ts.net/", detail: "Tailnet-only HTTPS exposure is active." });
    await manager.close();
    expect(calls).toEqual([
      ["status", "--json"],
      ["serve", "--bg", "--yes", "--service=svc:workstrand", "http://127.0.0.1:18789"],
      ["serve", "reset"]
    ]);
  });

  it("requires an explicit public acknowledgement for Funnel and refuses non-loopback targets", async () => {
    expect(() => new TailscaleExposureManager({ mode: "funnel", resetOnExit: true, publicExposureApproved: false })).toThrow("explicit public exposure approval");
    const runner: GatewayCommandRunner = { run: async () => ({ exitCode: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "agent.example.ts.net." } }), stderr: "" }) };
    const manager = new TailscaleExposureManager({ mode: "serve", resetOnExit: false, publicExposureApproved: false }, runner);
    await expect(manager.apply("http://0.0.0.0:18789")).rejects.toThrow("loopback");
  });

  it("throws an error if Tailscale status does not report an online device with MagicDNS", async () => {
    const errorMsg = "Tailscale status did not report an online device with MagicDNS.";

    let stdoutValue = "";
    const runner: GatewayCommandRunner = { run: async () => ({ exitCode: 0, stdout: stdoutValue, stderr: "" }) };
    const manager = new TailscaleExposureManager({ mode: "serve", resetOnExit: true, publicExposureApproved: false }, runner);

    // Invalid JSON
    stdoutValue = "invalid json";
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);

    // Missing BackendState
    stdoutValue = JSON.stringify({ Self: { Online: true, DNSName: "agent.example.ts.net." } });
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);

    // Not Running BackendState
    stdoutValue = JSON.stringify({ BackendState: "Stopped", Self: { Online: true, DNSName: "agent.example.ts.net." } });
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);

    // Missing Self
    stdoutValue = JSON.stringify({ BackendState: "Running" });
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);

    // Offline Self
    stdoutValue = JSON.stringify({ BackendState: "Running", Self: { Online: false, DNSName: "agent.example.ts.net." } });
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);

    // Missing DNSName
    stdoutValue = JSON.stringify({ BackendState: "Running", Self: { Online: true } });
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);

    // DNSName not a string
    stdoutValue = JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: 123 } });
    await expect(manager.apply("http://127.0.0.1:18789")).rejects.toThrow(errorMsg);
  });
});

describe("Bonjour gateway discovery", () => {
  it("publishes bounded non-secret hints and stops the one long-lived registration", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    let stopped = false;
    const runner: GatewayProcessRunner = { start: async (executable, args) => {
      calls.push({ executable, args });
      return { stop: async () => { stopped = true; } };
    } };
    const advertiser = new BonjourAdvertiser({ mode: "minimal", displayName: "Kestrel", tlsEnabled: true, tlsSha256: "a".repeat(64), cliPath: "/private/path" }, runner, "darwin");
    expect(await advertiser.start("https://0.0.0.0:18789")).toMatchObject({ active: true, mode: "minimal", serviceType: "_workstrand-gw._tcp" });
    expect(calls[0]?.executable).toBe("/usr/bin/dns-sd");
    expect(calls[0]?.args.slice(0, 5)).toEqual(["-R", "Kestrel", "_workstrand-gw._tcp", "local.", "18789"]);
    expect(calls[0]?.args).toContain("gatewayTls=1");
    expect(calls[0]?.args).toContain(`gatewayTlsSha256=${"a".repeat(64)}`);
    expect(calls[0]?.args.join(" ")).not.toContain("/private/path");
    await advertiser.close();
    expect(stopped).toBe(true);
    expect(() => new BonjourAdvertiser({ mode: "full", displayName: "Kestrel", tlsEnabled: false, cliPath: `/${"a".repeat(255)}` }, runner, "darwin")).toThrow("CLI path hint");
  });

  it("keeps discovery off without starting a process and rejects unsupported hosts", async () => {
    const runner: GatewayProcessRunner = { start: async () => { throw new Error("must not start"); } };
    expect(await new BonjourAdvertiser({ mode: "off", displayName: "Kestrel", tlsEnabled: false }, runner, "linux").start("http://127.0.0.1:1")).toMatchObject({ active: false });
    await expect(new BonjourAdvertiser({ mode: "minimal", displayName: "Kestrel", tlsEnabled: false }, runner, "linux").start("http://127.0.0.1:1")).rejects.toThrow("requires macOS");
  });
});
