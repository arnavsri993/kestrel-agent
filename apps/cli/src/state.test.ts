import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKestrel } from "./state";

const directories: string[] = [];
const previousDataDirectory = process.env.KESTREL_DATA_DIR;

afterEach(() => {
  if (previousDataDirectory === undefined)
    delete process.env.KESTREL_DATA_DIR;
  else process.env.KESTREL_DATA_DIR = previousDataDirectory;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("CLI state", () => {
  it("preserves configured session roots while unavailable and restores tools when they return", async () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-cli-state-"));
    directories.push(container);
    const dataDirectory = join(container, "data");
    const workspaceRoot = join(container, "external-workspace");
    mkdirSync(workspaceRoot);
    process.env.KESTREL_DATA_DIR = dataDirectory;

    const initial = openKestrel([workspaceRoot]);
    const session = initial.runtime.createSession({
      title: "External project",
      workspaceRoot,
    });
    const persistedRoot = session.workspaceRoot!;
    await initial.close();
    rmSync(workspaceRoot, { recursive: true });

    const unavailable = openKestrel();
    expect(unavailable.runtime.getSession(session.id).workspaceRoot).toBe(
      persistedRoot,
    );
    expect(
      unavailable.runtime
        .discoverTools(session.id)
        .filter((tool) => tool.requiresWorkspace),
    ).toEqual([]);
    await unavailable.close();

    mkdirSync(workspaceRoot);
    const restored = openKestrel();
    expect(restored.runtime.getSession(session.id).workspaceRoot).toBe(
      persistedRoot,
    );
    expect(
      restored.runtime
        .discoverTools(session.id)
        .some((tool) => tool.name === "workspace.read"),
    ).toBe(true);
    await restored.close();
  });

  it("rejects an oversized encryption key before decoding it", () => {
    const container = mkdtempSync(join(tmpdir(), "kestrel-cli-state-key-large-"));
    directories.push(container);
    const dataDirectory = join(container, "data");
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "encryption.key"), Buffer.alloc(129));
    process.env.KESTREL_DATA_DIR = dataDirectory;

    expect(() => openKestrel()).toThrow("Kestrel data key is invalid");
  });
});
