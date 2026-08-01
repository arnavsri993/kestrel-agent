import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { MediaGenerationProvider } from "./media-artifacts";
import { PetHatchManager } from "./pet-hatch";
import { PetManager, webpDimensions } from "./pets";

async function fixtureImage(frameCount?: number): Promise<Buffer> {
  const width = frameCount ? 1536 : 1024;
  const height = 1024;
  const shapes = frameCount
    ? Array.from({ length: frameCount }, (_value, index) => {
        const slot = width / frameCount;
        return `<rect x="${Math.round(index * slot + slot * 0.2)}" y="180" width="${Math.round(slot * 0.6)}" height="650" rx="24" fill="#5e9df5"/>`;
      }).join("")
    : '<rect x="292" y="170" width="440" height="680" rx="60" fill="#5e9df5"/>';
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ff00ff"/>${shapes}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

describe("two-stage pet hatch workflow", () => {
  it("generates cost-bounded drafts, grounds rows on the selected reference, assembles, verifies, and adopts an atlas", async () => {
    const root = mkdtempSync(join(tmpdir(), "workstrand-hatch-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const calls: Array<{
      references: number;
      quality?: string;
      size?: string;
    }> = [];
    const provider: MediaGenerationProvider = {
      id: "fixture-image",
      supportsReferenceImages: true,
      async generate(input) {
        const count = Number(
          /exactly (\d+) sequential/.exec(input.prompt)?.[1] ?? 0,
        );
        calls.push({
          references: input.referenceImages?.length ?? 0,
          ...(input.quality ? { quality: input.quality } : {}),
          ...(input.size ? { size: input.size } : {}),
        });
        return {
          data: await fixtureImage(count || undefined),
          mediaType: "image/png",
          model: "fixture-image-v1",
        };
      },
    };
    try {
      const pets = new PetManager(database, join(root, "pets"));
      const manager = new PetHatchManager(
        database,
        join(root, "pets", ".hatch"),
        [provider],
        pets,
        () => new Date("2026-07-23T12:00:00.000Z"),
      );
      expect(manager.capability()).toEqual({
        available: true,
        providerId: "fixture-image",
      });
      const drafts = await manager.generateDrafts(
        { concept: "a blue paper bird", count: 2 },
        new AbortController().signal,
      );
      expect(drafts).toHaveLength(2);
      expect(drafts[0]).toMatchObject({
        concept: "a blue paper bird",
        mediaType: "image/png",
        providerId: "fixture-image",
      });
      const result = await manager.hatch(
        { draftId: drafts[0]!.id, slug: "bluebird", displayName: "Bluebird" },
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        slug: "bluebird",
        providerId: "fixture-image",
        petStatus: {
          configuration: { enabled: true, selectedSlug: "bluebird" },
          installed: [
            { slug: "bluebird", width: 1536, height: 1872, kind: "generated" },
          ],
        },
      });
      const asset = Buffer.from(pets.asset("bluebird").dataBase64, "base64");
      expect(webpDimensions(asset)).toEqual({ width: 1536, height: 1872 });
      expect(calls.filter((call) => call.references === 0)).toHaveLength(2);
      expect(calls.filter((call) => call.references === 1)).toHaveLength(8);
      expect(
        calls
          .filter((call) => call.references === 1)
          .every(
            (call) => call.quality === "medium" && call.size === "1536x1024",
          ),
      ).toBe(true);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("surfaces an actionable unavailable state without an image provider", () => {
    const root = mkdtempSync(join(tmpdir(), "workstrand-hatch-unavailable-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    try {
      const pets = new PetManager(database, join(root, "pets"));
      const manager = new PetHatchManager(
        database,
        join(root, "pets", ".hatch"),
        [],
        pets,
      );
      expect(manager.capability()).toMatchObject({
        available: false,
        reason: expect.stringContaining("Connections"),
      });
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes generated draft files when draft persistence fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "workstrand-hatch-rollback-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const provider: MediaGenerationProvider = {
      id: "fixture-image",
      supportsReferenceImages: true,
      async generate() {
        return {
          data: await fixtureImage(),
          mediaType: "image/png",
          model: "fixture-image-v1",
        };
      },
    };
    try {
      const pets = new PetManager(database, join(root, "pets"));
      const manager = new PetHatchManager(
        database,
        join(root, "hatch"),
        [provider],
        pets,
      );
      const setPrivateState = database.setPrivateState.bind(database);
      database.setPrivateState = (key, value) => {
        if (key === "display.pet-hatch-drafts")
          throw new Error("draft state unavailable");
        setPrivateState(key, value);
      };

      await expect(
        manager.generateDrafts(
          { concept: "a blue paper bird", count: 2 },
          new AbortController().signal,
        ),
      ).rejects.toThrow("draft state unavailable");
      expect(readdirSync(join(root, "hatch"))).toEqual([]);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
