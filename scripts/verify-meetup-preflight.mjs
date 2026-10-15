#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_DEVELOPMENT_LOCK_NAME,
  developmentLockDirectory,
} from "./desktop-dev-electron-lock.mjs";

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDevelopmentLockOwner(lockDirectory) {
  const ownerPath = join(lockDirectory, "owner.json");
  if (!existsSync(ownerPath)) return undefined;
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    return owner && typeof owner === "object" ? owner : undefined;
  } catch {
    return undefined;
  }
}

export function activeDevelopmentLock(
  lockDirectory = developmentLockDirectory(),
) {
  if (!existsSync(lockDirectory)) return undefined;

  const owner = readDevelopmentLockOwner(lockDirectory);
  const alivePids = [owner?.pid, owner?.childPid].filter(
    (pid) => Number.isInteger(pid) && processIsAlive(pid),
  );
  if (alivePids.length === 0) return undefined;

  return {
    lockDirectory,
    owner,
    alivePids,
  };
}

const ELECTRON_VITE_DEV_PATTERN = /\belectron-vite(?:\.js)?\s+dev(?:\s|--|$)/;
const NATIVE_CHROMIUM_DEV_PATTERN =
  /\bdev-native-chromium-host(?:\.mjs)?\b|\bdev-desktop-runtime(?:\.mjs)?\b/;

export function isElectronViteDevProcess({ command }) {
  if (/\bpkill\b/.test(command)) return false;
  return (
    ELECTRON_VITE_DEV_PATTERN.test(command) &&
    (/\bnode\b/.test(command) || /\/electron-vite(?:\.js)?\s+dev\b/.test(command))
  );
}

export function isNativeChromiumDevProcess({ command }) {
  if (/\bpkill\b/.test(command)) return false;
  return (
    NATIVE_CHROMIUM_DEV_PATTERN.test(command) &&
    (/\bnode\b/.test(command) || /\.mjs\b/.test(command))
  );
}

export function isDesktopDevWatcherProcess(processInfo) {
  return (
    isElectronViteDevProcess(processInfo) ||
    isNativeChromiumDevProcess(processInfo)
  );
}

export function parseProcessListing(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      if (separator === -1) return undefined;
      const pid = Number.parseInt(line.slice(0, separator), 10);
      const command = line.slice(separator + 1).trim();
      if (!Number.isInteger(pid) || !command) return undefined;
      return { pid, command };
    })
    .filter(Boolean);
}

export function findDesktopDevWatcherProcesses(
  listProcesses = defaultListProcesses,
) {
  return listProcesses().filter(isDesktopDevWatcherProcess);
}

/** @deprecated Prefer findDesktopDevWatcherProcesses */
export function findElectronViteDevProcesses(
  listProcesses = defaultListProcesses,
) {
  return listProcesses().filter(isElectronViteDevProcess);
}

function listPgrep(pattern) {
  try {
    const output = execFileSync("pgrep", ["-fl", pattern], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseProcessListing(output);
  } catch (error) {
    if (error?.status === 1) return [];
    throw error;
  }
}

function defaultListProcesses() {
  if (process.platform === "win32") return [];

  const byPid = new Map();
  for (const processInfo of [
    ...listPgrep("electron-vite"),
    ...listPgrep("dev-native-chromium"),
    ...listPgrep("dev-desktop-runtime"),
  ]) {
    byPid.set(processInfo.pid, processInfo);
  }
  return [...byPid.values()].filter(isDesktopDevWatcherProcess);
}

export function collectMeetupPreflightBlockers({
  lockDirectory = developmentLockDirectory(),
  listProcesses = defaultListProcesses,
} = {}) {
  const blockers = [];

  const lock = activeDevelopmentLock(lockDirectory);
  if (lock) {
    blockers.push({
      kind: "dev-lock",
      lockDirectory: lock.lockDirectory,
      alivePids: lock.alivePids,
    });
  }

  for (const processInfo of findDesktopDevWatcherProcesses(listProcesses)) {
    if (isNativeChromiumDevProcess(processInfo)) {
      blockers.push({
        kind: "native-chromium-dev",
        pid: processInfo.pid,
        command: processInfo.command,
      });
      continue;
    }
    blockers.push({
      kind: "electron-vite-dev",
      pid: processInfo.pid,
      command: processInfo.command,
    });
  }

  return blockers;
}

export function formatMeetupPreflightError(
  blockers,
  lockDirectory = developmentLockDirectory(),
) {
  const lines = [
    "verify:meetup preflight failed: desktop development session is still active.",
    "",
    "Stop the Chromium (default) or Electron dev watcher before running verify:meetup:",
    '  pkill -f "dev-native-chromium-host"',
    '  pkill -f "electron-vite dev"',
    "  # or stop the terminal running: corepack pnpm dev:desktop",
    "",
    "Clear the product-scoped desktop dev lock if it remains:",
    `  rm -rf ${JSON.stringify(lockDirectory)}`,
    `  # default lock name: ${DEFAULT_DEVELOPMENT_LOCK_NAME}`,
    "",
    "Detected:",
  ];

  for (const blocker of blockers) {
    if (blocker.kind === "dev-lock") {
      lines.push(
        `  - desktop dev lock at ${blocker.lockDirectory} (alive pid(s): ${blocker.alivePids.join(", ")})`,
      );
      continue;
    }
    if (blocker.kind === "native-chromium-dev") {
      lines.push(
        `  - native Chromium host watcher pid ${blocker.pid}: ${blocker.command}`,
      );
      continue;
    }
    lines.push(
      `  - electron-vite dev pid ${blocker.pid}: ${blocker.command}`,
    );
  }

  return lines.join("\n");
}

function main() {
  const blockers = collectMeetupPreflightBlockers();
  if (blockers.length > 0) {
    console.error(formatMeetupPreflightError(blockers));
    process.exit(1);
  }
  console.log(
    "verify:meetup preflight ok — no Chromium/Electron dev watcher or desktop dev lock detected.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
