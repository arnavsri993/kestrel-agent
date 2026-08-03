import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { PetManager, checkedAssetUrl, webpDimensions } from "./pets";

function spritesheet(width = 1536, height = 1872): Buffer {
  const output = Buffer.alloc(30);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(22, 4);
  output.write("WEBP", 8, "ascii");
  output.write("VP8X", 12, "ascii");
  output.writeUInt32LE(10, 16);
  output.writeUIntLE(width - 1, 24, 3);
  output.writeUIntLE(height - 1, 27, 3);
  return output;
}

function fixtureFetch(image = spritesheet()) {
  const entry = {
    slug: "paperclip",
    displayName: "Paperclip",
    kind: "object",
    submittedBy: "Fixture",
    spritesheetUrl: "https://assets.petdex.dev/pets/paperclip-fixture/sprite.webp",
    petJsonUrl: "https://assets.petdex.dev/pets/paperclip-fixture/petjson.json",
    zipUrl: "https://assets.petdex.dev/pets/paperclip-fixture/zip.zip"
  };
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === "https://assets.petdex.dev/manifests/petdex-v1.json") return new Response(JSON.stringify({ pets: [entry] }), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/petjson.json")) return new Response(JSON.stringify({ id: "paperclip", displayName: "Paperclip", description: "A friendly office helper.", spritesheetPath: "spritesheet.webp" }));
    if (url.endsWith("/sprite.webp")) {
      const body = new Uint8Array(image.byteLength);
      body.set(image);
      return new Response(body.buffer, { headers: { "content-type": "image/webp" } });
    }
    return new Response("missing", { status: 404 });
  };
}

describe("Petdex cosmetic pet manager", () => {
  it("searches, installs, verifies, persists, configures, and removes a pet", async () => {
    const root = mkdtempSync(join(tmpdir(), "workstrand-pets-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    try {
      const manager = new PetManager(database, root, fixtureFetch(), () => new Date("2026-07-23T12:00:00.000Z"));
      await expect(manager.verifyDecoder()).resolves.toMatchObject({
        decoder: "sharp",
        ok: true,
      });
      expect(manager.status()).toMatchObject({ configuration: { enabled: false, scale: 0.33 }, installed: [] });
      expect(await manager.gallery("clip", 10)).toMatchObject([{ slug: "paperclip", submittedBy: "Fixture" }]);
      expect(await manager.install("paperclip", true)).toMatchObject({ configuration: { enabled: true, selectedSlug: "paperclip" }, installed: [{ width: 1536, height: 1872 }] });
      expect(manager.asset("paperclip")).toMatchObject({ slug: "paperclip", mediaType: "image/webp" });
      expect(manager.configure({ scale: 0.5, renderMode: "unicode" })).toMatchObject({ configuration: { scale: 0.5, renderMode: "unicode" } });
      expect(new PetManager(database, root, fixtureFetch()).status()).toMatchObject({ configuration: { selectedSlug: "paperclip" }, installed: [{ slug: "paperclip" }] });
      expect(manager.remove("paperclip")).toMatchObject({ configuration: { enabled: false }, installed: [] });
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects untrusted asset hosts and malformed atlas dimensions", async () => {
    expect(() => checkedAssetUrl("https://example.com/pets/a/sprite.webp", "sprite.webp")).toThrow("pinned");
    expect(() => checkedAssetUrl("not a URL", "sprite.webp")).toThrow("pinned");
    expect(webpDimensions(spritesheet())).toEqual({ width: 1536, height: 1872 });
    const root = mkdtempSync(join(tmpdir(), "workstrand-pets-invalid-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    try {
      const manager = new PetManager(database, root, fixtureFetch(spritesheet(100, 100)));
      await expect(manager.install("paperclip")).rejects.toThrow("8-column");
      expect(manager.status().installed).toEqual([]);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders verified frames through Unicode, iTerm2, and Kitty protocols", async () => {
    const image = await sharp({ create: { width: 1536, height: 1872, channels: 4, background: { r: 190, g: 80, b: 40, alpha: 1 } } }).webp().toBuffer();
    const root = mkdtempSync(join(tmpdir(), "workstrand-pets-render-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    try {
      const manager = new PetManager(database, root, fixtureFetch(image));
      await manager.install("paperclip");
      expect(await manager.terminalFrame("paperclip", "review", "unicode", 8, 0)).toContain("\u001b[38;2;190;80;40m");
      expect(await manager.terminalFrame("paperclip", "idle", "iterm", 8, 0)).toContain("\u001b]1337;File=inline=1;width=8");
      expect(await manager.terminalFrame("paperclip", "waiting", "kitty", 8, 0)).toContain("\u001b_Gf=100,a=T");
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
