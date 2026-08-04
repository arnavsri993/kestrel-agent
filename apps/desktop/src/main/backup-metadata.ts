import { readFile, stat } from "node:fs/promises";

const MAX_BACKUP_METADATA_BYTES = 64_000;

export interface LocalBackupMetadata {
  path?: unknown;
  createdAt?: unknown;
}

export async function readLocalBackupMetadata(path: string): Promise<LocalBackupMetadata | undefined> {
  try {
    if ((await stat(path)).size > MAX_BACKUP_METADATA_BYTES) return undefined;
    const contents = await readFile(path, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_BACKUP_METADATA_BYTES) return undefined;
    const value: unknown = JSON.parse(contents);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as LocalBackupMetadata)
      : undefined;
  } catch {
    return undefined;
  }
}
