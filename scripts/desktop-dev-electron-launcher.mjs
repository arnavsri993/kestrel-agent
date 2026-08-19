#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { developmentLockDirectory } from "./desktop-dev-electron-lock.mjs";

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "../apps/desktop");
const electronPackageDirectory = dirname(
  require.resolve("electron", { paths: [desktopDirectory] }),
);
function resolveElectronExecutable() {
  if (process.env.KESTREL_REAL_ELECTRON_EXEC_PATH)
    return process.env.KESTREL_REAL_ELECTRON_EXEC_PATH;
  const distDirectory = join(electronPackageDirectory, "dist");
  const pathFile = join(electronPackageDirectory, "path.txt");
  const relativeExecutablePath = existsSync(pathFile)
    ? readFileSync(pathFile, "utf8").trim()
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : process.platform === "win32"
        ? "electron.exe"
        : "electron";
  const executable = join(distDirectory, relativeExecutablePath);
  if (!existsSync(executable))
    throw new Error(
      `Electron's downloaded binary is missing at ${executable}. Run pnpm install or pnpm rebuild electron before starting Kestrel.`,
    );
  return executable;
}
const rawElectronExecutable = resolveElectronExecutable();

function resolveNodeExecutable() {
  if (process.env.KESTREL_NODE_EXEC_PATH)
    return process.env.KESTREL_NODE_EXEC_PATH;
  if (!process.versions.bun) return process.execPath;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "node");
    if (!existsSync(candidate) || candidate === process.execPath) continue;
    try {
      const runtime = execFileSync(
        candidate,
        ["-p", "process.versions.bun ? 'bun' : process.release.name"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (runtime === "node") return candidate;
    } catch {
      // Keep searching PATH for a real Node binary when pnpm was launched by Bun.
    }
  }
  throw new Error(
    "Kestrel development requires a real Node.js executable for Agent Core. Set KESTREL_NODE_EXEC_PATH to its path.",
  );
}
const nodeExecutable = resolveNodeExecutable();
const lockDirectory = developmentLockDirectory();
const lockOwnerPath = join(lockDirectory, "owner.json");

let child;
let shuttingDown = false;
let heartbeat;
let parentMonitor;

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
    JSON.stringify({
      pid: process.pid,
      parentPid: process.ppid,
      ...(child?.pid ? { childPid: child.pid } : {}),
    }),
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
        if (Date.now() - waitStartedAt >= 5_000) {
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
  if (parentMonitor) clearInterval(parentMonitor);
  if (!child) {
    releaseLock();
    process.exit(0);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function brandedMacElectronExecutable(rawExecutable) {
  if (process.platform !== "darwin") return rawExecutable;

  const electronApp = resolve(dirname(rawExecutable), "..", "..");
  const iconPath = join(desktopDirectory, "build", "icon.icns");
  const electronVersion = (() => {
    try {
      const packageJson = JSON.parse(
        readFileSync(join(electronPackageDirectory, "package.json"), "utf8"),
      );
      return typeof packageJson.version === "string"
        ? packageJson.version
        : "unknown";
    } catch {
      return "unknown";
    }
  })();
  const iconDigest = existsSync(iconPath)
    ? createHash("sha256").update(readFileSync(iconPath)).digest("hex").slice(0, 12)
    : "default";
  const runtimeKey = createHash("sha256")
    .update(`${electronVersion}:${process.arch}:${iconDigest}`)
    .digest("hex")
    .slice(0, 16);
  const runtimeRoot = join(tmpdir(), `kestrel-electron-runtime-${runtimeKey}`);
  const brandedApp = join(runtimeRoot, "Kestrel.app");
  const brandedExecutable = join(brandedApp, "Contents", "MacOS", "Kestrel");
  if (existsSync(brandedExecutable)) return brandedExecutable;

  mkdirSync(runtimeRoot, { recursive: true });
  const stageRoot = mkdtempSync(join(tmpdir(), "kestrel-electron-stage-"));
  const stagedApp = join(stageRoot, "Kestrel.app");
  try {
    execFileSync(
      "/usr/bin/ditto",
      ["--rsrc", "--extattr", "--acl", electronApp, stagedApp],
      { stdio: "ignore" },
    );
    const infoPlist = join(stagedApp, "Contents", "Info.plist");
    const stagedExecutable = join(stagedApp, "Contents", "MacOS", "Electron");
    const renamedExecutable = join(stagedApp, "Contents", "MacOS", "Kestrel");
    renameSync(stagedExecutable, renamedExecutable);
    execFileSync(
      "/usr/bin/plutil",
      ["-replace", "CFBundleName", "-string", "Kestrel", infoPlist],
      { stdio: "ignore" },
    );
    execFileSync(
      "/usr/bin/plutil",
      ["-replace", "CFBundleDisplayName", "-string", "Kestrel", infoPlist],
      { stdio: "ignore" },
    );
    execFileSync(
      "/usr/bin/plutil",
      ["-replace", "CFBundleExecutable", "-string", "Kestrel", infoPlist],
      { stdio: "ignore" },
    );
    if (existsSync(iconPath)) {
      const stagedIcon = join(stagedApp, "Contents", "Resources", "kestrel.icns");
      copyFileSync(iconPath, stagedIcon);
      execFileSync(
        "/usr/bin/plutil",
        ["-replace", "CFBundleIconFile", "-string", "kestrel.icns", infoPlist],
        { stdio: "ignore" },
      );
    }
    try {
      renameSync(stagedApp, brandedApp);
    } catch (error) {
      if (!existsSync(brandedExecutable)) throw error;
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  return brandedExecutable;
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

await acquireLock();
if (shuttingDown) {
  releaseLock();
  process.exit(0);
}

const electronExecutable = brandedMacElectronExecutable(rawElectronExecutable);
const macArmDevelopmentRuntime =
  process.platform === "darwin" && process.arch === "arm64";
const disableGpu =
  process.env.KESTREL_DISABLE_GPU === "1" ||
  (macArmDevelopmentRuntime && process.env.KESTREL_ENABLE_GPU !== "1");
const disableJit =
  process.env.KESTREL_DISABLE_JIT === "1" ||
  (macArmDevelopmentRuntime && process.env.KESTREL_ENABLE_JIT !== "1");
const extraElectronArgs = [
  ...(disableGpu
    ? [
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-gpu-sandbox",
        "--use-angle=swiftshader",
      ]
    : []),
  ...(disableJit ? ["--js-flags=--jitless"] : []),
];
const childEnvironment = {
  ...process.env,
  ...(disableGpu ? { KESTREL_DISABLE_GPU: "1" } : {}),
  ...(disableJit ? { KESTREL_DISABLE_JIT: "1" } : {}),
  KESTREL_DEV_ELECTRON_HEARTBEAT: lockOwnerPath,
  KESTREL_NODE_EXEC_PATH: nodeExecutable,
};
child = spawn(electronExecutable, [...extraElectronArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: childEnvironment,
});
writeOwner();
const launcherParentPid = process.ppid;
parentMonitor = setInterval(() => {
  if (process.ppid !== launcherParentPid) stop("SIGTERM");
}, 250);
heartbeat = setInterval(() => {
  try {
    writeOwner();
  } catch {
    stop("SIGTERM");
  }
}, 100);
child.once("error", (error) => {
  if (heartbeat) clearInterval(heartbeat);
  if (parentMonitor) clearInterval(parentMonitor);
  console.error(error);
  releaseLock();
  process.exit(1);
});
child.once("close", (code, signal) => {
  if (heartbeat) clearInterval(heartbeat);
  if (parentMonitor) clearInterval(parentMonitor);
  releaseLock();
  process.exit(code ?? (signal ? 1 : 0));
});
