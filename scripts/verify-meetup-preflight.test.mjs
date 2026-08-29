import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  activeDevelopmentLock,
  collectMeetupPreflightBlockers,
  findElectronViteDevProcesses,
  formatMeetupPreflightError,
  parseProcessListing,
  processIsAlive,
} from "./verify-meetup-preflight.mjs";

describe("verify:meetup preflight", () => {
  it("treats the current process as alive", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("treats impossible pids as not alive", () => {
    expect(processIsAlive(987_654_321)).toBe(false);
  });

  it("detects an active development lock with a live owner pid", () => {
    const lockDirectory = mkdtempSync(
      join(tmpdir(), "kestrel-meetup-preflight-lock-"),
    );
    writeFileSync(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: process.pid, parentPid: process.ppid }),
    );

    expect(activeDevelopmentLock(lockDirectory)).toMatchObject({
      lockDirectory,
      alivePids: [process.pid],
    });
  });

  it("ignores stale development locks", () => {
    const lockDirectory = mkdtempSync(
      join(tmpdir(), "kestrel-meetup-preflight-stale-"),
    );
    writeFileSync(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: 987_654_321, childPid: 987_654_322 }),
    );

    expect(activeDevelopmentLock(lockDirectory)).toBeUndefined();
  });

  it("ignores shell wrappers that only mention electron-vite in pkill", () => {
    const processes = parseProcessListing(
      '37469 /bin/zsh -c pkill -f "electron-vite dev" && corepack pnpm dev:desktop',
    );

    expect(findElectronViteDevProcesses(() => processes)).toEqual([]);
  });

  it("parses pgrep output and filters electron-vite dev processes", () => {
    const processes = parseProcessListing(
      [
        "12345 node /repo/node_modules/.bin/electron-vite dev --watch",
        "67890 node /repo/node_modules/.bin/vitest run",
      ].join("\n"),
    );

    expect(findElectronViteDevProcesses(() => processes)).toEqual([
      {
        pid: 12345,
        command: "node /repo/node_modules/.bin/electron-vite dev --watch",
      },
    ]);
  });

  it("collects both lock and watcher blockers", () => {
    const lockDirectory = mkdtempSync(
      join(tmpdir(), "kestrel-meetup-preflight-both-"),
    );
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(
      join(lockDirectory, "owner.json"),
      JSON.stringify({ pid: process.pid }),
    );

    const blockers = collectMeetupPreflightBlockers({
      lockDirectory,
      listProcesses: () => [
        {
          pid: 4242,
          command: "node electron-vite dev --watch",
        },
      ],
    });

    expect(blockers).toEqual([
      {
        kind: "dev-lock",
        lockDirectory,
        alivePids: [process.pid],
      },
      {
        kind: "electron-vite-dev",
        pid: 4242,
        command: "node electron-vite dev --watch",
      },
    ]);
  });

  it("formats an actionable preflight error", () => {
    const lockDirectory = "/tmp/kestrel-electron-dev.lock";
    const message = formatMeetupPreflightError(
      [
        {
          kind: "dev-lock",
          lockDirectory,
          alivePids: [111],
        },
        {
          kind: "electron-vite-dev",
          pid: 222,
          command: "node electron-vite dev --watch",
        },
      ],
      lockDirectory,
    );

    expect(message).toContain("verify:meetup preflight failed");
    expect(message).toContain('pkill -f "electron-vite dev"');
    expect(message).toContain('rm -rf "/tmp/kestrel-electron-dev.lock"');
    expect(message).toContain("alive pid(s): 111");
    expect(message).toContain("electron-vite dev pid 222");
  });
});
