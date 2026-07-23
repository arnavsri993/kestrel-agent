import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import { WorkspaceGrantSchema, type WorkspaceGrant } from "@kestrel/shared-types";

export class WorkspaceGrantStore {
  constructor(private readonly filename: string) {}

  async list(): Promise<WorkspaceGrant[]> {
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
      try {
        const canonical = this.validateRoot(parsed.data.path);
        if ((await stat(canonical)).isDirectory()) grants.push({ path: canonical, name: basename(canonical) });
      } catch {
        // Missing, moved, or newly unsafe roots are not re-granted at launch.
      }
    }
    return [...new Map(grants.map((grant) => [grant.path, grant])).values()];
  }

  async add(path: string): Promise<WorkspaceGrant[]> {
    const canonical = this.validateRoot(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace grants require a directory.");
    const grants = await this.list();
    if (!grants.some((grant) => grant.path === canonical)) grants.push({ path: canonical, name: basename(canonical) });
    await this.save(grants);
    return grants;
  }

  async remove(path: string): Promise<WorkspaceGrant[]> {
    let canonical = path;
    try { canonical = this.validateRoot(path); } catch { /* A missing stored path can still be removed by its exact value. */ }
    const grants = (await this.list()).filter((grant) => grant.path !== canonical && grant.path !== path);
    await this.save(grants);
    return grants;
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
