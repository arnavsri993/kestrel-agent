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
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import type { KestrelDatabase } from "@kestrel/database";
import {
  InstalledPetSchema,
  PetConfigurationSchema,
  PetGalleryEntrySchema,
  PetStatusSchema,
  type InstalledPet,
  type PetActivityState,
  type PetConfiguration,
  type PetGalleryEntry,
  type PetStatus,
} from "@kestrel/shared-types";

// petdex.dev/api/manifest currently redirects here. Pinning the versioned asset
// avoids accepting an open-ended redirect while preserving the public v1 feed.
const MANIFEST_URL = "https://assets.petdex.dev/manifests/petdex-v1.json";
const MAX_MANIFEST_BYTES = 8_000_000;
const MAX_METADATA_BYTES = 32_000;
const MAX_SPRITE_BYTES = 8_000_000;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function checkedAssetUrl(
  value: string,
  filename: "sprite.webp" | "petjson.json",
): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "assets.petdex.dev" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(
      `^/pets/[a-z0-9-]{1,160}/${filename.replace(".", "\\.")}$`,
    ).test(url.pathname)
  )
    throw new Error(
      "Petdex asset URL is outside the pinned public asset host.",
    );
  return url;
}

async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  if (!response.ok)
    throw new Error(`Petdex request failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximum)
    throw new Error("Petdex response exceeds the byte limit.");
  if (!response.body) throw new Error("Petdex response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("Petdex response exceeds the byte limit.");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks, total);
}

async function pinnedFetch(
  fetcher: Fetcher,
  url: URL,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Petdex request timed out.")),
    15_000,
  );
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept:
          url.pathname.endsWith(".json") || url.pathname === "/api/manifest"
            ? "application/json"
            : "image/webp",
        "user-agent": "Kestrel/1 petdex-client",
      },
    });
    return await boundedBytes(response, maximum);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function webpDimensions(data: Buffer): { width: number; height: number } {
  if (
    data.byteLength < 30 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP"
  )
    throw new Error("Pet spritesheet is not a WebP image.");
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const kind = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > data.byteLength)
      throw new Error("Pet spritesheet has a malformed WebP chunk.");
    if (kind === "VP8X" && size >= 10)
      return {
        width: 1 + data.readUIntLE(start + 4, 3),
        height: 1 + data.readUIntLE(start + 7, 3),
      };
    if (
      kind === "VP8 " &&
      size >= 10 &&
      data[start + 3] === 0x9d &&
      data[start + 4] === 0x01 &&
      data[start + 5] === 0x2a
    ) {
      return {
        width: data.readUInt16LE(start + 6) & 0x3fff,
        height: data.readUInt16LE(start + 8) & 0x3fff,
      };
    }
    if (kind === "VP8L" && size >= 5 && data[start] === 0x2f) {
      const b1 = data[start + 1]!;
      const b2 = data[start + 2]!;
      const b3 = data[start + 3]!;
      const b4 = data[start + 4]!;
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
      };
    }
    offset = start + size + (size % 2);
  }
  throw new Error("Pet spritesheet dimensions could not be read.");
}

function metadata(
  value: unknown,
  entry: PetGalleryEntry,
): { displayName: string; description: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pet metadata must be a JSON object.");
  const record = value as Record<string, unknown>;
  const displayName =
    typeof record.displayName === "string"
      ? record.displayName.trim()
      : entry.displayName;
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (!displayName || displayName.length > 120 || description.length > 500)
    throw new Error("Pet metadata text exceeds its bounds.");
  if (
    record.spritesheetPath !== undefined &&
    record.spritesheetPath !== "spritesheet.webp"
  )
    throw new Error("Pet metadata references an unsupported spritesheet.");
  return { displayName, description };
}

export class PetManager {
  private readonly root: string;
  private readonly recordsKey = "display.installed-pets";
  private readonly configurationKey = "display.pet";
  private manifestCache?: { expiresAt: number; entries: PetGalleryEntry[] };

  constructor(
    private readonly database: KestrelDatabase,
    petRoot: string,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      existsSync(petRoot) &&
      (!lstatSync(petRoot).isDirectory() || lstatSync(petRoot).isSymbolicLink())
    )
      throw new Error("Pet root must be a regular directory.");
    mkdirSync(petRoot, { recursive: true, mode: 0o700 });
    chmodSync(petRoot, 0o700);
    this.root = realpathSync(petRoot);
    this.persist(this.configuration(), this.installed());
  }

  configuration(): PetConfiguration {
    const parsed = PetConfigurationSchema.safeParse(
      this.database.getPrivateState(this.configurationKey),
    );
    return parsed.success
      ? parsed.data
      : { enabled: false, scale: 0.33, renderMode: "auto", poppedOut: false };
  }

  installed(): InstalledPet[] {
    const stored =
      this.database.getPrivateState<unknown[]>(this.recordsKey) ?? [];
    return stored
      .flatMap((value) => {
        const parsed = InstalledPetSchema.safeParse(value);
        if (!parsed.success) return [];
        const path = this.assetPath(parsed.data.slug);
        return existsSync(path) &&
          lstatSync(path).isFile() &&
          !lstatSync(path).isSymbolicLink()
          ? [parsed.data]
          : [];
      })
      .slice(0, 100);
  }

  status(): PetStatus {
    const installed = this.installed();
    const current = this.configuration();
    const selectedExists =
      current.selectedSlug &&
      installed.some((pet) => pet.slug === current.selectedSlug);
    const configuration = selectedExists
      ? current
      : { ...current, enabled: false, selectedSlug: undefined };
    if (!selectedExists && (current.enabled || current.selectedSlug))
      this.persist(configuration, installed);
    return PetStatusSchema.parse({ configuration, installed });
  }

  async gallery(
    query = "",
    limit = 24,
    signal?: AbortSignal,
  ): Promise<PetGalleryEntry[]> {
    const entries = await this.manifest(signal);
    const normalized = query.trim().toLocaleLowerCase();
    const matches = normalized
      ? entries.filter((entry) =>
          [entry.slug, entry.displayName, entry.kind, entry.submittedBy].some(
            (value) => value.toLocaleLowerCase().includes(normalized),
          ),
        )
      : entries;
    return matches.slice(0, Math.max(1, Math.min(100, limit)));
  }

  async install(
    slug: string,
    select = true,
    signal?: AbortSignal,
    force = false,
  ): Promise<PetStatus> {
    const existing = this.installed().find((pet) => pet.slug === slug);
    if (existing && !force) return select ? this.select(slug) : this.status();
    if (!existing && this.installed().length >= 100)
      throw new Error("At most 100 pets can be installed.");
    const entry = (await this.manifest(signal)).find(
      (candidate) => candidate.slug === slug,
    );
    if (!entry)
      throw new Error(
        `Pet ${slug} is not in the current approved Petdex manifest.`,
      );
    const spriteUrl = checkedAssetUrl(entry.spritesheetUrl, "sprite.webp");
    const metadataUrl = checkedAssetUrl(entry.petJsonUrl, "petjson.json");
    const [sprite, petMetadata] = await Promise.all([
      pinnedFetch(this.fetcher, spriteUrl, MAX_SPRITE_BYTES, signal),
      pinnedFetch(this.fetcher, metadataUrl, MAX_METADATA_BYTES, signal),
    ]);
    const dimensions = webpDimensions(sprite);
    if (dimensions.width !== 1536 || ![1664, 1872].includes(dimensions.height))
      throw new Error(
        "Pet spritesheet must be an 8-column Petdex atlas with 8 or 9 rows.",
      );
    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(petMetadata.toString("utf8"));
    } catch {
      throw new Error("Pet metadata is not valid JSON.");
    }
    const safeMetadata = metadata(parsedMetadata, entry);
    const directory = this.petDirectory(slug);
    if (
      existsSync(directory) &&
      (!lstatSync(directory).isDirectory() ||
        lstatSync(directory).isSymbolicLink())
    )
      throw new Error("Pet destination is unsafe.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.sprite-${randomUUID()}.partial`);
    writeFileSync(temporary, sprite, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.assetPath(slug));
    const installed = InstalledPetSchema.parse({
      slug,
      displayName: safeMetadata.displayName,
      description: safeMetadata.description,
      kind: entry.kind,
      submittedBy: entry.submittedBy,
      sha256: createHash("sha256").update(sprite).digest("hex"),
      bytes: sprite.byteLength,
      ...dimensions,
      installedAt: this.now().toISOString(),
    });
    const records = [
      ...this.installed().filter((pet) => pet.slug !== slug),
      installed,
    ];
    const current = this.configuration();
    this.persist(
      select ? { ...current, enabled: true, selectedSlug: slug } : current,
      records,
    );
    return this.status();
  }

  installGenerated(input: {
    slug: string;
    displayName: string;
    description?: string;
    spritesheet: Uint8Array;
    select?: boolean;
  }): PetStatus {
    const slug = input.slug;
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug))
      throw new Error("Generated pet slug is invalid.");
    if (this.installed().some((pet) => pet.slug === slug))
      throw new Error(`Pet ${slug} is already installed.`);
    if (this.installed().length >= 100)
      throw new Error("At most 100 pets can be installed.");
    const sprite = Buffer.from(input.spritesheet);
    if (sprite.byteLength === 0 || sprite.byteLength > MAX_SPRITE_BYTES)
      throw new Error("Generated pet spritesheet violates the byte limit.");
    const dimensions = webpDimensions(sprite);
    if (dimensions.width !== 1536 || dimensions.height !== 1872)
      throw new Error("Generated pet must be a current 8×9 Petdex atlas.");
    const displayName = input.displayName.trim();
    const description = input.description?.trim() ?? "";
    if (!displayName || displayName.length > 120 || description.length > 500)
      throw new Error("Generated pet metadata text exceeds its bounds.");
    const directory = this.petDirectory(slug);
    if (existsSync(directory))
      throw new Error(`Pet destination ${slug} already exists.`);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    const temporary = join(directory, `.sprite-${randomUUID()}.partial`);
    writeFileSync(temporary, sprite, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.assetPath(slug));
    const installed = InstalledPetSchema.parse({
      slug,
      displayName,
      description,
      kind: "generated",
      submittedBy: "Kestrel Hatch",
      sha256: createHash("sha256").update(sprite).digest("hex"),
      bytes: sprite.byteLength,
      ...dimensions,
      installedAt: this.now().toISOString(),
    });
    const records = [...this.installed(), installed];
    const current = this.configuration();
    this.persist(
      input.select === false
        ? current
        : { ...current, enabled: true, selectedSlug: slug },
      records,
    );
    return this.status();
  }

  select(slug: string): PetStatus {
    if (!this.installed().some((pet) => pet.slug === slug))
      throw new Error(`Pet ${slug} is not installed.`);
    this.persist(
      { ...this.configuration(), enabled: true, selectedSlug: slug },
      this.installed(),
    );
    return this.status();
  }

  configure(
    input: Partial<
      Pick<PetConfiguration, "enabled" | "scale" | "renderMode" | "poppedOut">
    >,
  ): PetStatus {
    const current = this.status().configuration;
    const configuration = PetConfigurationSchema.parse({
      ...current,
      ...input,
    });
    if (configuration.enabled && !configuration.selectedSlug)
      throw new Error("Install and select a pet before enabling it.");
    this.persist(configuration, this.installed());
    return this.status();
  }

  remove(slug: string): PetStatus {
    const records = this.installed();
    if (!records.some((pet) => pet.slug === slug))
      throw new Error(`Pet ${slug} is not installed.`);
    const directory = this.petDirectory(slug);
    if (!within(this.root, directory) || directory === this.root)
      throw new Error("Pet removal target escapes the pet root.");
    if (existsSync(directory))
      rmSync(directory, { recursive: true, force: false });
    const nextRecords = records.filter((pet) => pet.slug !== slug);
    const current = this.configuration();
    const configuration =
      current.selectedSlug === slug
        ? { ...current, enabled: false, selectedSlug: undefined }
        : current;
    this.persist(configuration, nextRecords);
    return this.status();
  }

  asset(slug: string): {
    slug: string;
    mediaType: "image/webp";
    dataBase64: string;
  } {
    const record = this.installed().find((pet) => pet.slug === slug);
    if (!record) throw new Error(`Pet ${slug} is not installed.`);
    const path = realpathSync(this.assetPath(slug));
    if (
      !within(this.root, path) ||
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink()
    )
      throw new Error("Pet asset path is unsafe.");
    const data = readFileSync(path);
    if (
      data.byteLength !== record.bytes ||
      createHash("sha256").update(data).digest("hex") !== record.sha256
    )
      throw new Error("Pet asset integrity verification failed.");
    return {
      slug,
      mediaType: "image/webp",
      dataBase64: data.toString("base64"),
    };
  }

  async verifyDecoder(): Promise<{
    decoder: "sharp";
    version: string;
    ok: true;
  }> {
    const encoded = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 32, g: 96, b: 160, alpha: 1 },
      },
    })
      .webp({ lossless: true })
      .toBuffer();
    const decoded = await sharp(encoded).metadata();
    if (
      decoded.format !== "webp" ||
      decoded.width !== 1 ||
      decoded.height !== 1
    )
      throw new Error("Sharp WebP encode/decode diagnostic failed.");
    return { decoder: "sharp", version: sharp.versions.sharp, ok: true };
  }

  async terminalFrame(
    slug: string,
    state: PetActivityState,
    mode: "kitty" | "iterm" | "sixel" | "unicode",
    columns = 24,
    frame = 0,
  ): Promise<string> {
    const record = this.installed().find((pet) => pet.slug === slug);
    if (!record) throw new Error(`Pet ${slug} is not installed.`);
    const path = realpathSync(this.assetPath(slug));
    if (!within(this.root, path) || !lstatSync(path).isFile())
      throw new Error("Pet asset path is unsafe.");
    const rows = record.height / 208;
    const row = (
      {
        idle: 0,
        wave: 3,
        run: 7,
        failed: 5,
        review: rows >= 9 ? 8 : 0,
        jump: 4,
        waiting: rows >= 9 ? 6 : 0,
      } as Record<PetActivityState, number>
    )[state];
    const image = sharp(path).extract({
      left: Math.max(0, Math.min(7, frame)) * 192,
      top: row * 208,
      width: 192,
      height: 208,
    });
    const width = Math.max(8, Math.min(80, Math.round(columns)));
    if (mode === "iterm" || mode === "kitty") {
      const png = await image.png().toBuffer();
      const encoded = png.toString("base64");
      if (mode === "iterm")
        return `\x1b]1337;File=inline=1;width=${width};preserveAspectRatio=1:${encoded}\x07\n`;
      const chunks = encoded.match(/.{1,4096}/g) ?? [];
      return `${chunks.map((chunk, index) => `\x1b_Gf=100,a=T,q=2,c=${width},m=${index < chunks.length - 1 ? 1 : 0};${chunk}\x1b\\`).join("")}\n`;
    }
    // Sharp has no sixel encoder; explicit sixel mode therefore receives the
    // same deterministic truecolor half-block fallback as auto mode.
    const pixelRows = Math.max(8, Math.round((width * 208) / 192));
    const { data, info } = await image
      .resize(width, pixelRows, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lines: string[] = [];
    for (let y = 0; y < info.height; y += 2) {
      let line = "";
      for (let x = 0; x < info.width; x += 1) {
        const top = (y * info.width + x) * 4;
        const bottom = (Math.min(y + 1, info.height - 1) * info.width + x) * 4;
        const topVisible = data[top + 3]! >= 32;
        const bottomVisible = data[bottom + 3]! >= 32;
        if (!topVisible && !bottomVisible) line += "\x1b[0m ";
        else if (topVisible && bottomVisible)
          line += `\x1b[38;2;${data[top]};${data[top + 1]};${data[top + 2]}m\x1b[48;2;${data[bottom]};${data[bottom + 1]};${data[bottom + 2]}m▀`;
        else if (topVisible)
          line += `\x1b[0m\x1b[38;2;${data[top]};${data[top + 1]};${data[top + 2]}m▀`;
        else
          line += `\x1b[0m\x1b[38;2;${data[bottom]};${data[bottom + 1]};${data[bottom + 2]}m▄`;
      }
      lines.push(`${line}\x1b[0m`);
    }
    return `${lines.join("\n")}\n`;
  }

  private async manifest(signal?: AbortSignal): Promise<PetGalleryEntry[]> {
    if (this.manifestCache && this.manifestCache.expiresAt > Date.now())
      return this.manifestCache.entries;
    const data = await pinnedFetch(
      this.fetcher,
      new URL(MANIFEST_URL),
      MAX_MANIFEST_BYTES,
      signal,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString("utf8"));
    } catch {
      throw new Error("Petdex manifest is not valid JSON.");
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      !Array.isArray((raw as { pets?: unknown }).pets)
    )
      throw new Error("Petdex manifest shape is invalid.");
    const entries = (raw as { pets: unknown[] }).pets.flatMap((value) => {
      try {
        const record =
          value && typeof value === "object"
            ? { ...(value as Record<string, unknown>) }
            : value;
        if (record && typeof record === "object")
          delete (record as Record<string, unknown>).zipUrl;
        const entry = PetGalleryEntrySchema.parse(record);
        checkedAssetUrl(entry.spritesheetUrl, "sprite.webp");
        checkedAssetUrl(entry.petJsonUrl, "petjson.json");
        return [entry];
      } catch {
        // The public gallery can contain legacy packages. They stay invisible
        // until they satisfy the current bounded WebP v1 contract.
        return [];
      }
    });
    if (entries.length === 0)
      throw new Error("Petdex manifest contains no compatible approved pets.");
    this.manifestCache = { expiresAt: Date.now() + 5 * 60_000, entries };
    return entries;
  }

  private petDirectory(slug: string): string {
    const path = resolve(this.root, slug);
    if (!within(this.root, path) || path === this.root)
      throw new Error("Pet slug escapes the pet root.");
    return path;
  }

  private assetPath(slug: string): string {
    return join(this.petDirectory(slug), "spritesheet.webp");
  }

  private persist(
    configuration: PetConfiguration,
    installed: InstalledPet[],
  ): void {
    this.database.setPrivateState(this.configurationKey, configuration);
    this.database.setPrivateState(this.recordsKey, installed);
  }
}

export { checkedAssetUrl, webpDimensions };
