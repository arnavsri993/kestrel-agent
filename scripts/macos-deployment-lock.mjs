import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function deploymentPaths(installRoot) {
  const root = resolve(installRoot);
  return { lock: join(root, ".Kestrel-deployment.lock"),
    active: join(root, ".Kestrel-deployment-active.json"),
    owner: join(root, ".Kestrel-deployment-owner.json") };
}

export function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

// macOS BSD flock is held by lockf for the entire child lifetime. Keep its
// inode permanently (-k): unlinking an idle lock creates a second lock domain.
// Kernel release on exit/crash gives stale-lock recovery without deleting a
// live owner's lock or trusting PID age. Metadata is diagnostic, not the lock.
export function enterDeploymentLock(script, installRoot, intended = {}) {
  const paths = deploymentPaths(installRoot);
  mkdirSync(resolve(installRoot), { recursive: true });
  const inherited = process.env.KESTREL_INTERNAL_DEPLOYMENT_TOKEN;
  const index = process.argv.indexOf("--deployment-lock-token");
  if (index !== -1) {
    if (!inherited || process.argv[index + 1] !== inherited)
      throw new Error("Deployment lock must be acquired through the installer.");
    const inode = statSync(paths.lock).ino;
    const active = { format: 1, token: inherited, pid: process.pid,
      startedAt: new Date().toISOString(), inode, ...intended };
    atomicJson(paths.active, active);
    return () => {
      const current = JSON.parse(readFileSync(paths.active, "utf8"));
      if (current.token !== inherited || current.pid !== process.pid || statSync(paths.lock).ino !== inode)
        throw new Error("Deployment ownership changed; refusing canonical replacement.");
    };
  }
  if (!existsSync("/usr/bin/lockf")) throw new Error("macOS lockf is required for canonical deployment.");
  const token = randomUUID();
  console.log("Waiting for the canonical Kestrel deployment lock…");
  const result = spawnSync("/usr/bin/lockf", ["-k", "-t", "120", paths.lock,
    process.execPath, script, ...process.argv.slice(2), "--deployment-lock-token", token],
    { stdio: "inherit", env: { ...process.env, KESTREL_INTERNAL_DEPLOYMENT_TOKEN: token } });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
