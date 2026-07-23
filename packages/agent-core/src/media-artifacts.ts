import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
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
  generate(input: { prompt: string; kind: "image" | "audio" | "video" | "document"; model?: string; signal: AbortSignal }): Promise<GeneratedMedia>;
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
  createdAt: string;
}

function within(root: string, path: string): boolean { return path === root || path.startsWith(`${root}${sep}`); }

function extension(mediaType: string): string {
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "video/mp4": ".mp4", "application/pdf": ".pdf", "text/markdown": ".md", "text/plain": ".txt" } as Record<string, string>)[mediaType] ?? ".bin";
}

function sniff(data: Uint8Array): { mediaType: string; width?: number; height?: number } {
  if (data.byteLength >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { mediaType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) return { mediaType: "image/jpeg" };
  if (new TextDecoder().decode(data.slice(0, 5)) === "%PDF-") return { mediaType: "application/pdf" };
  return { mediaType: "application/octet-stream" };
}

export class ArtifactManager {
  private readonly root: string;
  private readonly providers = new Map<string, MediaGenerationProvider>();
  private readonly stateKey = "media.artifacts";

  constructor(private readonly database: KestrelDatabase, artifactRoot: string, providers: MediaGenerationProvider[] = [], private readonly now: () => Date = () => new Date()) {
    mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    this.root = realpathSync(artifactRoot);
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`Duplicate media provider ${provider.id}.`);
      this.providers.set(provider.id, provider);
    }
  }

  list(): ArtifactRecord[] { return this.database.getPrivateState<ArtifactRecord[]>(this.stateKey) ?? []; }

  preview(id: string, maximumBytes = 5_000_000): { id: string; mediaType: string; dataBase64: string; truncated: boolean } {
    const artifact = this.list().find((item) => item.id === id);
    if (!artifact) throw new Error("Artifact was not found.");
    const path = realpathSync(artifact.path);
    if (!within(this.root, path) || !statSync(path).isFile()) throw new Error("Artifact preview path escapes the artifact root.");
    const data = readFileSync(path);
    const limit = Math.max(1, Math.min(10_000_000, maximumBytes));
    return { id, mediaType: artifact.mediaType, dataBase64: data.subarray(0, limit).toString("base64"), truncated: data.byteLength > limit };
  }

  inspect(path: string): ArtifactRecord {
    const candidate = realpathSync(resolve(this.root, path));
    if (!within(this.root, candidate) || !statSync(candidate).isFile()) throw new Error("Artifact path escapes the artifact root.");
    const data = readFileSync(candidate);
    const detected = sniff(data);
    return {
      id: "inspection", filename: basename(candidate), path: candidate, mediaType: detected.mediaType, bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"), ...(detected.width ? { width: detected.width } : {}), ...(detected.height ? { height: detected.height } : {}), createdAt: this.now().toISOString()
    };
  }

  async generate(input: { providerId: string; prompt: string; kind: "image" | "audio" | "video" | "document"; model?: string; filename?: string; maximumBytes?: number }, signal: AbortSignal): Promise<ArtifactRecord> {
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new Error(`Media provider ${input.providerId} is not configured.`);
    const generated = await provider.generate({ prompt: input.prompt, kind: input.kind, ...(input.model ? { model: input.model } : {}), signal });
    const maximum = input.maximumBytes ?? 100_000_000;
    if (generated.data.byteLength === 0 || generated.data.byteLength > maximum) throw new Error("Generated artifact violates the byte limit.");
    const detected = sniff(generated.data);
    if (detected.mediaType !== "application/octet-stream" && detected.mediaType !== generated.mediaType) throw new Error("Generated artifact media type does not match its bytes.");
    const requested = (input.filename ?? `${input.kind}-${randomUUID()}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
    const filename = extname(requested) ? requested : `${requested}${extension(generated.mediaType)}`;
    const destination = resolve(this.root, filename);
    if (!within(this.root, destination)) throw new Error("Generated artifact path escapes the artifact root.");
    if (existsSync(destination)) throw new Error("Generated artifact filename already exists.");
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    writeFileSync(temporary, generated.data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
    const record: ArtifactRecord = {
      id: `artifact-${randomUUID()}`, filename, path: destination, mediaType: generated.mediaType, bytes: generated.data.byteLength,
      sha256: createHash("sha256").update(generated.data).digest("hex"), ...(detected.width ? { width: detected.width } : {}), ...(detected.height ? { height: detected.height } : {}),
      providerId: provider.id, model: generated.model, ...(generated.providerRequestId ? { providerRequestId: generated.providerRequestId } : {}),
      ...(generated.estimatedCostUsd !== undefined ? { estimatedCostUsd: generated.estimatedCostUsd } : {}), createdAt: this.now().toISOString()
    };
    this.database.setPrivateState(this.stateKey, [...this.list(), record]);
    return record;
  }
}

export function installMediaTools(runtime: AgentRuntime, manager: ArtifactManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: { name: "media.list", title: "List media artifacts", description: "List verified artifacts and encrypted provenance records.", category: "media", riskLevel: "sensitive", readOnly: true, requiresWorkspace: false, source: "builtin", tags: ["media", "artifact", "provenance"] },
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ artifacts: manager.list() })
  });
  runtime.registerExternalTool({
    descriptor: { name: "media.inspect", title: "Inspect media artifact", description: "Re-read an artifact, verify containment, sniff its bytes, dimensions, and SHA-256.", category: "media", riskLevel: "sensitive", readOnly: true, requiresWorkspace: false, source: "builtin", tags: ["media", "artifact", "qc"] },
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 500 } }, required: ["path"], additionalProperties: false }, execute: async (_context, input) => ({ artifact: manager.inspect(String(input.path)) })
  });
  runtime.registerExternalTool({
    descriptor: { name: "media.generate", title: "Generate media artifact", description: "Generate a bounded artifact through an explicitly configured provider and verify the downloaded bytes before registration.", category: "media", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["image", "audio", "video", "document", "artifact"] },
    inputSchema: { type: "object", properties: { providerId: { type: "string" }, prompt: { type: "string" }, kind: { enum: ["image", "audio", "video", "document"] }, model: { type: "string" }, filename: { type: "string" }, maximumBytes: { type: "integer" } }, required: ["providerId", "prompt", "kind"] },
    execute: async ({ signal }, input) => ({ ...await manager.generate({ providerId: String(input.providerId), prompt: String(input.prompt), kind: String(input.kind) as "image" | "audio" | "video" | "document", ...(typeof input.model === "string" ? { model: input.model } : {}), ...(typeof input.filename === "string" ? { filename: input.filename } : {}), ...(typeof input.maximumBytes === "number" ? { maximumBytes: input.maximumBytes } : {}) }, signal) })
  });
  runtime.allowTool(sessionId, "media.generate");
  runtime.allowTool(sessionId, "media.list");
  runtime.allowTool(sessionId, "media.inspect");
}
