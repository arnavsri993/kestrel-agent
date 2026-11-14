import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeNativePrivateFile } from "./native-private-file";

it("preserves and reports a newly created incomplete file when interrupted", async () => {
 const parent = await mkdtemp(join(tmpdir(), "private-file-")); const path = join(parent, "report"); let checks = 0;
 try {
  await expect(writeNativePrivateFile(path, parent, Buffer.from("fixture"), () => { if (++checks === 5) throw new Error("interrupted"); }, () => true)).rejects.toMatchObject({ created: true });
  expect(await readFile(path, "utf8")).toBe("");
 } finally { await rm(parent, { recursive: true, force: true }); }
});
it("propagates cancellation before creating a file", async () => {
 const parent = await mkdtemp(join(tmpdir(), "private-file-")); const path = join(parent, "report"); const cancelled = new Error("cancelled");
 try {
  await expect(writeNativePrivateFile(path, parent, Buffer.from("fixture"), () => { throw cancelled; }, error => error === cancelled)).rejects.toBe(cancelled);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
 } finally { await rm(parent, { recursive: true, force: true }); }
});
