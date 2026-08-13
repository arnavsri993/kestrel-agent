#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "../apps/desktop");
const electronPackageDirectory = dirname(
  require.resolve("electron", { paths: [desktopDirectory] }),
);
const electronExecutable =
  process.env.KESTREL_REAL_ELECTRON_EXEC_PATH ??
  join(
    electronPackageDirectory,
    "dist",
    readFileSync(join(electronPackageDirectory, "path.txt"), "utf8").trim(),
  );
const lockKey = createHash("sha256")
  .update(`${desktopDirectory}:${electronExecutable}`)
  .digest("hex")
  .slice(0, 16);
const lockDirectory =
  process.env.KESTREL_DEV_ELECTRON_LOCK_PATH ??
  join(tmpdir(), `kestrel-electron-dev-${lockKey}.lock`);
const lockOwnerPath = join(lockDirectory, "owner.json");

let child;
let shuttingDown = false;

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function readOwner() {
  try {
    const owner = JSON.parse(readFileSync(lockOwnerPath, "utf8"));
    return owner && typeof owner === "object" ? owner : undefined;
  } catch {
    return undefined;
  }
}

function ownerPid() {
  const owner = readOwner();
  return Number.isInteger(owner?.pid) ? owner.pid : null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock() {
  const pid = ownerPid();
  if (pid !== null) return !processIsAlive(pid);
  try {
    return Date.now() - statSync(lockDirectory).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

async function acquireLock() {
  while (true) {
    try {
      mkdirSync(lockDirectory);
      writeFileSync(
        lockOwnerPath,
        JSON.stringify({ pid: process.pid, parentPid: process.ppid }),
      );
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readOwner();
      const ownerPidValue = ownerPid();
      if (ownerPidValue !== null && processIsAlive(ownerPidValue)) {
        if (owner?.parentPid !== process.ppid) {
          console.error("Kestrel desktop development session is already running.");
          process.exit(0);
        }
        await delay(50);
        continue;
      }
      if (removeStaleLock()) {
        rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }
      await delay(50);
    }
  }
}

function releaseLock() {
  if (ownerPid() !== process.pid) return;
  rmSync(lockDirectory, { recursive: true, force: true });
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (ownerPid() === process.pid)
    writeFileSync(
      lockOwnerPath,
      JSON.stringify({ pid: process.pid, parentPid: process.ppid, stopping: true }),
    );
  if (!child) {
    releaseLock();
    process.exit(0);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  const forceKillTimer = setTimeout(() => {
    if (child?.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 5_000);
  forceKillTimer.unref();
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

await acquireLock();
if (shuttingDown) {
  releaseLock();
  process.exit(0);
}

child = spawn(electronExecutable, process.argv.slice(2), {
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error);
  releaseLock();
  process.exit(1);
});
child.once("close", (code, signal) => {
  releaseLock();
  process.exit(code ?? (signal ? 1 : 0));
});
