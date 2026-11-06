import { describe, expect, it } from "vitest";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PROJECT_HANDOFF_BYTES, parseProjectHandoffSource, readProjectHandoffSource } from "./project-handoff-source";

const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const modern = { id: "  id  ", path: "/unavailable/project", name: " Name ", instructions: " Keep ", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-02-01T00:00:00Z", order: 7 };
async function fixture(fn: (root: string) => Promise<void>) {
 const parent = await mkdtemp(join(tmpdir(), "handoff-test-"));
 // macOS temporary paths may contain symlink components.
 const { realpath } = await import("node:fs/promises");
 const canonical = await realpath(parent);
 const root = join(canonical, "profile"); await mkdir(root, { mode: 0o700 });
 try { await fn(root); } finally { await rm(canonical, { recursive: true, force: true }); }
}

describe("project handoff parser", () => {
 it("preserves modern literals and derives deterministic legacy metadata without probing paths", () => {
  const records = parseProjectHandoffSource(encode([modern, { path: "/never-created/legacy" }]));
  const { path, ...fields } = modern;
  expect(records[0]).toEqual({ ...fields, pathHint: path });
 });
 it("derives legacy defaults and rejects ambiguous or unsafe records", () => {
  const [legacy] = parseProjectHandoffSource(encode([{ path: "/never-created/legacy" }]));
  expect(legacy).toMatchObject({ name: "legacy", createdAt: "1970-01-01T00:00:00.000Z", order: 0 });
  expect(legacy!.id).toMatch(/^project-[a-f0-9]{32}$/);
  for (const value of [[{ ...modern, available: true }], [modern, modern], [{ ...modern, path: "/x/../y" }], [{ ...modern, id: "" }], [{ ...modern, instructions: "bad\u0000" }], [{ ...modern, createdAt: "yesterday" }], Array(501).fill(modern)]) expect(() => parseProjectHandoffSource(encode(value))).toThrow("Invalid project handoff source");
  expect(() => parseProjectHandoffSource(Buffer.alloc(MAX_PROJECT_HANDOFF_BYTES + 1))).toThrow();
  expect(() => parseProjectHandoffSource(Buffer.from([0xff]))).toThrow();
 });
});

describe("project handoff witness", () => {
 it("holds and verifies a private file without changing it, and detects mutation and close", async () => fixture(async root => {
  const filename = join(root, "workspace-grants.json"); const contents = encode([modern]); await writeFile(filename, contents, { mode: 0o600 });
  const source = await readProjectHandoffSource(root);
  expect(source.witness.presence).toBe("present"); expect(await readFile(filename)).toEqual(contents); await source.verify();
  await writeFile(filename, "[]"); await expect(source.verify()).rejects.toThrow(); await source.close(); await source.close(); await expect(source.verify()).rejects.toThrow();
 }));
 it("detects missing file appearing and root replacement", async () => fixture(async root => {
  const missing = await readProjectHandoffSource(root); expect(missing.witness.presence).toBe("missing");
  await writeFile(join(root, "workspace-grants.json"), "[]", { mode: 0o600 }); await expect(missing.verify()).rejects.toThrow(); await missing.close();
  const source = await readProjectHandoffSource(root); await rename(root, `${root}-old`); await mkdir(root, { mode: 0o700 }); await expect(source.verify()).rejects.toThrow(); await source.close();
 }));
 it("rejects symlinks, FIFOs, and nonprivate permissions", async () => fixture(async root => {
  const path = join(root, "workspace-grants.json"); await symlink("/dev/null", path); await expect(readProjectHandoffSource(root)).rejects.toThrow(); await rm(path);
  execFileSync("mkfifo", [path]); await expect(readProjectHandoffSource(root)).rejects.toThrow(); await rm(path);
  await writeFile(path, "[]", { mode: 0o644 }); await expect(readProjectHandoffSource(root)).rejects.toThrow(); await chmod(path, 0o600); await chmod(root, 0o755); await expect(readProjectHandoffSource(root)).rejects.toThrow();
 }));
});


describe("handoff compatibility and integrity boundaries", () => {
 it("preserves multiline Unicode instructions and defaults updatedAt to createdAt", () => {
  const instructions = "line one\r\nline two\t café 🦅";
  const [record] = parseProjectHandoffSource(encode([{ path: "/absent/project", createdAt: "2022-01-01T00:00:00Z", instructions }]));
  expect(record?.instructions).toBe(instructions);
  expect(record?.updatedAt).toBe("2022-01-01T00:00:00Z");
 });
 it("rejects independent ID and path collisions", () => {
  expect(() => parseProjectHandoffSource(encode([modern, { ...modern, path: "/other" }]))).toThrow();
  expect(() => parseProjectHandoffSource(encode([modern, { ...modern, id: "different" }]))).toThrow();
 });
 it("enforces instruction and UTF-8 path boundaries without truncation", () => {
  const instructions = "a".repeat(20_000);
  const path = "/" + "é".repeat(2047) + "a";
  expect(Buffer.byteLength(path)).toBe(4096);
  expect(parseProjectHandoffSource(encode([{ path, name: "Project", instructions }]))[0]?.instructions).toBe(instructions);
  expect(() => parseProjectHandoffSource(encode([{ path: path + "a", name: "Project" }]))).toThrow();
  expect(() => parseProjectHandoffSource(encode([{ path: "/x", instructions: instructions + "a" }]))).toThrow();
 });
 it("detects same-byte replacement and prevents witness mutation", async () => fixture(async root => {
  const path = join(root, "workspace-grants.json"); await writeFile(path, "[]", { mode: 0o600 });
  const source = await readProjectHandoffSource(root);
  expect(Object.isFrozen(source.witness)).toBe(true); expect(Object.isFrozen(source.witness.profile)).toBe(true);
  expect(() => { (source.witness.profile as { ino: string }).ino = "0"; }).toThrow();
  await rename(path, join(root, "old")); await writeFile(path, "[]", { mode: 0o600 });
  await expect(source.verify()).rejects.toThrow(); await source.close(); await expect(source.verify()).rejects.toThrow();
 }));
 it("detects in-place writes even when mtime is restored", async () => fixture(async root => {
  const path = join(root, "workspace-grants.json"); await writeFile(path, "[]", { mode: 0o600 });
  const source = await readProjectHandoffSource(root); const old = await stat(path);
  await writeFile(path, "  "); await utimes(path, old.atime, old.mtime);
  await expect(source.verify()).rejects.toThrow(); await source.close();
 }));
 it("rejects hardlinks and releases handles after errors or close", async () => fixture(async root => {
  const path = join(root, "workspace-grants.json"); await writeFile(path, "[]", { mode: 0o600 });
  const other = join(root, "other"); await link(path, other); await expect(readProjectHandoffSource(root)).rejects.toThrow();
  await rm(other); const source = await readProjectHandoffSource(root); await source.close(); await rm(path);
  await expect(source.verify()).rejects.toThrow();
 }));
});
