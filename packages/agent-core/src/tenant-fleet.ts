import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TenantCell {
  tenant: string;
  container: string;
  port: number;
  image: string;
  runtime: "docker" | "podman";
  createdAt: string;
}
export interface TenantFleetRunner { run(executable: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>; }
const fleetMutationQueues = new Map<string, Promise<void>>();
const tenantNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeTenantName(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!tenantNamePattern.test(tenant)) throw new Error("Tenant cell name is invalid.");
  return tenant;
}

class ProcessFleetRunner implements TenantFleetRunner {
  run(executable: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])) });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
      const capture = (target: Buffer[]) => (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 1_000_000) child.kill("SIGKILL"); else target.push(chunk); };
      child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    });
  }
}

export class TenantFleet {
  private readonly root: string;
  private readonly registryPath: string;
  constructor(stateRoot: string, private readonly runner: TenantFleetRunner = new ProcessFleetRunner(), private readonly now: () => Date = () => new Date()) {
    this.root = resolve(stateRoot, "fleet");
    this.registryPath = join(this.root, "cells.json");
    mkdirSync(join(this.root, "cells"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "auth-profile-secrets"), { recursive: true, mode: 0o700 });
  }

  async list(): Promise<TenantCell[]> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, "utf8")) as TenantCell[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async create(input: { tenant: string; port: number; runtime?: "docker" | "podman"; image?: string; blockEgress?: boolean }): Promise<{ cell: TenantCell; gatewayToken: string }> {
    const tenant = normalizeTenantName(input.tenant);
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65_535) throw new Error("Tenant cell port is invalid.");
    const runtime = input.runtime ?? "docker";
    if (runtime === "docker" && input.blockEgress) throw new Error("Docker internal networking breaks the published gateway port; use host firewall policy.");
    const image = input.image ?? "ghcr.io/kestrel-ai/kestrel:latest";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,500}$/.test(image)) throw new Error("Tenant cell image is invalid.");
    return this.mutate(async () => {
      const cells = await this.list();
      if (cells.some((cell) => cell.tenant === tenant || cell.port === input.port)) throw new Error("Tenant cell or loopback port already exists.");
      const state = join(this.root, "cells", tenant);
      const auth = join(this.root, "auth-profile-secrets", tenant);
      mkdirSync(state, { recursive: false, mode: 0o700 });
      mkdirSync(auth, { recursive: false, mode: 0o700 });
      const token = randomBytes(32).toString("base64url");
      const container = `kestrel-cell-${tenant}`;
      const network = `kestrel-cell-${tenant}`;
      const networkResult = await this.runner.run(runtime, ["network", "create", ...(runtime === "podman" && input.blockEgress ? ["--internal"] : []), network]);
      if (networkResult.exitCode !== 0) throw new Error(`Could not create tenant network: ${networkResult.stderr.slice(0, 500)}`);
      const args = ["run", "-d", "--name", container, "--network", network, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=4g", "--cpus=2", "--read-only", "--tmpfs=/tmp:rw,noexec,nosuid,size=256m", "-p", `127.0.0.1:${input.port}:18789`, "-v", `${state}:/home/node/.kestrel`, "-v", `${auth}:/home/node/.config/kestrel`, "-e", `KESTREL_GATEWAY_TOKEN=${token}`, image];
      const result = await this.runner.run(runtime, args);
      if (result.exitCode !== 0) {
        await this.runner.run(runtime, ["network", "rm", network]);
        throw new Error(`Could not start tenant cell: ${result.stderr.slice(0, 500)}`);
      }
      const cell: TenantCell = { tenant, container, port: input.port, image, runtime, createdAt: this.now().toISOString() };
      await this.save([...cells, cell]);
      return { cell, gatewayToken: token };
    });
  }

  async status(tenant: string): Promise<{ cell: TenantCell; running: boolean }> {
    const normalizedTenant = normalizeTenantName(tenant);
    const cell = (await this.list()).find((candidate) => candidate.tenant === normalizedTenant);
    if (!cell) throw new Error("Tenant cell was not found.");
    const result = await this.runner.run(cell.runtime, ["inspect", "-f", "{{.State.Running}}", cell.container]);
    return { cell, running: result.exitCode === 0 && result.stdout.trim() === "true" };
  }

  async remove(tenant: string): Promise<TenantCell> {
    return this.mutate(async () => {
      const normalizedTenant = normalizeTenantName(tenant);
      const cells = await this.list();
      const cell = cells.find((candidate) => candidate.tenant === normalizedTenant);
      if (!cell) throw new Error("Tenant cell was not found.");
      const result = await this.runner.run(cell.runtime, ["rm", "-f", cell.container]);
      if (result.exitCode !== 0) throw new Error(`Could not remove tenant cell: ${result.stderr.slice(0, 500)}`);
      await this.runner.run(cell.runtime, ["network", "rm", `kestrel-cell-${cell.tenant}`]);
      await this.save(cells.filter((candidate) => candidate.tenant !== normalizedTenant));
      return cell;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = fleetMutationQueues.get(this.registryPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    fleetMutationQueues.set(this.registryPath, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (fleetMutationQueues.get(this.registryPath) === queued) fleetMutationQueues.delete(this.registryPath);
    }
  }

  private async save(cells: TenantCell[]): Promise<void> {
    const temporary = `${this.registryPath}.new`;
    await writeFile(temporary, `${JSON.stringify(cells, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.registryPath);
  }
}
