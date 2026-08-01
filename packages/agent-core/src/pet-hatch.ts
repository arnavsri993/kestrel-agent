import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { KestrelDatabase } from "@kestrel/database";
import type { PetStatus } from "@kestrel/shared-types";
import type { MediaGenerationProvider } from "./media-artifacts";
import type { PetManager } from "./pets";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT = 1872;
const MAX_DRAFT_BYTES = 8_000_000;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

const ROWS = [
  {
    state: "idle",
    row: 0,
    frames: 6,
    action: "a calm breathing and blinking idle loop",
  },
  {
    state: "running-right",
    row: 1,
    frames: 8,
    action: "a clear side-view walk or run cycle facing right",
  },
  {
    state: "running-left",
    row: 2,
    frames: 8,
    action: "the exact mirrored left-facing locomotion cycle",
  },
  { state: "waving", row: 3, frames: 4, action: "a friendly raised-limb wave" },
  {
    state: "jumping",
    row: 4,
    frames: 5,
    action: "a joyful anticipation, lift, peak, and landing jump",
  },
  {
    state: "failed",
    row: 5,
    frames: 8,
    action: "a readable sad or deflated reaction",
  },
  {
    state: "waiting",
    row: 6,
    frames: 6,
    action: "an expectant waiting-for-the-user pose",
  },
  {
    state: "running",
    row: 7,
    frames: 6,
    action: "focused work in place, not walking",
  },
  {
    state: "review",
    row: 8,
    frames: 6,
    action: "careful thinking and inspection",
  },
] as const;

const BASE_VARIATIONS = [
  "a balanced silhouette and restrained palette",
  "a different palette and distinctive markings",
  "a broader silhouette with sturdy proportions",
  "a different face, expression, and small accessory",
] as const;

interface StoredDraft {
  id: string;
  concept: string;
  style: string;
  filename: string;
  sha256: string;
  bytes: number;
  providerId: string;
  model: string;
  createdAt: string;
}

export interface PetHatchDraft {
  id: string;
  concept: string;
  style: string;
  mediaType: "image/png";
  dataBase64: string;
  providerId: string;
  model: string;
  createdAt: string;
}

export interface PetHatchCapability {
  available: boolean;
  providerId?: string;
  model?: string;
  reason?: string;
}

export interface PetHatchResult {
  slug: string;
  displayName: string;
  states: string[];
  sha256: string;
  providerId: string;
  model: string;
  petStatus: PetStatus;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function basePrompt(concept: string, style: string, variation: string): string {
  return [
    `Create one original mascot pet character: ${concept}.`,
    `Variation: ${variation}.`,
    `Style: ${style === "auto" ? "crisp 16-bit pixel-art game sprite with visible square pixels, a limited palette, a clean dark outline, flat shading, and compact chibi proportions" : style}.`,
    "Show one centered whole-body character in a neutral front-facing standing pose.",
    "Use one uninterrupted flat hot-magenta #FF00FF chroma-key background. If magenta is part of the character, use pure green #00FF00.",
    "No text, border, panel, grid, scenery, shadow, ground line, watermark, existing trademarked character, or extra object.",
  ].join(" ");
}

function rowPrompt(
  concept: string,
  style: string,
  state: string,
  frames: number,
  action: string,
): string {
  return [
    `Image 1 is the identity reference for the exact same original mascot (${concept}).`,
    `Preserve its species, face, palette, markings, proportions, outline, accessories, and ${style === "auto" ? "pixel-art" : style} style.`,
    `Create one wide horizontal strip containing exactly ${frames} sequential animation poses for ${state}: ${action}.`,
    `Keep every pose at the same scale and baseline, centered in one of ${frames} equal imaginary regions.`,
    "Leave a clean empty chroma-key gutter between every complete silhouette; fold tails, wings, or accessories inward so no poses touch.",
    "Use one uninterrupted flat hot-magenta #FF00FF background (or the reference's pure-green key).",
    "No text, labels, borders, panels, divider lines, grid, scenery, shadows, ground line, motion trails, or cropped limbs.",
  ].join(" ");
}

async function normalizedPng(data: Uint8Array): Promise<Buffer> {
  if (data.byteLength === 0 || data.byteLength > MAX_DRAFT_BYTES)
    throw new Error("Generated draft violates the 8 MB limit.");
  const image = sharp(data, { limitInputPixels: 16_777_216 })
    .rotate()
    .ensureAlpha();
  const metadata = await image.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > 3840 ||
    metadata.height > 3840
  )
    throw new Error("Generated draft dimensions are invalid.");
  return image.png().toBuffer();
}

async function keyedRaw(
  data: Uint8Array,
): Promise<{ data: Buffer; width: number; height: number }> {
  const decoded = await sharp(data, { limitInputPixels: 16_777_216 })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4)
    throw new Error("Generated sprite could not be decoded as RGBA.");
  const output = Buffer.from(decoded.data);
  const corners = [
    0,
    (decoded.info.width - 1) * 4,
    (decoded.info.height - 1) * decoded.info.width * 4,
    (decoded.info.height * decoded.info.width - 1) * 4,
  ];
  const key = [0, 1, 2].map((channel) =>
    Math.round(
      corners.reduce((total, offset) => total + output[offset + channel]!, 0) /
        corners.length,
    ),
  );
  const saturated = Math.max(...key) - Math.min(...key) >= 100;
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3]! <= 16) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = 0;
      continue;
    }
    const distance = Math.hypot(
      output[offset]! - key[0]!,
      output[offset + 1]! - key[1]!,
      output[offset + 2]! - key[2]!,
    );
    if (saturated && distance <= 92) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = 0;
    }
  }
  return {
    data: output,
    width: decoded.info.width,
    height: decoded.info.height,
  };
}

async function cellFromRegion(
  raw: { data: Buffer; width: number; height: number },
  left: number,
  width: number,
): Promise<Buffer> {
  let minX = width;
  let minY = raw.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (raw.data[(y * raw.width + left + x) * 4 + 3]! <= 24) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY)
    throw new Error("Generated animation strip contains an empty pose.");
  const subject = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  })
    .extract({
      left: left + minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .resize({ width: 172, height: 188, fit: "inside", kernel: "nearest" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const top = Math.max(0, CELL_HEIGHT - 10 - subject.info.height);
  const target = await sharp({
    create: {
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: subject.data,
        left: Math.floor((CELL_WIDTH - subject.info.width) / 2),
        top,
      },
    ])
    .png()
    .toBuffer();
  const stats = await sharp(target).stats();
  if (stats.channels[3]!.sum < CELL_WIDTH * CELL_HEIGHT * 0.03 * 255)
    throw new Error("Generated animation pose is too small to be legible.");
  return target;
}

async function extractFrames(
  data: Uint8Array,
  count: number,
): Promise<Buffer[]> {
  const raw = await keyedRaw(data);
  const frames: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = Math.round((index * raw.width) / count);
    const right = Math.round(((index + 1) * raw.width) / count);
    frames.push(await cellFromRegion(raw, left, right - left));
  }
  return frames;
}

async function baseFrames(data: Uint8Array, count: number): Promise<Buffer[]> {
  const raw = await keyedRaw(data);
  const frame = await cellFromRegion(raw, 0, raw.width);
  return Array.from({ length: count }, () => frame);
}

async function composeAtlas(frames: Map<string, Buffer[]>): Promise<Buffer> {
  const composites: OverlayOptions[] = [];
  for (const spec of ROWS) {
    const row = frames.get(spec.state) ?? [];
    for (const [column, frame] of row.slice(0, spec.frames).entries()) {
      composites.push({
        input: frame,
        left: column * CELL_WIDTH,
        top: spec.row * CELL_HEIGHT,
      });
    }
  }
  const atlas = await sharp({
    create: {
      width: ATLAS_WIDTH,
      height: ATLAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
  if (atlas.byteLength === 0 || atlas.byteLength > 8_000_000)
    throw new Error("Hatched atlas violates the 8 MB pet limit.");
  return atlas;
}

export class PetHatchManager {
  private readonly root: string;
  private readonly stateKey = "display.pet-hatch-drafts";

  constructor(
    private readonly database: KestrelDatabase,
    hatchRoot: string,
    private readonly providers: MediaGenerationProvider[],
    private readonly pets: PetManager,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      existsSync(hatchRoot) &&
      (!lstatSync(hatchRoot).isDirectory() ||
        lstatSync(hatchRoot).isSymbolicLink())
    )
      throw new Error("Pet hatch root must be a regular directory.");
    mkdirSync(hatchRoot, { recursive: true, mode: 0o700 });
    chmodSync(hatchRoot, 0o700);
    this.root = realpathSync(hatchRoot);
    this.cleanup();
  }

  capability(): PetHatchCapability {
    const provider = this.provider();
    return provider
      ? {
          available: true,
          providerId: provider.id,
          ...(provider.id === "openai-media" ? { model: "gpt-image-2" } : {}),
        }
      : {
          available: false,
          reason:
            "Connect a reference-image-capable provider in Connections. OpenAI image generation is supported when an API key is configured.",
        };
  }

  drafts(): PetHatchDraft[] {
    this.cleanup();
    return this.records().flatMap((record) => {
      const filename = this.draftPath(record.filename);
      if (
        !existsSync(filename) ||
        !lstatSync(filename).isFile() ||
        lstatSync(filename).isSymbolicLink()
      )
        return [];
      const data = readFileSync(filename);
      if (data.byteLength !== record.bytes || digest(data) !== record.sha256)
        return [];
      return [
        {
          id: record.id,
          concept: record.concept,
          style: record.style,
          mediaType: "image/png" as const,
          dataBase64: data.toString("base64"),
          providerId: record.providerId,
          model: record.model,
          createdAt: record.createdAt,
        },
      ];
    });
  }

  async generateDrafts(
    input: { concept: string; style?: string; count?: number },
    signal: AbortSignal,
  ): Promise<PetHatchDraft[]> {
    const concept = input.concept.trim();
    const style = input.style?.trim() || "auto";
    const count = Math.max(1, Math.min(4, input.count ?? 4));
    if (!concept || concept.length > 500 || style.length > 80)
      throw new Error("Pet concept or style exceeds its bounds.");
    const provider = this.provider();
    if (!provider) throw new Error(this.capability().reason);
    const model = provider.id === "openai-media" ? "gpt-image-2" : undefined;
    const generated = await Promise.allSettled(
      Array.from({ length: count }, async (_value, index) => {
        const result = await provider.generate({
          prompt: basePrompt(
            concept,
            style,
            BASE_VARIATIONS[index % BASE_VARIATIONS.length]!,
          ),
          kind: "image",
          ...(model ? { model } : {}),
          size: "1024x1024",
          quality: "low",
          signal,
        });
        const data = await normalizedPng(result.data);
        const id = `draft-${randomUUID()}`;
        const filename = `${id}.png`;
        const temporary = join(this.root, `.${id}.partial`);
        try {
          writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
          renameSync(temporary, this.draftPath(filename));
        } finally {
          try {
            rmSync(temporary, { force: true });
          } catch {
            // The rename normally consumes the temporary path.
          }
        }
        return {
          id,
          concept,
          style,
          filename,
          sha256: digest(data),
          bytes: data.byteLength,
          providerId: provider.id,
          model: result.model,
          createdAt: this.now().toISOString(),
        } satisfies StoredDraft;
      }),
    );
    const records = generated.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (records.length === 0) {
      const failure = generated.find((result) => result.status === "rejected");
      throw new Error(
        failure?.status === "rejected" && failure.reason instanceof Error
          ? failure.reason.message
          : "Image provider returned no usable pet drafts.",
      );
    }
    try {
      this.persist([...this.records(), ...records].slice(-12));
    } catch (error) {
      for (const record of records) {
        try {
          rmSync(this.draftPath(record.filename), { force: true });
        } catch {
          // Preserve the original persistence error if cleanup also fails.
        }
      }
      throw error;
    }
    return this.drafts().filter((draft) =>
      records.some((record) => record.id === draft.id),
    );
  }

  async hatch(
    input: {
      draftId: string;
      slug: string;
      displayName: string;
      description?: string;
    },
    signal: AbortSignal,
  ): Promise<PetHatchResult> {
    const record = this.records().find(
      (candidate) => candidate.id === input.draftId,
    );
    if (!record) throw new Error("Pet hatch draft was not found or expired.");
    const draftPath = this.draftPath(record.filename);
    const base = readFileSync(draftPath);
    if (base.byteLength !== record.bytes || digest(base) !== record.sha256)
      throw new Error("Pet hatch draft integrity verification failed.");
    const provider = this.providers.find(
      (candidate) =>
        candidate.id === record.providerId && candidate.supportsReferenceImages,
    );
    if (!provider)
      throw new Error(
        "The draft's reference-image provider is no longer configured.",
      );
    const model = provider.id === "openai-media" ? "gpt-image-2" : record.model;
    const specs = ROWS.filter((spec) => spec.state !== "running-left");
    const outcomes = await Promise.allSettled(
      specs.map(async (spec) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const result = await provider.generate({
              prompt: rowPrompt(
                record.concept,
                record.style,
                spec.state,
                spec.frames,
                spec.action,
              ),
              kind: "image",
              model,
              referenceImages: [{ data: base, mediaType: "image/png" }],
              size: "1536x1024",
              quality: "medium",
              signal,
            });
            return {
              state: spec.state,
              frames: await extractFrames(result.data, spec.frames),
              model: result.model,
            };
          } catch (cause) {
            lastError = cause;
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(`Could not generate ${spec.state}.`);
      }),
    );
    const frames = new Map<string, Buffer[]>();
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled")
        frames.set(outcome.value.state, outcome.value.frames);
    const right = frames.get("running-right");
    if (right)
      frames.set(
        "running-left",
        await Promise.all(
          right.map((frame) => sharp(frame).flop().png().toBuffer()),
        ),
      );
    if (!frames.has("idle")) frames.set("idle", await baseFrames(base, 6));
    const filled = [...frames.keys()];
    const required = ["idle", "running-right", "running-left", "waving"];
    const missing = required.filter((state) => !frames.has(state));
    if (missing.length || filled.length < 6)
      throw new Error(
        `Hatch did not produce enough usable animation rows${missing.length ? `; missing ${missing.join(", ")}` : ""}. Generate a fresh draft and retry.`,
      );
    const atlas = await composeAtlas(frames);
    const petStatus = this.pets.installGenerated({
      slug: input.slug,
      displayName: input.displayName,
      description: input.description ?? record.concept,
      spritesheet: atlas,
      select: true,
    });
    return {
      slug: input.slug,
      displayName: input.displayName,
      states: filled.sort(),
      sha256: digest(atlas),
      providerId: provider.id,
      model,
      petStatus,
    };
  }

  private provider(): MediaGenerationProvider | undefined {
    return this.providers.find((provider) => provider.supportsReferenceImages);
  }

  private records(): StoredDraft[] {
    const value = this.database.getPrivateState<StoredDraft[]>(this.stateKey);
    return Array.isArray(value) ? value.slice(0, 12) : [];
  }

  private persist(records: StoredDraft[]): void {
    this.database.setPrivateState(this.stateKey, records);
  }

  private cleanup(): void {
    const cutoff = this.now().getTime() - DRAFT_TTL_MS;
    const kept: StoredDraft[] = [];
    for (const record of this.records()) {
      const created = Date.parse(record.createdAt);
      if (!Number.isFinite(created) || created < cutoff) {
        const filename = this.draftPath(record.filename);
        if (
          existsSync(filename) &&
          lstatSync(filename).isFile() &&
          !lstatSync(filename).isSymbolicLink()
        )
          rmSync(filename);
      } else kept.push(record);
    }
    this.persist(kept.slice(-12));
  }

  private draftPath(filename: string): string {
    if (!/^draft-[a-f0-9-]{36}\.png$/.test(filename))
      throw new Error("Pet hatch draft filename is invalid.");
    const candidate = join(this.root, filename);
    if (!within(this.root, candidate))
      throw new Error("Pet hatch draft path escapes its root.");
    return candidate;
  }
}
