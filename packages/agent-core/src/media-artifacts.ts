import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import type { AgentRuntime } from "./runtime";

export interface GeneratedMedia {
  data: Uint8Array;
  mediaType: string;
  model: string;
  providerRequestId?: string;
  estimatedCostUsd?: number;
}

export interface MediaGenerationProvider {
  id: string;
  supportsReferenceImages?: boolean;
  kind?: "general" | "music";
  generate(input: {
    prompt: string;
    kind: "image" | "audio" | "music" | "video" | "document";
    model?: string;
    signal: AbortSignal;
    lyrics?: string;
    instrumental?: boolean;
    format?: "mp3" | "wav";
    referenceImages?: Array<{ data: Uint8Array; mediaType: string }>;
    size?: string;
    quality?: "low" | "medium" | "high" | "auto";
  }): Promise<GeneratedMedia>;
}

export interface ArtifactRecord {
  id: string;
  filename: string;
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  providerId?: string;
  model?: string;
  providerRequestId?: string;
  estimatedCostUsd?: number;
  artifactKind?: "media" | "widget";
  title?: string;
  sessionId?: string;
  createdAt: string;
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function extension(mediaType: string): string {
  return (
    (
      {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "video/mp4": ".mp4",
        "application/pdf": ".pdf",
        "text/markdown": ".md",
        "text/plain": ".txt",
        "text/html": ".html",
      } as Record<string, string>
    )[mediaType] ?? ".bin"
  );
}

function sniff(data: Uint8Array): {
  mediaType: string;
  width?: number;
  height?: number;
} {
  if (
    data.byteLength >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      mediaType: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  }
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8)
    return { mediaType: "image/jpeg" };
  if (new TextDecoder().decode(data.slice(0, 5)) === "%PDF-")
    return { mediaType: "application/pdf" };
  return { mediaType: "application/octet-stream" };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function widgetDocument(title: string, code: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--surface:transparent;--card:color-mix(in srgb,CanvasText 7%,Canvas);--text:CanvasText;--text-strong:CanvasText;--muted:GrayText;--border:color-mix(in srgb,CanvasText 22%,transparent);--accent:#b85f42;--accent-fill:#b85f42;--accent-fg:#fff;--ok:#2f7d57;--warn:#946b13;--danger:#a9433c;--radius:8px;--font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,monospace}*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--surface);color:var(--text);font:14px/1.5 var(--font-body)}h1,h2,h3{color:var(--text-strong)}button,input,select,textarea{font:inherit;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px}button{cursor:pointer}button.primary{background:var(--accent-fill);color:var(--accent-fg)}a{color:var(--accent)}code{font-family:var(--font-mono)}.card{border:1px solid var(--border);border-radius:var(--radius);padding:12px}.row{display:flex;gap:8px;flex-wrap:wrap}.muted{color:var(--muted)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<script>
globalThis.sendPrompt=function(text){if(!navigator.userActivation||!navigator.userActivation.isActive)return;const value=String(text||"").trim();if(!value||value.length>4000||value.startsWith("/"))return;parent.postMessage({type:"kestrel-widget-prompt",text:value},"*")};
</script>
</head>
<body>${code}</body>
</html>`;
}

function writeArtifactAtomically(destination: string, data: Uint8Array): void {
  const temporary = join(dirname(destination), `.tmp-${randomUUID()}`);
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename normally consumes the temporary path.
    }
  }
}

function removeArtifactFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The destination may already have been removed by a concurrent cleanup.
  }
}

export class ArtifactManager {
  private readonly root: string;
  private readonly providers = new Map<string, MediaGenerationProvider>();
  private readonly stateKey = "media.artifacts";

  constructor(
    private readonly database: KestrelDatabase,
    artifactRoot: string,
    providers: MediaGenerationProvider[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    this.root = realpathSync(artifactRoot);
    for (const provider of providers) {
      if (this.providers.has(provider.id))
        throw new Error(`Duplicate media provider ${provider.id}.`);
      this.providers.set(provider.id, provider);
    }
  }

  list(): ArtifactRecord[] {
    return this.database.getPrivateState<ArtifactRecord[]>(this.stateKey) ?? [];
  }

  preview(
    id: string,
    maximumBytes = 5_000_000,
  ): { id: string; mediaType: string; dataBase64: string; truncated: boolean } {
    const artifact = this.list().find((item) => item.id === id);
    if (!artifact) throw new Error("Artifact was not found.");
    const path = realpathSync(artifact.path);
    if (!within(this.root, path) || !statSync(path).isFile())
      throw new Error("Artifact preview path escapes the artifact root.");
    const data = readFileSync(path);
    const limit = Math.max(1, Math.min(10_000_000, maximumBytes));
    return {
      id,
      mediaType: artifact.mediaType,
      dataBase64: data.subarray(0, limit).toString("base64"),
      truncated: data.byteLength > limit,
    };
  }

  inspect(path: string): ArtifactRecord {
    const candidate = realpathSync(resolve(this.root, path));
    if (!within(this.root, candidate) || !statSync(candidate).isFile())
      throw new Error("Artifact path escapes the artifact root.");
    const data = readFileSync(candidate);
    const detected = sniff(data);
    return {
      id: "inspection",
      filename: basename(candidate),
      path: candidate,
      mediaType: detected.mediaType,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      ...(detected.width ? { width: detected.width } : {}),
      ...(detected.height ? { height: detected.height } : {}),
      createdAt: this.now().toISOString(),
    };
  }

  async generate(
    input: {
      providerId: string;
      prompt: string;
      kind: "image" | "audio" | "music" | "video" | "document";
      model?: string;
      filename?: string;
      maximumBytes?: number;
      lyrics?: string;
      instrumental?: boolean;
      format?: "mp3" | "wav";
    },
    signal: AbortSignal,
  ): Promise<ArtifactRecord> {
    const provider = this.providers.get(input.providerId);
    if (!provider)
      throw new Error(`Media provider ${input.providerId} is not configured.`);
    const generated = await provider.generate({
      prompt: input.prompt,
      kind: input.kind,
      ...(input.model ? { model: input.model } : {}),
      ...(input.lyrics !== undefined ? { lyrics: input.lyrics } : {}),
      ...(input.instrumental !== undefined
        ? { instrumental: input.instrumental }
        : {}),
      ...(input.format ? { format: input.format } : {}),
      signal,
    });
    const maximum = input.maximumBytes ?? 100_000_000;
    if (generated.data.byteLength === 0 || generated.data.byteLength > maximum)
      throw new Error("Generated artifact violates the byte limit.");
    const detected = sniff(generated.data);
    if (
      detected.mediaType !== "application/octet-stream" &&
      detected.mediaType !== generated.mediaType
    )
      throw new Error(
        "Generated artifact media type does not match its bytes.",
      );
    const requested = (input.filename ?? `${input.kind}-${randomUUID()}`)
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 120);
    const filename = extname(requested)
      ? requested
      : `${requested}${extension(generated.mediaType)}`;
    const destination = resolve(this.root, filename);
    if (!within(this.root, destination))
      throw new Error("Generated artifact path escapes the artifact root.");
    if (existsSync(destination))
      throw new Error("Generated artifact filename already exists.");
    let registered = false;
    try {
      writeArtifactAtomically(destination, generated.data);
      const record: ArtifactRecord = {
        id: `artifact-${randomUUID()}`,
        filename,
        path: destination,
        mediaType: generated.mediaType,
        bytes: generated.data.byteLength,
        sha256: createHash("sha256").update(generated.data).digest("hex"),
        ...(detected.width ? { width: detected.width } : {}),
        ...(detected.height ? { height: detected.height } : {}),
        providerId: provider.id,
        model: generated.model,
        ...(generated.providerRequestId
          ? { providerRequestId: generated.providerRequestId }
          : {}),
        ...(generated.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: generated.estimatedCostUsd }
          : {}),
        createdAt: this.now().toISOString(),
      };
      this.database.setPrivateState(this.stateKey, [...this.list(), record]);
      registered = true;
      return record;
    } catch (error) {
      if (!registered) removeArtifactFile(destination);
      throw error;
    }
  }

  musicProviders(): Array<{ id: string }> {
    return [...this.providers.values()]
      .filter((provider) => provider.kind === "music")
      .map((provider) => ({ id: provider.id }));
  }

  createWidget(input: {
    title: string;
    code: string;
    sessionId: string;
    filename?: string;
  }): ArtifactRecord {
    const title = input.title.trim();
    if (!title || title.length > 80)
      throw new Error("Widget title must contain 1–80 characters.");
    if (
      !input.code.trim() ||
      Buffer.byteLength(input.code, "utf8") > 256 * 1024 ||
      input.code.includes("\0")
    )
      throw new Error("Widget code must be non-empty and at most 256 KB.");
    if (/<\s*(?:base|meta)\b/i.test(input.code))
      throw new Error("Widget code cannot replace host security metadata.");
    const requested = (
      input.filename ??
      `widget-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}.html`
    )
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 120);
    const filename = extname(requested) ? requested : `${requested}.html`;
    const destination = resolve(this.root, filename);
    if (!within(this.root, destination) || existsSync(destination))
      throw new Error("Widget artifact destination is unavailable.");
    const data = Buffer.from(widgetDocument(title, input.code), "utf8");
    let registered = false;
    try {
      writeArtifactAtomically(destination, data);
      const record: ArtifactRecord = {
        id: `artifact-${randomUUID()}`,
        filename,
        path: destination,
        mediaType: "text/html",
        bytes: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
        providerId: "local-widget",
        model: "sandbox-v1",
        artifactKind: "widget",
        title,
        sessionId: input.sessionId,
        createdAt: this.now().toISOString(),
      };
      const existing = this.list();
      const scoped = existing.filter(
        (item) =>
          item.artifactKind === "widget" && item.sessionId === input.sessionId,
      );
      const evicted = scoped.length >= 32 ? scoped.slice(0, scoped.length - 31) : [];
      const evictedIds = new Set(evicted.map((item) => item.id));
      this.database.setPrivateState(this.stateKey, [
        ...existing.filter((item) => !evictedIds.has(item.id)),
        record,
      ]);
      registered = true;
      for (const item of evicted) {
        try {
          const path = realpathSync(item.path);
          if (within(this.root, path) && statSync(path).isFile()) unlinkSync(path);
        } catch {
          // Missing historical widget files are removed from the index below.
        }
      }
      return record;
    } catch (error) {
      if (!registered) removeArtifactFile(destination);
      throw error;
    }
  }
}

function registerMediaListTool(runtime: AgentRuntime, manager: ArtifactManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: {
      name: "media.list",
      title: "List media artifacts",
      description: "List verified artifacts and encrypted provenance records.",
      category: "media",
      riskLevel: "sensitive",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["media", "artifact", "provenance"],
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => ({ artifacts: manager.list() }),
  });
  runtime.allowTool(sessionId, "media.list");
}

function registerMediaInspectTool(runtime: AgentRuntime, manager: ArtifactManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: {
      name: "media.inspect",
      title: "Inspect media artifact",
      description:
        "Re-read an artifact, verify containment, sniff its bytes, dimensions, and SHA-256.",
      category: "media",
      riskLevel: "sensitive",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["media", "artifact", "qc"],
    },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (_context, input) => ({
      artifact: manager.inspect(String(input.path)),
    }),
  });
  runtime.allowTool(sessionId, "media.inspect");
}

function registerMediaGenerateTool(runtime: AgentRuntime, manager: ArtifactManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: {
      name: "media.generate",
      title: "Generate media artifact",
      description:
        "Generate a bounded artifact through an explicitly configured provider and verify the downloaded bytes before registration.",
      category: "media",
      riskLevel: "sensitive",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["image", "audio", "video", "document", "artifact"],
    },
    inputSchema: {
      type: "object",
      properties: {
        providerId: { type: "string" },
        prompt: { type: "string" },
        kind: { enum: ["image", "audio", "music", "video", "document"] },
        model: { type: "string" },
        filename: { type: "string" },
        maximumBytes: { type: "integer" },
      },
      required: ["providerId", "prompt", "kind"],
    },
    execute: async ({ signal }, input) => ({
      ...(await manager.generate(
        {
          providerId: String(input.providerId),
          prompt: String(input.prompt),
          kind: String(input.kind) as
            | "image"
            | "audio"
            | "music"
            | "video"
            | "document",
          ...(typeof input.model === "string" ? { model: input.model } : {}),
          ...(typeof input.filename === "string"
            ? { filename: input.filename }
            : {}),
          ...(typeof input.maximumBytes === "number"
            ? { maximumBytes: input.maximumBytes }
            : {}),
        },
        signal,
      )),
    }),
  });
  runtime.allowTool(sessionId, "media.generate");
}

function registerMusicGenerateTool(runtime: AgentRuntime, manager: ArtifactManager, sessionId: string): void {
  if (!manager.musicProviders().length) return;

  runtime.registerExternalTool({
    descriptor: {
      name: "music_generate",
      title: "Generate music",
      description:
        "List configured music providers or generate a verified music artifact. Generation is a paid external action and requires approval.",
      category: "media",
      riskLevel: "sensitive",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["music", "audio", "artifact", "generation"],
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["list", "generate"] },
        providerId: { type: "string" },
        prompt: { type: "string", minLength: 10, maxLength: 2_000 },
        lyrics: { type: "string", maxLength: 3_500 },
        instrumental: { type: "boolean" },
        format: { enum: ["mp3", "wav"] },
        filename: { type: "string", maxLength: 120 },
      },
      additionalProperties: false,
    },
    execute: async ({ signal }, input) => {
      if (input.action === "list")
        return { providers: manager.musicProviders(), paid: true };
      const providerId =
        typeof input.providerId === "string"
          ? input.providerId
          : manager.musicProviders()[0]?.id;
      if (!providerId)
        throw new Error("No music-generation provider is configured.");
      if (typeof input.prompt !== "string")
        throw new Error("Music generation requires a prompt.");
      return {
        artifact: await manager.generate(
          {
            providerId,
            prompt: input.prompt,
            kind: "music",
            ...(typeof input.lyrics === "string"
              ? { lyrics: input.lyrics }
              : {}),
            ...(typeof input.instrumental === "boolean"
              ? { instrumental: input.instrumental }
              : {}),
            ...(input.format === "mp3" || input.format === "wav"
              ? { format: input.format }
              : {}),
            ...(typeof input.filename === "string"
              ? { filename: input.filename }
              : {}),
          },
          signal,
        ),
      };
    },
  });
  runtime.allowTool(sessionId, "music_generate");
}

function registerShowWidgetTool(runtime: AgentRuntime, manager: ArtifactManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: {
      name: "show_widget",
      title: "Show interactive widget",
      description:
        "Store a bounded self-contained HTML or SVG widget for opaque-origin, no-network rendering in the native Artifacts surface.",
      category: "media",
      riskLevel: "sensitive",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["widget", "interactive", "html", "artifact"],
    },
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 80 },
        widget_code: { type: "string", minLength: 1, maxLength: 262144 },
        filename: { type: "string", maxLength: 120 },
      },
      required: ["title", "widget_code"],
      additionalProperties: false,
    },
    execute: async ({ session }, input) => ({
      artifact: manager.createWidget({
        title: String(input.title),
        code: String(input.widget_code),
        sessionId: session.id,
        ...(typeof input.filename === "string"
          ? { filename: input.filename }
          : {}),
      }),
      sandbox: {
        opaqueOrigin: true,
        scripts: true,
        network: false,
        parentAccess: false,
      },
    }),
  });
  runtime.allowTool(sessionId, "show_widget");
}

export function installMediaTools(
  runtime: AgentRuntime,
  manager: ArtifactManager,
  sessionId: string,
): void {
  registerMediaListTool(runtime, manager, sessionId);
  registerMediaInspectTool(runtime, manager, sessionId);
  registerMediaGenerateTool(runtime, manager, sessionId);
  registerMusicGenerateTool(runtime, manager, sessionId);
  registerShowWidgetTool(runtime, manager, sessionId);
}
