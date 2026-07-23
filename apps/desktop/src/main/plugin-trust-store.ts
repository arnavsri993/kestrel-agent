import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PluginTrustKey } from "@kestrel/agent-core";

export interface TrustedPluginPublisher {
  keyId: string;
  fingerprint: string;
}

interface StoredPublisher extends TrustedPluginPublisher {
  publicKey: string;
}

function parsePublisher(value: unknown): StoredPublisher {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin publisher key document is invalid.");
  const record = value as Record<string, unknown>;
  if (typeof record.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.keyId) || typeof record.publicKey !== "string" || record.publicKey.length > 32_000) throw new Error("Plugin publisher key document is invalid.");
  const key = createPublicKey(record.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Plugin publisher key must be Ed25519.");
  const publicKey = key.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  return { keyId: record.keyId, publicKey, fingerprint };
}

export class PluginTrustStore {
  constructor(private readonly path: string) {}

  private async stored(): Promise<StoredPublisher[]> {
    let bytes: Buffer;
    try { bytes = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (bytes.byteLength > 1_000_000) throw new Error("Plugin publisher trust store exceeds 1 MB.");
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Plugin publisher trust store is invalid.");
    const publishers = parsed.map(parsePublisher);
    if (new Set(publishers.map((publisher) => publisher.keyId)).size !== publishers.length) throw new Error("Plugin publisher trust store contains duplicate key IDs.");
    return publishers;
  }

  private async save(publishers: StoredPublisher[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(publishers, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async list(): Promise<TrustedPluginPublisher[]> {
    return (await this.stored()).map(({ keyId, fingerprint }) => ({ keyId, fingerprint }));
  }

  async trustKeys(): Promise<PluginTrustKey[]> {
    return (await this.stored()).map(({ keyId, publicKey }) => ({ keyId, publicKey }));
  }

  async importDocument(path: string): Promise<TrustedPluginPublisher> {
    const bytes = await readFile(path);
    if (bytes.byteLength > 64_000) throw new Error("Plugin publisher key document exceeds 64 KB.");
    const publisher = parsePublisher(JSON.parse(bytes.toString("utf8")) as unknown);
    const publishers = await this.stored();
    const existing = publishers.find((item) => item.keyId === publisher.keyId);
    if (existing && existing.fingerprint !== publisher.fingerprint) throw new Error(`Publisher key ID ${publisher.keyId} is already trusted with a different key.`);
    if (!existing) await this.save([...publishers, publisher].sort((left, right) => left.keyId.localeCompare(right.keyId)));
    return { keyId: publisher.keyId, fingerprint: publisher.fingerprint };
  }

  async remove(keyId: string): Promise<void> {
    const publishers = await this.stored();
    if (!publishers.some((publisher) => publisher.keyId === keyId)) throw new Error(`Plugin publisher key ${keyId} is not trusted.`);
    await this.save(publishers.filter((publisher) => publisher.keyId !== keyId));
  }
}
