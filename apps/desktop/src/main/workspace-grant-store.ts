import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import { WorkspaceGrantSchema, type WorkspaceGrant } from "@kestrel/shared-types";

const mutationQueues = new Map<string, Promise<void>>();

export class WorkspaceGrantStore {
  constructor(private readonly filename: string) {}

  async configuredPaths(): Promise<string[]> {
    return (await this.configuredGrants()).map((grant) => grant.path);
  }

  async list(): Promise<WorkspaceGrant[]> {
    const configured = await this.configuredGrants();
    const grants: WorkspaceGrant[] = [];
    for (const grant of configured) {
      try {
        const canonical = this.validateRoot(grant.path);
        if ((await stat(canonical)).isDirectory())
          grants.push({ path: canonical, name: basename(canonical) });
      } catch {
        // Missing, moved, or newly unsafe roots remain configured but are not active.
      }
    }
    return [...new Map(grants.map((grant) => [grant.path, grant])).values()];
  }

  async statusList(): Promise<WorkspaceGrant[]> {
    const configured = await this.configuredGrants();
    const grants: WorkspaceGrant[] = [];
    for (const grant of configured) {
      let available = false;
      try {
        const canonical = this.validateRoot(grant.path);
        available = (await stat(canonical)).isDirectory();
      } catch {
        // Keep unavailable grants visible so the user can explicitly revoke them.
      }
      grants.push({ ...grant, available });
    }
    return grants;
  }

  async add(path: string): Promise<WorkspaceGrant[]> {
    const canonical = this.validateRoot(path);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("Workspace grants require a directory.");
    await this.mutate(async () => {
      const grants = await this.configuredGrants();
      if (!grants.some((grant) => grant.path === canonical))
        grants.push({ path: canonical, name: basename(canonical) });
      await this.save(grants);
    });
    return this.list();
  }

  async remove(path: string): Promise<WorkspaceGrant[]> {
    let canonical = path;
    try {
      canonical = this.validateRoot(path);
    } catch {
      // A missing stored path can still be removed by its exact value.
    }
    await this.mutate(async () => {
      const grants = (await this.configuredGrants()).filter(
        (grant) => grant.path !== canonical && grant.path !== path,
      );
      await this.save(grants);
    });
    return this.list();
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.filename) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    mutationQueues.set(this.filename, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (mutationQueues.get(this.filename) === queued)
        mutationQueues.delete(this.filename);
    }
  }

  private async configuredGrants(): Promise<WorkspaceGrant[]> {
    let values: unknown;
    try {
      values = JSON.parse(await readFile(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!Array.isArray(values)) return [];
    const grants: WorkspaceGrant[] = [];
    for (const value of values) {
      const parsed = WorkspaceGrantSchema.safeParse(value);
      if (!parsed.success) continue;
      const normalized = resolve(parsed.data.path);
      if (
        normalized !== parsed.data.path ||
        normalized === parse(normalized).root ||
        normalized === resolve(homedir())
      )
        continue;
      grants.push({ path: normalized, name: basename(normalized) });
    }
    return [...new Map(grants.map((grant) => [grant.path, grant])).values()];
  }

  private validateRoot(path: string): string {
    const canonical = realpathSync(resolve(path));
    const volumeRoot = parse(canonical).root;
    if (canonical === volumeRoot) throw new Error("A whole filesystem volume cannot be granted as a workspace.");
    if (canonical === realpathSync(homedir())) throw new Error("Grant a project folder instead of the entire home directory.");
    return canonical;
  }

  private async save(grants: WorkspaceGrant[]): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(grants, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
      await rename(temporary, this.filename);
      await chmod(this.filename, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
