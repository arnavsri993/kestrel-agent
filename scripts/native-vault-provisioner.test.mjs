import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, it } from "vitest";

// File/protocol fixtures link deterministic crypto functions instead of the
// production Swift/isolated-crypto implementation. There is no runtime fallback
// or test-key switch in the shipping provisioner. Hardware acceptance is separate.
let temporary, binary;
const nativeIt = process.platform === "darwin" ? it : it.skip;
beforeAll(async () => {
 if (process.platform !== "darwin") return;
 temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-provisioner-test-")));
 const source = resolve("apps/native-chromium-host/src"), stub = join(temporary, "fixture-crypto.cc");
 await writeFile(stub, `#include "kestrel_local_vault_crypto_process.h"
#include "kestrel_local_vault_crypto.h"
#include <algorithm>
#include <unistd.h>
bool NativeVaultSealIsolated(const std::vector<uint8_t>& context,const std::vector<uint8_t>&,std::vector<uint8_t>* envelope,const std::string&) { usleep(100000); *envelope=context; return true; }
bool NativeVaultOpenIsolated(const std::vector<uint8_t>& context,const std::vector<uint8_t>& envelope,std::vector<uint8_t>* master,const std::string&) { if(context!=envelope)return false;master->assign(32,0x45);return true; }
extern "C" int32_t kestrel_vault_derive(const uint8_t*,size_t,const uint8_t*,size_t,const uint8_t*,size_t,uint8_t* out,size_t capacity,size_t* size) { if(capacity<32)return 1;std::fill(out,out+32,0x51);*size=32;return 0; }
`, { mode: 0o600 });
 binary = join(temporary, "provisioner");
 execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", "-I", source,
  join(source, "kestrel_vault_provisioner.mm"), join(source, "kestrel_local_vault.mm"), stub,
  "-framework", "Foundation", "-framework", "Security", "-o", binary], { timeout: 60000, stdio: "pipe" });
}, 60000);
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
async function fixture() {
 const parent = await realpath(await mkdtemp(join(temporary, "parent-"))), handle = await open(parent, "r"), info = await handle.stat({ bigint: true });
 const nonce = randomBytes(16), path = Buffer.from(parent), request = Buffer.alloc(40 + path.length);
 request.write("KVP1"); nonce.copy(request, 4); request.writeBigUInt64BE(info.dev, 20); request.writeBigUInt64BE(info.ino, 28); request.writeUInt32BE(path.length, 36); path.copy(request, 40);
 return { parent, handle, nonce, request, root: join(parent, "profile") };
}
async function invoke(f, { request = f.request, args = [], channel } = {}) {
 const child = spawn(binary, args, { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", channel ?? "pipe", f.handle.fd] });
 let reply = Buffer.alloc(0), stdout = "", stderr = "";
 child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
 if (channel === undefined) { child.stdio[3].on("error", () => {}); child.stdio[3].on("data", b => { reply = Buffer.concat([reply, b]); }); child.stdio[3].end(request); }
 const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
 const outcome = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
 clearTimeout(timer); await f.handle.close(); assert.equal(stdout, ""); assert.equal(stderr, "");
 return { ...outcome, reply };
}
nativeIt("binds the fresh root and vault digest to a nonce and returns only one bounded private response", async () => {
 const f = await fixture(), result = await invoke(f); assert.equal(result.code, 0); assert.equal(result.signal, null);
 assert.equal(result.reply.length, 100); assert.equal(result.reply.subarray(0, 4).toString(), "KVP2"); assert(result.reply.subarray(4, 20).equals(f.nonce));
 const root = await open(f.root, "r"); const info = await root.stat({ bigint: true }); await root.close();
 assert.equal(result.reply.readBigUInt64BE(20), info.dev); assert.equal(result.reply.readBigUInt64BE(28), info.ino);
 const envelope = await readFile(join(f.root, ".kestrel-local-vault-v1")); assert(result.reply.subarray(36, 68).equals(createHash("sha256").update(envelope).digest()));
 assert(result.reply.subarray(68).equals(Buffer.alloc(32, 0x51))); assert.deepEqual(await readdir(f.root), [".kestrel-local-vault-v1"]);
 result.reply.fill(0);
});
for (const kind of ["magic", "short", "trailing", "device", "inode", "oversized-path", "null-path", "different-path", "public-parent", "preexisting-root", "arguments", "file-channel"]) {
 nativeIt(`refuses ${kind} without overwriting existing data or disclosing a key`, async () => {
  const f = await fixture(); let request = Buffer.from(f.request), args = [], channel, channelFile;
  if (kind === "magic") request.write("BAD1");
  if (kind === "short") request = request.subarray(0, 20);
  if (kind === "trailing") request = Buffer.concat([request, Buffer.from([1])]);
  if (kind === "device") request.writeBigUInt64BE(0n, 20);
  if (kind === "inode") request.writeBigUInt64BE(0n, 28);
  if (kind === "oversized-path") request.writeUInt32BE(4001, 36);
  if (kind === "null-path") request[40] = 0;
  if (kind === "different-path") request[request.length - 1] = request.at(-1) === 97 ? 98 : 97;
  if (kind === "public-parent") await chmod(f.parent, 0o755);
  if (kind === "preexisting-root") { await mkdir(f.root, { mode: 0o700 }); await writeFile(join(f.root, "keep"), "preserved", { mode: 0o600 }); }
  if (kind === "arguments") args = ["--source-key=unsupported"];
  if (kind === "file-channel") { channelFile = await open(join(temporary, "regular-channel"), "w+"); channel = channelFile.fd; }
  const result = await invoke(f, { request, args, channel }); await channelFile?.close();
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.reply.length, 0);
  if (kind === "preexisting-root") { assert.equal(await readFile(join(f.root, "keep"), "utf8"), "preserved"); assert.deepEqual(await readdir(f.root), ["keep"]); }
  else assert.deepEqual(await readdir(f.parent), []);
 });
}
nativeIt("detects parent replacement after creating the root and retains uncertain output without a key reply", async () => {
 const f = await fixture();
 const pending = invoke(f);
 for (let n = 0; n < 200; n++) { if ((await readdir(f.parent)).includes("profile")) break; await new Promise(done => setTimeout(done, 2)); }
 await rename(f.parent, `${f.parent}-held`); await mkdir(f.parent, { mode: 0o700 });
 const result = await pending; assert.equal(result.code, 1); assert.equal(result.reply.length, 0);
 assert.deepEqual(await readdir(f.parent), []); assert((await readdir(`${f.parent}-held`)).includes("profile"));
});
