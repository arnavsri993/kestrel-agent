import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export async function writeTextFileAtomically(
  path: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${path}.new-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
