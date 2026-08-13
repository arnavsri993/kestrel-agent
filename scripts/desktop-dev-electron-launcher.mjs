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
let heartbeat;

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

function writeOwner() {
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({ pid: process.pid, childPid: child?.pid }),
  );
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
  if (pid !== null && processIsAlive(pid)) return false;
  const childPid = readOwner()?.childPid;
  if (Number.isInteger(childPid) && processIsAlive(childPid)) return false;
  if (pid !== null) return true;
  try {
    return Date.now() - statSync(lockDirectory).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

async function acquireLock() {
  const waitStartedAt = Date.now();
  while (true) {
    try {
      mkdirSync(lockDirectory);
      writeOwner();
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
        if (!owner?.stopping && Date.now() - waitStartedAt >= 5_000) {
          console.error("Kestrel desktop development restart was superseded.");
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
  if (heartbeat) clearInterval(heartbeat);
  if (!child) {
    releaseLock();
    process.exit(0);
  }
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

await acquireLock();
if (shuttingDown) {
  releaseLock();
  process.exit(0);
}

child = spawn(electronExecutable, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    KESTREL_DEV_ELECTRON_HEARTBEAT: lockOwnerPath,
  },
});
writeOwner();
heartbeat = setInterval(() => {
  try {
    writeOwner();
  } catch {
    stop("SIGTERM");
  }
}, 100);
child.once("error", (error) => {
  if (heartbeat) clearInterval(heartbeat);
  console.error(error);
  releaseLock();
  process.exit(1);
});
child.once("close", (code, signal) => {
  if (heartbeat) clearInterval(heartbeat);
  releaseLock();
  process.exit(code ?? (signal ? 1 : 0));
});
