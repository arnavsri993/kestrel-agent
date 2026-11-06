import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { decryptText, encryptText } from "@kestrel/encryption";

export const MAX_PROJECT_HANDOFF_VALUE_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECT_HANDOFF_FILE_BYTES = 4 * 1024 * 1024;
const DOMAIN = "kestrel-native-project-handoff-v1";
const FILE = "pending-project-handoff.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type Identity = Readonly<{ dev: string; ino: string; mode: string; uid: string; size: string; mtimeNs: string; ctimeNs: string }>;
export type ProjectHandoffFileWitness = Readonly<{ root: Identity; file: Identity; sha256: string }>;
export class ProjectHandoffFileError extends Error {
 constructor(public readonly created?: boolean, public readonly committed?: boolean) { super("Project handoff file operation failed"); this.name = "ProjectHandoffFileError"; }
}
const identity = (s: BigIntStats): Identity => Object.freeze({ dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), uid: String(s.uid), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function safe(s: BigIntStats, dir: boolean) {
 if (!(dir ? s.isDirectory() : s.isFile()) || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) !== 0n || (!dir && (s.nlink !== 1n || s.size > BigInt(MAX_PROJECT_HANDOFF_FILE_BYTES)))) throw new Error();
}
const queues = new Map<string, Promise<void>>();
async function queued<T>(root: string, fn: () => Promise<T>): Promise<T> {
 const previous = queues.get(root) ?? Promise.resolve();
 let release!: () => void; const current = new Promise<void>(r => { release = r; });
 queues.set(root, current); await previous;
 try { return await fn(); } finally { release(); if (queues.get(root) === current) queues.delete(root); }
}
export class NativeProjectHandoffFile {
 private readonly root: string;
 private readonly key: Buffer;
 private closed = false;
 constructor(options: { root: string; key: Buffer }) {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || typeof options.root !== "string" || !isAbsolute(options.root) || resolve(options.root) !== options.root || options.root.includes("\0")) throw new ProjectHandoffFileError();
  this.root = options.root; this.key = Buffer.from(options.key);
 }
 close(): void { this.closed = true; this.key.fill(0); }
 private async withRoot<T>(fn: (root: FileHandle, rootId: Identity) => Promise<T>): Promise<T> {
  if (this.closed) throw new Error();
  if (await realpath(this.root) !== this.root) throw new Error();
  const root = await open(this.root, flags | constants.O_DIRECTORY);
  try {
   const s = await root.stat({ bigint: true }); safe(s, true); const rootId = identity(s);
   await this.verifyRoot(root, rootId);
   return await fn(root, rootId);
  } finally { await root.close(); }
 }
 private async verifyRoot(root: FileHandle, expected: Identity): Promise<void> {
  if (this.closed || await realpath(this.root) !== this.root) throw new Error();
  const held = await root.stat({ bigint: true }), named = await lstat(this.root, { bigint: true }); safe(held, true); safe(named, true);
  // Directory metadata changes as staging files are created. Identity and safety remain mandatory.
  if (String(held.dev) !== expected.dev || String(held.ino) !== expected.ino || String(named.dev) !== expected.dev || String(named.ino) !== expected.ino) throw new Error();
 }
 private async readRaw(root: FileHandle, rootId: Identity) {
  await this.verifyRoot(root, rootId);
  const file = await open(join(this.root, FILE), flags);
  try {
   const before = await file.stat({ bigint: true }); safe(before, false); const fileId = identity(before);
   const buffer = Buffer.alloc(MAX_PROJECT_HANDOFF_FILE_BYTES + 1); let size = 0;
   while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
   if (size > MAX_PROJECT_HANDOFF_FILE_BYTES) throw new Error();
   const after = await file.stat({ bigint: true }), named = await lstat(join(this.root, FILE), { bigint: true }); safe(after, false); safe(named, false);
   await this.verifyRoot(root, rootId);
   if (!equal(fileId, identity(after)) || !equal(fileId, identity(named))) throw new Error();
   const data = buffer.subarray(0, size);
   const witness = Object.freeze({ root: identity(await root.stat({ bigint: true })), file: fileId, sha256: createHash("sha256").update(data).digest("hex") });
   return { data, witness };
  } finally { await file.close(); }
 }
 private decode(id: string, data: Buffer, rootId: Identity): Record<string, unknown> {
  const outer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  if (!outer || typeof outer !== "object" || Array.isArray(outer) || Object.keys(outer).sort().join(",") !== "authTag,ciphertext,iv" || ![outer.authTag, outer.ciphertext, outer.iv].every((v: unknown) => typeof v === "string")) throw new Error();
  const plain = decryptText(outer, this.key); if (Buffer.byteLength(plain) > MAX_PROJECT_HANDOFF_VALUE_BYTES + 4096) throw new Error();
  const inner = JSON.parse(plain);
  if (!inner || Object.keys(inner).sort().join(",") !== "domain,id,root,value" || inner.domain !== DOMAIN || inner.id !== id || !equal(inner.root, { path: this.root, dev: rootId.dev, ino: rootId.ino }) || !inner.value || typeof inner.value !== "object" || Array.isArray(inner.value) || Buffer.byteLength(JSON.stringify(inner.value)) > MAX_PROJECT_HANDOFF_VALUE_BYTES) throw new Error();
  return inner.value;
 }
 private encode(id: string, value: Record<string, unknown>, rootId: Identity): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const json = JSON.stringify(value); if (typeof json !== "string" || Buffer.byteLength(json) > MAX_PROJECT_HANDOFF_VALUE_BYTES) throw new Error();
  const clone = JSON.parse(json); if (!clone || typeof clone !== "object" || Array.isArray(clone)) throw new Error();
  const plain = JSON.stringify({ domain: DOMAIN, id, root: { path: this.root, dev: rootId.dev, ino: rootId.ino }, value: clone });
  const data = Buffer.from(JSON.stringify(encryptText(plain, this.key))); if (data.length > MAX_PROJECT_HANDOFF_FILE_BYTES) throw new Error(); return data;
 }
 private async result(id: string, root: FileHandle, rootId: Identity) { const { data, witness } = await this.readRaw(root, rootId); return { value: this.decode(id, data, rootId), witness }; }
 async read(id: string) { try { if (!UUID.test(id)) throw new Error(); return await queued(this.root, () => this.withRoot((root, rootId) => this.result(id, root, rootId))); } catch { throw new ProjectHandoffFileError(); } }
 async create(id: string, value: Record<string, unknown>) {
  let created = false, committed = false;
  try { if (!UUID.test(id)) throw new Error(); return await queued(this.root, () => this.withRoot(async (root, rootId) => {
   const data = this.encode(id, value, rootId); await this.verifyRoot(root, rootId);
   const file = await open(join(this.root, FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
   try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
   await this.verifyRoot(root, rootId); await root.sync(); committed = true; return await this.result(id, root, rootId);
  })); } catch { throw new ProjectHandoffFileError(created, committed); }
 }
 async replace(id: string, value: Record<string, unknown>, expectedWitness: ProjectHandoffFileWitness) {
  let created = false, committed = false, stage: string | undefined, stageIdentity: Identity | undefined;
  try { if (!UUID.test(id)) throw new Error(); return await queued(this.root, () => this.withRoot(async (root, rootId) => {
   const first = await this.result(id, root, rootId); if (!equal(first.witness, expectedWitness)) throw new Error();
   const data = this.encode(id, value, rootId); stage = join(this.root, `.project-handoff-${randomBytes(16).toString("hex")}.tmp`);
   const file = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
   try { await file.writeFile(data); await file.sync(); const s = await file.stat({ bigint: true }); safe(s, false); stageIdentity = identity(s); } finally { await file.close(); }
   const second = await this.result(id, root, rootId); if (!equal(second.witness.file, first.witness.file) || second.witness.sha256 !== first.witness.sha256) throw new Error();
   await this.verifyRoot(root, rootId); const stageStat = await lstat(stage, { bigint: true }); safe(stageStat, false); if (!equal(stageIdentity, identity(stageStat))) throw new Error(); await rename(stage, join(this.root, FILE)); stage = undefined; committed = true;
   await root.sync(); return await this.result(id, root, rootId);
  })); } catch { throw new ProjectHandoffFileError(created, committed); } finally { if (stage && created && stageIdentity) { try { const current = await lstat(stage, { bigint: true }); if (String(current.dev) === stageIdentity.dev && String(current.ino) === stageIdentity.ino && current.isFile()) await unlink(stage); } catch { /* preserve unknown files */ } } }
 }
}
