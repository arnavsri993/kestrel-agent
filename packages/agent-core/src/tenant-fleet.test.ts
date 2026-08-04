import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TenantFleet, type TenantFleetRunner } from "./tenant-fleet";

describe("tenant fleet", () => {
  it("creates one hardened loopback-only cell and keeps data on removal", async () => {
    const calls: string[][] = [];
    const runner: TenantFleetRunner = { run: async (_executable, args) => {
      calls.push(args);
      if (args[0] === "inspect") return { exitCode: 0, stdout: "true\n", stderr: "" };
      return { exitCode: 0, stdout: "ok", stderr: "" };
    } };
    const root = mkdtempSync(join(tmpdir(), "kestrel-fleet-"));
    const fleet = new TenantFleet(root, runner, () => new Date("2026-07-23T12:00:00.000Z"));
    const created = await fleet.create({ tenant: "Acme", port: 18790 });
    expect(created.gatewayToken).toHaveLength(43);
    const run = calls.find((args) => args[0] === "run")!;
    expect(run).toEqual(expect.arrayContaining(["--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "127.0.0.1:18790:18789"]));
    expect(run.join(" ")).not.toContain("0.0.0.0");
    expect(await fleet.status(" ACME ")).toMatchObject({ running: true, cell: { tenant: "acme" } });
    await fleet.remove(" ACME ");
    expect(await fleet.list()).toEqual([]);
  });

  it("rejects shared identities, privileged ports, and unsafe Docker egress claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-fleet-"));
    const runner: TenantFleetRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
    const fleet = new TenantFleet(root, runner);
    await expect(fleet.create({ tenant: "../escape", port: 18790 })).rejects.toThrow("name");
    await expect(fleet.create({ tenant: "acme", port: 80 })).rejects.toThrow("port");
    await expect(fleet.create({ tenant: "acme", port: 18790, blockEgress: true })).rejects.toThrow("firewall");
  });

  it("preserves cells created concurrently by separate fleet instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-fleet-concurrent-"));
    const runner: TenantFleetRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
    const first = new TenantFleet(root, runner);
    const second = new TenantFleet(root, runner);

    await Promise.all([
      first.create({ tenant: "first", port: 18790 }),
      second.create({ tenant: "second", port: 18791 })
    ]);

    expect((await first.list()).map((cell) => cell.tenant)).toEqual(["first", "second"]);
  });
});
