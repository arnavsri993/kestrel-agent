import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalBackupMetadata } from "./backup-metadata";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local backup metadata", () => {
  it("reads valid metadata and tolerates missing or malformed files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kestrel-backup-metadata-"));
    directories.push(directory);
    const path = join(directory, "last-backup.json");

    await expect(readLocalBackupMetadata(path)).resolves.toBeUndefined();
    writeFileSync(path, "not-json");
    await expect(readLocalBackupMetadata(path)).resolves.toBeUndefined();
    writeFileSync(path, JSON.stringify({ path: "/tmp/backup", createdAt: "2026-07-31T00:00:00.000Z" }));
    await expect(readLocalBackupMetadata(path)).resolves.toEqual({ path: "/tmp/backup", createdAt: "2026-07-31T00:00:00.000Z" });
  });

  it("ignores oversized metadata before parsing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kestrel-backup-metadata-large-"));
    directories.push(directory);
    const path = join(directory, "last-backup.json");
    writeFileSync(path, JSON.stringify({ path: "/tmp/backup", createdAt: "2026-07-31T00:00:00.000Z", padding: "x".repeat(64_001) }));

    await expect(readLocalBackupMetadata(path)).resolves.toBeUndefined();
  });
});
