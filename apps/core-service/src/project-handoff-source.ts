import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProjectSchema } from "@kestrel/shared-types";
import { decryptText } from "../../../packages/encryption/src/index";
import { MAX_PROJECT_HANDOFF_FILE_BYTES, MAX_PROJECT_HANDOFF_VALUE_BYTES } from "../../desktop/src/main/native-project-handoff-file";
import { parseNativeProjectHandoffState, PROJECT_HANDOFF_ID } from "../../desktop/src/main/native-project-handoff-state";

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
const directoryWitness = ({ ctimeNs: _ctime, ...witness }: Snapshot) => witness;
function stableSourceWitness(value: unknown) {
 if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
 const witness = value as Record<string, unknown>, profile = witness.profile;
 if (witness.presence !== "present" && witness.presence !== "missing") return undefined;
 if (!profile || typeof profile !== "object" || Array.isArray(profile)) return undefined;
 const root = profile as Record<string, unknown>;
 if (!["dev", "ino", "mode", "uid", "size", "mtimeNs", "ctimeNs"].every(field => typeof root[field] === "string" && /^-?\d+$/.test(root[field] as string))) return undefined;
 const { ctimeNs: _ctime, ...directory } = root;
 return { ...witness, profile: directory };
}

/** Cocoa may update folder access metadata after a picker closes. Retain the
 * original witness format while ignoring only the folder's change timestamp;
 * every registry-file field, digest and presence observation still must match. */
export function sameProjectHandoffSourceWitness(a: unknown, b: unknown): boolean {
 const left = stableSourceWitness(a), right = stableSourceWitness(b);
 return left !== undefined && right !== undefined && isDeepStrictEqual(left, right);
}
function safeStat(s: BigIntStats, directory: boolean, maximum = MAX_PROJECT_HANDOFF_BYTES) {
 if (!(directory ? s.isDirectory() : s.isFile()) || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) !== 0n || (!directory && (s.nlink !== 1n || s.size > BigInt(maximum)))) fail();
}

// The source handoff ID is inside its authenticated envelope; do not discover
// it from an unauthenticated filename, or expose a general key-reading API.
function pendingSource(data: Buffer, key: Buffer | undefined, sourceRoot: string, root: Snapshot) {
 if (!Buffer.isBuffer(key) || key.length !== 32) return fail();
 const outer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
 if (!outer || typeof outer !== "object" || Array.isArray(outer) || Object.keys(outer).sort().join(",") !== "authTag,ciphertext,iv" || ![outer.authTag, outer.ciphertext, outer.iv].every(value => typeof value === "string")) return fail();
 const plain = decryptText(outer, key);
 if (Buffer.byteLength(plain) > MAX_PROJECT_HANDOFF_VALUE_BYTES + 4096) return fail();
 const inner = JSON.parse(plain);
 if (!inner || typeof inner !== "object" || Array.isArray(inner) || Object.keys(inner).sort().join(",") !== "domain,id,root,value" ||
     inner.domain !== "kestrel-native-project-handoff-v1" || typeof inner.id !== "string" || !PROJECT_HANDOFF_ID.test(inner.id) ||
     !isDeepStrictEqual(inner.root, { path: sourceRoot, dev: root.dev, ino: root.ino }) || Buffer.byteLength(JSON.stringify(inner.value)) > MAX_PROJECT_HANDOFF_VALUE_BYTES) return fail();
 const state = parseNativeProjectHandoffState(inner.value, inner.id);
 // An unfinished reconnect must be reconciled by its owning host, never by a
 // read-only exporter. Prepared transfers are not an accepted source either.
 if (state.state !== "ready" || state.connection || state.corePlan.destination.path !== `${sourceRoot}/database/kestrel.sqlite`) return fail();
 return state;
}

export async function readProjectHandoffSource(sourceProfileRoot: string, sourceKey?: Buffer) {
 let root: FileHandle | undefined, file: FileHandle | undefined, pendingFile: FileHandle | undefined;
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
  const pendingFilename = `${sourceProfileRoot}/pending-project-handoff.json`;
  try { pendingFile = await open(pendingFilename, flags); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  let pendingWitness: Readonly<{ file: Snapshot; sha256: string; bytes: number }> | undefined;
  const pendingProjectIds: string[] = [], retiredProjectIds: string[] = [];
  async function readPending() {
   if (!pendingFile) return fail();
   const before = await pendingFile.stat({ bigint: true }); safeStat(before, false, MAX_PROJECT_HANDOFF_FILE_BYTES);
   const buffer = Buffer.alloc(MAX_PROJECT_HANDOFF_FILE_BYTES + 1); let length = 0;
   while (length < buffer.length) {
    const part = await pendingFile.read(buffer, length, buffer.length - length, length);
    if (!part.bytesRead) break;
    length += part.bytesRead;
   }
   const after = await pendingFile.stat({ bigint: true }), named = await lstat(pendingFilename, { bigint: true });
   safeStat(after, false, MAX_PROJECT_HANDOFF_FILE_BYTES); safeStat(named, false, MAX_PROJECT_HANDOFF_FILE_BYTES);
   if (length > MAX_PROJECT_HANDOFF_FILE_BYTES || BigInt(length) !== before.size || !same(snapshot(before), snapshot(after)) || !same(snapshot(before), snapshot(named))) return fail();
   const data = buffer.subarray(0, length);
   return { data, witness: Object.freeze({ file: snapshot(before), sha256: createHash("sha256").update(data).digest("hex"), bytes: length }) };
  }
  if (pendingFile) {
   const loaded = await readPending(); pendingWitness = loaded.witness;
   const state = pendingSource(loaded.data, sourceKey, sourceProfileRoot, rootSnapshot);
   const granted = new Set(projects.map(project => project.id)), pending = new Set(state.pendingProjectIds);
   if (state.pendingProjectIds.some(id => granted.has(id))) return fail();
   pendingProjectIds.push(...state.pendingProjectIds);
   // Current grants carry subsequent edits/reconnections. Never resurrect old
   // hints for settled identities whose explicit grant has since been removed.
   retiredProjectIds.push(...state.settledProjectIds.filter(item => !granted.has(item.id)).map(item => item.id));
   const hints = state.projects.filter(project => pending.has(project.id));
   projects = parseProjectHandoffSource(Buffer.from(JSON.stringify([...projects, ...hints].map(({ pathHint, ...project }) => ({ ...project, path: pathHint })))));
  }
  const witness = Object.freeze({ ...(fileSnapshot ? { presence: "present" as const, profile: rootSnapshot, file: fileSnapshot, sha256: sha256!, bytes } : { presence: "missing" as const, profile: rootSnapshot }),
   ...(pendingWitness ? { pendingHandoff: pendingWitness } : {}) });
  let closed = false;
  const verify = async () => {
   try {
    if (closed || !root) return fail();
    const heldRoot = await root.stat({ bigint: true }); safeStat(heldRoot, true);
    const pathRoot = await lstat(sourceProfileRoot, { bigint: true }); safeStat(pathRoot, true);
    // macOS may update access metadata after the native picker returns, changing
    // only folder ctime. Keep size/mtime, identity, ownership and mode pinned;
    // the selected file's complete snapshot stays pinned, including its ctime.
    if (await realpath(sourceProfileRoot) !== sourceProfileRoot || !isDeepStrictEqual(directoryWitness(rootSnapshot), directoryWitness(snapshot(heldRoot))) || !isDeepStrictEqual(directoryWitness(rootSnapshot), directoryWitness(snapshot(pathRoot)))) return fail();
    if (file && fileSnapshot) {
     const held = await file.stat({ bigint: true }); const pathStat = await lstat(filename, { bigint: true });
     safeStat(held, false); safeStat(pathStat, false);
     if (!same(fileSnapshot, snapshot(held)) || !same(fileSnapshot, snapshot(pathStat))) return fail();
    } else {
     try { await lstat(filename); return fail(); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    if (pendingWitness) {
     if (!isDeepStrictEqual((await readPending()).witness, pendingWitness)) return fail();
    } else {
     try { await lstat(pendingFilename); return fail(); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
   } catch { return fail(); }
  };
  const close = async () => { if (!closed) { closed = true; await Promise.all([file?.close(), pendingFile?.close(), root?.close()]); } };
  await verify();
  for (const project of projects) Object.freeze(project);
  Object.freeze(projects);
  Object.freeze(pendingProjectIds); Object.freeze(retiredProjectIds);
  return { projects, pendingProjectIds, retiredProjectIds, witness, verify, close };
 } catch { await Promise.allSettled([file?.close(), pendingFile?.close(), root?.close()]); return fail(); }
}
