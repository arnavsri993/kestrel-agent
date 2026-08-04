import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimePreferencesFile } from "./runtime-preferences";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime preferences", () => {
  it("falls back for missing and malformed preference files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kestrel-runtime-preferences-"));
    directories.push(directory);
    const path = join(directory, "runtime-preferences.json");

    await expect(readRuntimePreferencesFile(path)).resolves.toEqual({});
    writeFileSync(path, "not-json");
    await expect(readRuntimePreferencesFile(path)).resolves.toEqual({});
  });

  it("ignores oversized preference state before parsing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kestrel-runtime-preferences-large-"));
    directories.push(directory);
    const path = join(directory, "runtime-preferences.json");
    writeFileSync(path, JSON.stringify({ subscriptions: { codex: { enabled: true, path: "/tmp/codex" } }, padding: "x".repeat(64_001) }));

    await expect(readRuntimePreferencesFile(path)).resolves.toEqual({});
  });
});
