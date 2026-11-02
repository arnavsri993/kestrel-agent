import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialBroker, SafeStorageSecretProtection, SAFESTORAGE_PROTECTION_PREFIX } from "../apps/desktop/src/main/credential-broker.ts";
import { KestrelDatabase } from "../packages/database/src/index.ts";
import { createHostProfileTransferSnapshot } from "../packages/database/src/profile-transfer.ts";
import { decryptText } from "../packages/encryption/src/index.ts";

const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");

// Independent Node crypto vectors match the pinned Chromium 150 macOS v10
// algorithm; the native decoder itself is compiled from production sources.
const password = Buffer.from("generated-keychain-fixture-only", "utf8");
const key = randomBytes(32);
const digest = value => createHash("sha256").update(value).digest("hex");
function encryptText(text, secret = password) {
  const aes = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
  try {
    const cipher = createCipheriv("aes-128-cbc", aes, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from("v10"), cipher.update(text, "utf8"), cipher.final()]);
  } finally { aes.fill(0); }
}
const bare = encryptText(key.toString("base64"));
const wrapped = Buffer.concat([SAFESTORAGE_PROTECTION_PREFIX, bare]);
const badPadding = Buffer.from(wrapped);
badPadding[SAFESTORAGE_PROTECTION_PREFIX.length + 3 + 31] ^= 1;
const development = text => Buffer.from(`kestrel-plaintext-v1\n${text}`, "utf8");

describe.skipIf(process.platform !== "darwin")("native legacy Kestrel database-key interoperability", () => {
  let temporary, executable;
  beforeAll(() => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    temporary = mkdtempSync(join(tmpdir(), "kestrel-legacy-key-fixture-"));
    executable = join(temporary, "legacy-core-key-fixture");
    const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8" }).trim();
    const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
    execFileSync(compiler, ["-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-isysroot", sdk,
      "-I", join(root, "apps/native-chromium-host/src"),
      join(root, "apps/native-chromium-host/src/kestrel_legacy_core_key.cc"),
      join(root, "apps/native-chromium-host/src/kestrel_legacy_keychain.mm"),
      join(root, "apps/native-chromium-host/tests/legacy_core_key_fixture.mm"),
      "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication", "-o", executable,
    ], { timeout: 30_000, stdio: "pipe" });
  });
  afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
  function unwrap(envelope, secret = password, allowDevelopmentPlaintext = false, reader = {}) {
    const result = spawnSync(executable, [], {
      input: JSON.stringify({ envelope: envelope.toString("base64"), password: secret.toString("base64"), allowDevelopmentPlaintext, ...reader }),
      stdio: ["pipe", "pipe", "pipe", "pipe"], timeout: 5_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr.length).toBe(0);
    return { metadata: JSON.parse(result.stdout.toString("utf8")), key: result.output[3] };
  }
  it.each([["wrapped", wrapped], ["bare", bare]])("decodes the known macOS %s format without exporting a key to logs", (_name, envelope) => {
    const result = unwrap(envelope);
    try { expect(result.metadata).toMatchObject({ ok: true, format: 1, error: "" }); expect(digest(result.key)).toBe(digest(key)); }
    finally { result.key.fill(0); }
  });
  it("requires an explicit development transfer before accepting a plaintext development key", () => {
    const denied = unwrap(development(key.toString("base64")));
    expect(denied.metadata).toMatchObject({ ok: false, failureOutputCleared: true, format: 2 });
    expect(denied.key.length).toBe(0);
    const allowed = unwrap(development(key.toString("base64")), Buffer.alloc(0), true);
    try { expect(allowed.metadata.ok).toBe(true); expect(digest(allowed.key)).toBe(digest(key)); }
    finally { allowed.key.fill(0); }
  });
  it.each([
    ["empty", Buffer.alloc(0), password], ["wrong password", wrapped, Buffer.from("incorrect-generated-password")],
    ["missing password", wrapped, Buffer.alloc(0)], ["oversized password", wrapped, Buffer.alloc(4097, 0x31)],
    ["corrupt CBC padding", badPadding, password],
    ["truncated CBC", wrapped.subarray(0, -1), password], ["extra CBC data", Buffer.concat([wrapped, Buffer.from([0])]), password],
    ["wrong platform", Buffer.concat([Buffer.from("v11"), bare.subarray(3)]), password],
    ["unknown future format", Buffer.concat([Buffer.from("v20"), bare.subarray(3)]), password],
    ["unwrapped plaintext", Buffer.from(key.toString("base64")), password],
    ["bad key alphabet", encryptText("!".repeat(43) + "="), password],
    ["key wrong size", encryptText(randomBytes(31).toString("base64")), password],
    ["oversized envelope", Buffer.alloc(1024, 0x31), password],
  ])("rejects %s and clears any previous output", (_name, envelope, secret) => {
    const result = unwrap(envelope, secret);
    expect(result.metadata).toMatchObject({ ok: false, failureOutputCleared: true });
    if (secret.length) expect(result.metadata.error).not.toContain(secret.toString("base64"));
    expect(result.key.length).toBe(0);
  });
  it("rejects noncanonical base64 pad bits and development-key whitespace", () => {
    const text = key.toString("base64"), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const noncanonical = text.slice(0, 42) + alphabet[alphabet.indexOf(text[42]) + 1] + "=";
    for (const envelope of [encryptText(noncanonical), development(noncanonical), development(text.slice(0, 43) + "\n")]) {
      const result = unwrap(envelope, password, true);
      expect(result.metadata).toMatchObject({ ok: false, failureOutputCleared: true });
      expect(result.key.length).toBe(0);
    }
  });
  it.each(["missing", "locked", "failed", "throw"])("fails closed on a %s legacy Keychain reader without retry or secret output", readerMode => {
    const result = unwrap(wrapped, password, false, { useReader: true, readerMode });
    expect(result.metadata).toMatchObject({ ok: false, failureOutputCleared: true, keychainReadCalls: 1, promptAllowed: false });
    expect(result.metadata.error).not.toContain("generated-private-reader-error");
    expect(result.key.length).toBe(0);
  });
  it("only consults the fixed-purpose reader for a known macOS format and carries explicit prompt policy", () => {
    const noPrompt = unwrap(wrapped, password, false, { useReader: true });
    const explicitPrompt = unwrap(wrapped, password, false, { useReader: true, allowPrompt: true });
    try {
      expect(noPrompt.metadata).toMatchObject({ ok: true, keychainReadCalls: 1, promptAllowed: false });
      expect(explicitPrompt.metadata).toMatchObject({ ok: true, keychainReadCalls: 1, promptAllowed: true });
      expect(digest(noPrompt.key)).toBe(digest(key));
      expect(digest(explicitPrompt.key)).toBe(digest(key));
      for (const envelope of [Buffer.from("unrecognized"), development(key.toString("base64"))]) {
        const result = unwrap(envelope, password, true, { useReader: true, readerMode: "throw" });
        expect(result.metadata.keychainReadCalls).toBe(0);
        result.key.fill(0);
      }
    } finally { noPrompt.key.fill(0); explicitPrompt.key.fill(0); }
  });
  it("opens a broker-created generated database and rewraps its contents under an independent key", async () => {
    const profile = join(temporary, "source-profile"), file = join(profile, "secure/database-key.bin");
    const storage = { isEncryptionAvailable: () => true, encryptString: value => encryptText(value), decryptString: value => {
      const aes = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
      try { const decipher = createDecipheriv("aes-128-cbc", aes, Buffer.alloc(16, 0x20)); return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString("utf8"); }
      finally { aes.fill(0); }
    } };
    const broker = new CredentialBroker(profile, new SafeStorageSecretProtection(storage));
    const original = await broker.getDatabaseKey();
    const fileBefore = readFileSync(file);
    const path = join(profile, "database/kestrel.sqlite");
    const timestamp = "2026-11-02T12:00:00.000Z";
    let source = new KestrelDatabase(path, original);
    source.saveRuntimeSession({ id: "legacy-session", title: "Generated legacy fixture", allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
    source.saveRuntimeMessage({ id: "legacy-message", sessionId: "legacy-session", role: "user", content: "Generated encrypted migration proof", createdAt: timestamp });
    source.close(); source = undefined;
    const databaseBefore = readFileSync(path);
    const decoded = unwrap(fileBefore, password, false, { useReader: true });
    const destinationKey = randomBytes(32);
    let destination, sourceReadOnly;
    try {
      expect(decoded.metadata.ok).toBe(true);
      expect(digest(decoded.key)).toBe(digest(original));
      // Source inspection must not invoke the normal writable constructor's
      // migrations or legacy conversions before a user approves the plan.
      sourceReadOnly = new Database(path, { readonly: true, fileMustExist: true });
      const row = sourceReadOnly.prepare("SELECT content_ciphertext AS ciphertext, content_iv AS iv, content_auth_tag AS authTag FROM runtime_messages WHERE id = ?").get("legacy-message");
      expect(JSON.parse(decryptText(row, decoded.key)).content).toBe("Generated encrypted migration proof");
      destination = new KestrelDatabase(":memory:", destinationKey);
      destination.importHostProfileTransferSnapshot(createHostProfileTransferSnapshot(sourceReadOnly, decoded.key));
      expect(destination.listRuntimeMessages("legacy-session")[0]?.content).toBe("Generated encrypted migration proof");
      expect(readFileSync(file)).toEqual(fileBefore);
      sourceReadOnly.close(); sourceReadOnly = undefined;
      expect(readFileSync(path)).toEqual(databaseBefore);
    } finally { source?.close(); sourceReadOnly?.close(); destination?.close(); original.fill(0); decoded.key.fill(0); destinationKey.fill(0); }
  });
});
