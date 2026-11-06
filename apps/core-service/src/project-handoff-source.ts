import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, parse, resolve } from "node:path";
import { ProjectSchema } from "@kestrel/shared-types";

export const MAX_PROJECT_HANDOFF_BYTES = 1024 * 1024;
export const MAX_PROJECT_HANDOFF_PROJECTS = 500;
export type ProjectHandoffMetadata = { id: string; name: string; instructions?: string; pathHint: string; createdAt: string; updatedAt: string; order: number };
const INVALID = "Invalid project handoff source";
const fail = (): never => { throw new Error(INVALID); };
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && (empty || v.length > 0) && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) && !/[\ud800-\udfff]/u.test(v);
const instructionText = (v: unknown): v is string => typeof v === "string" && v.length <= 20_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v) && !/[\ud800-\udfff]/u.test(v);
const timestamp = "1970-01-01T00:00:00.000Z";

export function parseProjectHandoffSource(bytes: Buffer): ProjectHandoffMetadata[] {
 try {
  if (bytes.length > MAX_PROJECT_HANDOFF_BYTES) return fail();
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.length > MAX_PROJECT_HANDOFF_PROJECTS) return fail();
  const ids = new Set<string>(), paths = new Set<string>();
  return value.map((item: unknown, index: number) => {
   if (!item || typeof item !== "object" || Array.isArray(item)) return fail();
   const row = item as Record<string, unknown>;
   if (Object.keys(row).some(k => !["id", "path", "name", "instructions", "createdAt", "updatedAt", "order"].includes(k))) return fail();
   const path = row.path;
   if (!text(path, 4096) || Buffer.byteLength(path, "utf8") > 4096 || !isAbsolute(path) || resolve(path) !== path || path === parse(path).root || path === homedir() || /^\/Volumes\/[^/]+\/?$/.test(path)) return fail();
   const id = row.id === undefined ? `project-${createHash("sha256").update(`kestrel-project:${resolve(path)}`).digest("hex").slice(0, 32)}` : row.id;
   const name = row.name === undefined ? basename(path) : row.name;
   const createdAt = row.createdAt === undefined ? timestamp : row.createdAt;
   const updatedAt = row.updatedAt === undefined ? createdAt : row.updatedAt;
   const order = row.order === undefined ? index : row.order;
   if (!text(id, 200) || !text(name, 200) || (row.instructions !== undefined && !instructionText(row.instructions)) || !ProjectSchema.shape.createdAt.safeParse(createdAt).success || !ProjectSchema.shape.updatedAt.safeParse(updatedAt).success || typeof order !== "number" || !Number.isSafeInteger(order) || order < 0 || ids.has(id) || paths.has(path)) return fail();
   ids.add(id); paths.add(path);
   return { id, name, ...(row.instructions === undefined ? {} : { instructions: row.instructions as string }), pathHint: path, createdAt: createdAt as string, updatedAt: updatedAt as string, order };
  });
 } catch { return fail(); }
}

type Snapshot = { dev: string; ino: string; mode: string; uid: string; size: string; mtimeNs: string; ctimeNs: string };
function snapshot(s: BigIntStats): Snapshot {
 return Object.freeze({ dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), uid: String(s.uid), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
}
const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);
function safeStat(s: BigIntStats, directory: boolean) {
 if (!(directory ? s.isDirectory() : s.isFile()) || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) !== 0n || (!directory && (s.nlink !== 1n || s.size > BigInt(MAX_PROJECT_HANDOFF_BYTES)))) fail();
}

export async function readProjectHandoffSource(sourceProfileRoot: string) {
 let root: FileHandle | undefined, file: FileHandle | undefined;
 try {
  if (!text(sourceProfileRoot, 4096) || !isAbsolute(sourceProfileRoot) || resolve(sourceProfileRoot) !== sourceProfileRoot || await realpath(sourceProfileRoot) !== sourceProfileRoot) return fail();
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  root = await open(sourceProfileRoot, flags | constants.O_DIRECTORY);
  const rootStat = await root.stat({ bigint: true }); safeStat(rootStat, true);
  const rootSnapshot = snapshot(rootStat);
  const filename = `${sourceProfileRoot}/workspace-grants.json`;
  try { file = await open(filename, flags); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  let fileSnapshot: Snapshot | undefined, sha256: string | undefined, bytes = 0;
  let projects: ProjectHandoffMetadata[] = [];
  if (file) {
   const before = await file.stat({ bigint: true }); safeStat(before, false); fileSnapshot = snapshot(before);
   const buffer = Buffer.alloc(MAX_PROJECT_HANDOFF_BYTES + 1);
   while (bytes < buffer.length) {
    const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
   }
   if (bytes > MAX_PROJECT_HANDOFF_BYTES) return fail();
   const data = buffer.subarray(0, bytes);
   sha256 = createHash("sha256").update(data).digest("hex");
   projects = parseProjectHandoffSource(data);
  }
  const witness = Object.freeze(fileSnapshot ? { presence: "present" as const, profile: rootSnapshot, file: fileSnapshot, sha256: sha256!, bytes } : { presence: "missing" as const, profile: rootSnapshot });
  let closed = false;
  const verify = async () => {
   try {
    if (closed || !root) return fail();
    const heldRoot = await root.stat({ bigint: true }); safeStat(heldRoot, true);
    const pathRoot = await lstat(sourceProfileRoot, { bigint: true }); safeStat(pathRoot, true);
    if (await realpath(sourceProfileRoot) !== sourceProfileRoot || !same(rootSnapshot, snapshot(heldRoot)) || !same(rootSnapshot, snapshot(pathRoot))) return fail();
    if (file && fileSnapshot) {
     const held = await file.stat({ bigint: true }); const pathStat = await lstat(filename, { bigint: true });
     safeStat(held, false); safeStat(pathStat, false);
     if (!same(fileSnapshot, snapshot(held)) || !same(fileSnapshot, snapshot(pathStat))) return fail();
    } else {
     try { await lstat(filename); return fail(); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
   } catch { return fail(); }
  };
  const close = async () => { if (!closed) { closed = true; await Promise.all([file?.close(), root?.close()]); } };
  await verify();
  for (const project of projects) Object.freeze(project);
  Object.freeze(projects);
  return { projects, witness, verify, close };
 } catch { await Promise.allSettled([file?.close(), root?.close()]); return fail(); }
}
