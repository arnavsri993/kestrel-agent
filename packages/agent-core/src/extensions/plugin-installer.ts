import { createHash, createPublicKey, KeyObject, randomUUID, verify } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PluginRegistry } from "./plugins";
import { SkillRegistry } from "./skills";

const signatureRelativePath = ".codex-plugin/signature.json";
const manifestRelativePath = ".codex-plugin/plugin.json";

export interface PluginTrustKey {
  keyId: string;
  publicKey: string | Buffer | KeyObject;
}

export interface VerifiedPluginBundle {
  name: string;
  version: string;
  description: string;
  sourceRoot: string;
  digest: string;
  keyId: string;
  fileCount: number;
  totalBytes: number;
}

export interface PluginBundleDigest {
  digest: string;
  fileCount: number;
  totalBytes: number;
}

export interface InstalledPlugin extends VerifiedPluginBundle {
  installedRoot: string;
  replacedVersion?: string;
}

export interface RemovedPlugin {
  name: string;
  version: string;
  recoveryPath: string;
}

export interface PluginInstallerOptions {
  managedRoot: string;
  trustKeys: PluginTrustKey[];
  maximumFiles?: number;
  maximumTotalBytes?: number;
  maximumFileBytes?: number;
}

interface BundleFile {
  absolutePath: string;
  relativePath: string;
  bytes: number;
  executable: boolean;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function validatePluginName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Plugin name is invalid.");
}

function lengthPrefix(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function normalizedRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) throw new Error("Plugin bundle path escapes its root.");
  return value.normalize("NFC");
}

export class PluginInstaller {
  private readonly managedRoot: string;
  private readonly trustKeys = new Map<string, KeyObject>();
  private readonly maximumFiles: number;
  private readonly maximumTotalBytes: number;
  private readonly maximumFileBytes: number;

  constructor(options: PluginInstallerOptions) {
    this.managedRoot = resolve(options.managedRoot);
    this.maximumFiles = options.maximumFiles ?? 10_000;
    this.maximumTotalBytes = options.maximumTotalBytes ?? 100 * 1024 * 1024;
    this.maximumFileBytes = options.maximumFileBytes ?? 20 * 1024 * 1024;
    for (const trustKey of options.trustKeys) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trustKey.keyId) || this.trustKeys.has(trustKey.keyId)) throw new Error("Plugin trust key ID is invalid or duplicated.");
      const publicKey = trustKey.publicKey instanceof KeyObject ? trustKey.publicKey : createPublicKey(trustKey.publicKey);
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`Plugin trust key ${trustKey.keyId} is not Ed25519.`);
      this.trustKeys.set(trustKey.keyId, publicKey);
    }
  }

  private walk(sourceRoot: string): BundleFile[] {
    const files: BundleFile[] = [];
    const normalizedPaths = new Set<string>();
    const pending = [sourceRoot];
    let totalBytes = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) throw new Error(`Plugin bundles cannot contain symbolic links: ${normalizedRelativePath(sourceRoot, path)}`);
        if (metadata.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!metadata.isFile()) throw new Error(`Plugin bundles cannot contain special files: ${normalizedRelativePath(sourceRoot, path)}`);
        if (metadata.size > this.maximumFileBytes) throw new Error(`Plugin file exceeds the per-file size limit: ${normalizedRelativePath(sourceRoot, path)}`);
        totalBytes += metadata.size;
        if (totalBytes > this.maximumTotalBytes) throw new Error("Plugin bundle exceeds the total size limit.");
        const relativePath = normalizedRelativePath(sourceRoot, path);
        if (normalizedPaths.has(relativePath)) throw new Error(`Plugin bundle contains colliding normalized paths: ${relativePath}`);
        normalizedPaths.add(relativePath);
        files.push({ absolutePath: path, relativePath, bytes: metadata.size, executable: (metadata.mode & 0o111) !== 0 });
        if (files.length > this.maximumFiles) throw new Error("Plugin bundle exceeds the file count limit.");
      }
    }
    return files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  }

  private digest(files: BundleFile[]): string {
    const hash = createHash("sha256");
    hash.update("kestrel-plugin-bundle-v1\0");
    for (const file of files) {
      if (file.relativePath === signatureRelativePath) continue;
      const pathBytes = Buffer.from(file.relativePath, "utf8");
      const contents = readFileSync(file.absolutePath);
      hash.update(lengthPrefix(pathBytes.byteLength));
      hash.update(pathBytes);
      hash.update(lengthPrefix(contents.byteLength));
      hash.update(contents);
    }
    return hash.digest("hex");
  }

  digestForSigning(source: string): PluginBundleDigest {
    const sourceRoot = realpathSync(resolve(source));
    if (!statSync(sourceRoot).isDirectory()) throw new Error("Plugin source must be a directory.");
    const files = this.walk(sourceRoot);
    if (!files.some((file) => file.relativePath === manifestRelativePath)) throw new Error("Plugin bundle is missing .codex-plugin/plugin.json.");
    return {
      digest: this.digest(files),
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0)
    };
  }

  inspect(source: string): VerifiedPluginBundle {
    const sourceRoot = realpathSync(resolve(source));
    if (!statSync(sourceRoot).isDirectory()) throw new Error("Plugin source must be a directory.");
    const files = this.walk(sourceRoot);
    const manifestFile = files.find((file) => file.relativePath === manifestRelativePath);
    const signatureFile = files.find((file) => file.relativePath === signatureRelativePath);
    if (!manifestFile) throw new Error("Plugin bundle is missing .codex-plugin/plugin.json.");
    if (!signatureFile || signatureFile.bytes > 64_000) throw new Error("Plugin bundle is missing a bounded signature file.");
    const manifest = JSON.parse(readFileSync(manifestFile.absolutePath, "utf8")) as Record<string, unknown>;
    const name = typeof manifest.name === "string" ? manifest.name : "";
    const version = typeof manifest.version === "string" ? manifest.version : "";
    const description = typeof manifest.description === "string" ? manifest.description : "";
    validatePluginName(name);
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(version)) throw new Error("Plugin version is invalid.");
    if (!description || description.length > 2_000) throw new Error("Plugin description is invalid.");
    const signature = JSON.parse(readFileSync(signatureFile.absolutePath, "utf8")) as Record<string, unknown>;
    if (signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.digest !== "string" || typeof signature.signature !== "string") throw new Error("Plugin signature metadata is invalid.");
    const publicKey = this.trustKeys.get(signature.keyId);
    if (!publicKey) throw new Error(`Plugin signature key ${signature.keyId} is not trusted.`);
    const digest = this.digest(files);
    if (!/^[a-f0-9]{64}$/.test(signature.digest) || signature.digest !== digest) throw new Error("Plugin bundle digest does not match its signature metadata.");
    const signatureBytes = Buffer.from(signature.signature, "base64");
    if (signatureBytes.byteLength !== 64 || !verify(null, Buffer.from(digest, "hex"), publicKey, signatureBytes)) throw new Error("Plugin bundle signature verification failed.");
    const discovered = new PluginRegistry([sourceRoot]).discover();
    if (discovered.length !== 1 || discovered[0]?.root !== sourceRoot || discovered[0].name !== name || discovered[0].version !== version) throw new Error("Plugin bundle does not resolve to exactly one valid root manifest.");
    if (discovered[0].skillsRoot) new SkillRegistry([discovered[0].skillsRoot]).discover();
    return { name, version, description, sourceRoot, digest, keyId: signature.keyId, fileCount: files.length, totalBytes: files.reduce((total, file) => total + file.bytes, 0) };
  }

  private destination(name: string): string {
    validatePluginName(name);
    return join(this.managedRoot, name);
  }

  private copyVerified(sourceRoot: string, stagingRoot: string): void {
    const files = this.walk(sourceRoot);
    mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
    for (const file of files) {
      const destination = join(stagingRoot, ...file.relativePath.split("/"));
      if (!within(stagingRoot, destination)) throw new Error("Plugin staging path escaped its root.");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(file.absolutePath, destination);
      chmodSync(destination, file.executable ? 0o755 : 0o644);
    }
  }

  private stage(bundle: VerifiedPluginBundle): string {
    mkdirSync(this.managedRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = join(this.managedRoot, `.staging-${bundle.name}-${randomUUID()}`);
    try {
      this.copyVerified(bundle.sourceRoot, stagingRoot);
      const staged = this.inspect(stagingRoot);
      if (staged.digest !== bundle.digest || staged.name !== bundle.name || staged.version !== bundle.version) throw new Error("Staged plugin verification changed unexpectedly.");
      return stagingRoot;
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  install(source: string): InstalledPlugin {
    const bundle = this.inspect(source);
    const destination = this.destination(bundle.name);
    if (existsSync(destination)) throw new Error(`Plugin ${bundle.name} is already installed; use update instead.`);
    const stagingRoot = this.stage(bundle);
    try {
      renameSync(stagingRoot, destination);
      return { ...bundle, installedRoot: destination };
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  update(source: string): InstalledPlugin {
    const bundle = this.inspect(source);
    const destination = this.destination(bundle.name);
    if (!existsSync(destination)) return this.install(source);
    const current = this.inspect(destination);
    const stagingRoot = this.stage(bundle);
    const trashRoot = join(this.managedRoot, ".trash");
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const backup = join(trashRoot, `${bundle.name}-${current.version}-${randomUUID()}`);
    renameSync(destination, backup);
    try {
      renameSync(stagingRoot, destination);
      return { ...bundle, installedRoot: destination, replacedVersion: current.version };
    } catch (error) {
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      renameSync(backup, destination);
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  remove(name: string): RemovedPlugin {
    const destination = this.destination(name);
    if (!existsSync(destination)) throw new Error(`Plugin ${name} is not installed.`);
    const current = this.inspect(destination);
    const trashRoot = join(this.managedRoot, ".trash");
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const recoveryPath = join(trashRoot, `${current.name}-${current.version}-${randomUUID()}`);
    renameSync(destination, recoveryPath);
    return { name: current.name, version: current.version, recoveryPath };
  }

  restore(recoveryPath: string): InstalledPlugin {
    const trashRoot = join(this.managedRoot, ".trash");
    const canonicalTrashRoot = realpathSync(trashRoot);
    const source = realpathSync(resolve(recoveryPath));
    if (!within(canonicalTrashRoot, source) || dirname(source) !== canonicalTrashRoot) throw new Error("Plugin recovery path is outside the managed trash directory.");
    const bundle = this.inspect(source);
    const destination = this.destination(bundle.name);
    if (existsSync(destination)) throw new Error(`Plugin ${bundle.name} is already installed.`);
    renameSync(source, destination);
    return { ...bundle, installedRoot: destination };
  }
}

export const PLUGIN_SIGNATURE_PATH = signatureRelativePath;
