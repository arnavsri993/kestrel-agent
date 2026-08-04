import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTextFileAtomically } from "./atomic-file";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("writeTextFileAtomically", () => {
  it("removes its staged file when replacing the destination fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-atomic-file-test-"));
    roots.push(root);
    const path = join(root, "runtime-preferences.json");
    await mkdir(path);

    await expect(
      writeTextFileAtomically(path, '{"enabled":true}\n'),
    ).rejects.toThrow();

    await expect(readdir(root)).resolves.toEqual(["runtime-preferences.json"]);
  });
});
