import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_PROJECT_HANDOFF_VALUE_BYTES, NativeProjectHandoffFile } from "./native-project-handoff-file";
const id = "12345678-1234-4abc-8abc-123456789abc";
async function fixture(fn: (root: string, key: Buffer, parent: string) => Promise<void>) {
 const parent = await realpath(await mkdtemp(join(tmpdir(), "project-handoff-"))); const root = join(parent, "core"); await mkdir(root, { mode: 0o700 });
 try { await fn(root, randomBytes(32), parent); } finally { await rm(parent, { recursive: true, force: true }); }
}
const filename = (root: string) => join(root, "pending-project-handoff.json");
describe("encrypted native project handoff file", () => {
 it("creates and reads encrypted data and preserves the caller key", async () => fixture(async (root, key) => {
  const copy = Buffer.from(key); const store = new NativeProjectHandoffFile({ root, key });
  const result = await store.create(id, { secret: "sensitive example" });
  expect(result.value).toEqual({ secret: "sensitive example" }); expect(Object.isFrozen(result.witness.file)).toBe(true);
  const disk = await readFile(filename(root), "utf8"); expect(disk).not.toContain("sensitive example"); expect(disk).not.toContain(key.toString("hex"));
  expect((await store.read(id)).value).toEqual(result.value); store.close(); expect(key).toEqual(copy); await expect(store.read(id)).rejects.toThrow();
 }));
 it("rejects wrong key, id, copied root, corruption and truncation", async () => fixture(async (root, key, parent) => {
  const store = new NativeProjectHandoffFile({ root, key }); await store.create(id, { x: 1 }); const original = await readFile(filename(root));
  await expect(new NativeProjectHandoffFile({ root, key: randomBytes(32) }).read(id)).rejects.toThrow();
  await expect(store.read("12345678-1234-4abc-9abc-123456789abc")).rejects.toThrow();
  const other = join(parent, "other"); await mkdir(other, { mode: 0o700 }); await writeFile(filename(other), original, { mode: 0o600 });
  await expect(new NativeProjectHandoffFile({ root: other, key }).read(id)).rejects.toThrow();
  await writeFile(filename(root), original.subarray(0, 12)); await expect(store.read(id)).rejects.toThrow();
  const damaged = JSON.parse(original.toString()); damaged.authTag = Buffer.alloc(16).toString("base64"); await writeFile(filename(root), JSON.stringify(damaged)); await expect(store.read(id)).rejects.toThrow(); store.close();
 }));
 it("rejects symlinks, FIFO, hardlinks and permissive mode", async () => fixture(async root => {
  const store = new NativeProjectHandoffFile({ root, key: randomBytes(32) }); const path = filename(root);
  await symlink("/dev/null", path); await expect(store.read(id)).rejects.toThrow(); await rm(path);
  execFileSync("mkfifo", [path]); await expect(store.read(id)).rejects.toThrow(); await rm(path);
  await writeFile(path, "{}", { mode: 0o600 }); await link(path, join(root, "link")); await expect(store.read(id)).rejects.toThrow(); await rm(join(root, "link"));
  await chmod(path, 0o644); await expect(store.read(id)).rejects.toThrow(); store.close();
 }));
 it("enforces limits and leaves existing files untouched", async () => fixture(async (root, key) => {
  const store = new NativeProjectHandoffFile({ root, key }); await expect(store.create(id, { x: "a".repeat(MAX_PROJECT_HANDOFF_VALUE_BYTES) })).rejects.toThrow();
  const original = await store.create(id, { x: 1 }); await expect(store.create(id, { x: 2 })).rejects.toThrow();
  expect((await store.read(id)).value).toEqual(original.value); store.close();
 }));
 it("rejects stale witnesses and serializes competing replacements", async () => fixture(async (root, key) => {
  const a = new NativeProjectHandoffFile({ root, key }), b = new NativeProjectHandoffFile({ root, key }); const initial = await a.create(id, { n: 0 });
  const results = await Promise.allSettled([a.replace(id, { n: 1 }, initial.witness), b.replace(id, { n: 2 }, initial.witness)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const now = await a.read(id); await expect(a.replace(id, { n: 3 }, initial.witness)).rejects.toThrow(); expect((await a.read(id)).value).toEqual(now.value); a.close(); b.close();
 }));
});

it("reports durability failures before and after rename", async () => fixture(async (root, key) => {
 const store = new NativeProjectHandoffFile({ root, key }); const initial = await store.create(id, { n: 0 });
 const handle = await open(root); const proto = Object.getPrototypeOf(handle); await handle.close();
 const actual = proto.sync; let calls = 0;
 let spy = vi.spyOn(proto, "sync").mockImplementation(function (this: unknown) { calls++; if (calls === 1) return Promise.reject(new Error("test")); return actual.call(this); });
 try { await expect(store.replace(id, { n: 1 }, initial.witness)).rejects.toMatchObject({ created: true, committed: false }); } finally { spy.mockRestore(); }
 expect((await store.read(id)).value).toEqual({ n: 0 });
 // The stage creation changes directory metadata; refresh the reviewed witness.
 const fresh = await store.read(id); calls = 0;
 spy = vi.spyOn(proto, "sync").mockImplementation(function (this: unknown) { calls++; if (calls === 2) return Promise.reject(new Error("test")); return actual.call(this); });
 try { await expect(store.replace(id, { n: 2 }, fresh.witness)).rejects.toMatchObject({ created: true, committed: true }); } finally { spy.mockRestore(); }
 expect((await store.read(id)).value).toEqual({ n: 2 }); store.close();
}));
