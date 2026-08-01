import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedFile } from "./bounded-file";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bounded file reads", () => {
  it("rejects an oversized regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-bounded-file-"));
    directories.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, Buffer.alloc(9, 0x61));

    expect(() => readBoundedFile(path, 8, "file is too large")).toThrow("file is too large");
  });

  it("returns the complete contents of a file within the limit", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-bounded-file-"));
    directories.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, "{\"version\":1}");

    expect(readBoundedFile(path, 32, "file is too large").toString("utf8")).toBe("{\"version\":1}");
  });
});
