import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
	type InstalledExtension,
	InstalledExtensionSchema,
} from "@kestrel/shared-types";
import type { Session } from "electron";

const CHROME_WEB_STORE_ID_REGEX = /([a-p]{32})/i;

/**
 * Extract ZIP archive contents from a buffer into a destination directory.
 * Handles both standard ZIP files and CRX files (CRX2, CRX3).
 */
export function extractCrxOrZip(buffer: Buffer, destinationDir: string): void {
	let zipBuffer = buffer;

	// Check if this is a CRX file (magic "Cr24")
	if (buffer.length > 16 && buffer.toString("utf8", 0, 4) === "Cr24") {
		const version = buffer.readUInt32LE(4);
		if (version === 2) {
			const pubKeyLen = buffer.readUInt32LE(8);
			const sigLen = buffer.readUInt32LE(12);
			const zipOffset = 16 + pubKeyLen + sigLen;
			if (zipOffset > buffer.length) {
				throw new Error("Invalid CRX2 header format.");
			}
			zipBuffer = buffer.subarray(zipOffset);
		} else if (version === 3) {
			const headerLen = buffer.readUInt32LE(8);
			const zipOffset = 12 + headerLen;
			if (zipOffset > buffer.length) {
				throw new Error("Invalid CRX3 header format.");
			}
			zipBuffer = buffer.subarray(zipOffset);
		}
	}

	unzipBuffer(zipBuffer, destinationDir);
}

/**
 * Robust pure Node.js ZIP extractor using Central Directory.
 */
function unzipBuffer(zip: Buffer, targetDir: string): void {
	// Find End of Central Directory Record (EOCD signature: 0x06054b50)
	let eocdOffset = -1;
	for (let i = zip.length - 22; i >= 0; i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			eocdOffset = i;
			break;
		}
	}

	if (eocdOffset === -1) {
		// Fallback to sequential local file header scan if EOCD not found
		extractLocalHeadersSequentially(zip, targetDir);
		return;
	}

	const totalEntries = zip.readUInt16LE(eocdOffset + 10);
	const cdOffset = zip.readUInt32LE(eocdOffset + 16);

	let currentCdOffset = cdOffset;
	for (let entry = 0; entry < totalEntries && currentCdOffset < eocdOffset; entry++) {
		if (zip.readUInt32LE(currentCdOffset) !== 0x02014b50) {
			break;
		}

		const compression = zip.readUInt16LE(currentCdOffset + 10);
		const compressedSize = zip.readUInt32LE(currentCdOffset + 20);
		const uncompressedSize = zip.readUInt32LE(currentCdOffset + 24);
		const filenameLen = zip.readUInt16LE(currentCdOffset + 28);
		const extraLen = zip.readUInt16LE(currentCdOffset + 30);
		const commentLen = zip.readUInt16LE(currentCdOffset + 32);
		const localHeaderOffset = zip.readUInt32LE(currentCdOffset + 42);

		const filename = zip.toString(
			"utf8",
			currentCdOffset + 46,
			currentCdOffset + 46 + filenameLen,
		);
		currentCdOffset += 46 + filenameLen + extraLen + commentLen;

		// Security: prevent zip slip path traversal
		const normalized = filename.replace(/\\/g, "/");
		if (normalized.includes("..") || normalized.startsWith("/")) {
			continue;
		}

		const isDirectory = normalized.endsWith("/");
		const outPath = join(targetDir, normalized);

		if (isDirectory) {
			mkdirSync(outPath, { recursive: true });
			continue;
		}

		mkdirSync(dirname(outPath), { recursive: true });

		// Read local header to find exact data start
		if (localHeaderOffset + 30 > zip.length) continue;
		const localFnLen = zip.readUInt16LE(localHeaderOffset + 26);
		const localExtraLen = zip.readUInt16LE(localHeaderOffset + 28);
		const dataStart = localHeaderOffset + 30 + localFnLen + localExtraLen;
		const dataEnd = dataStart + compressedSize;

		if (dataEnd > zip.length) continue;

		const compressedData = zip.subarray(dataStart, dataEnd);
		let fileData: Buffer;

		if (compression === 0) {
			fileData = Buffer.from(compressedData);
		} else if (compression === 8) {
			try {
				fileData = inflateRawSync(compressedData);
			} catch {
				continue;
			}
		} else {
			continue;
		}

		writeFileSync(outPath, fileData);
	}
}

function extractLocalHeadersSequentially(zip: Buffer, targetDir: string): void {
	let offset = 0;
	while (offset + 30 < zip.length) {
		if (zip.readUInt32LE(offset) !== 0x04034b50) {
			break;
		}
		const compression = zip.readUInt16LE(offset + 8);
		const compressedSize = zip.readUInt32LE(offset + 18);
		const filenameLen = zip.readUInt16LE(offset + 26);
		const extraLen = zip.readUInt16LE(offset + 28);
		const filename = zip.toString(
			"utf8",
			offset + 30,
			offset + 30 + filenameLen,
		);
		const dataStart = offset + 30 + filenameLen + extraLen;
		const dataEnd = dataStart + compressedSize;

		offset = dataEnd;

		const normalized = filename.replace(/\\/g, "/");
		if (normalized.includes("..") || normalized.startsWith("/")) continue;

		const outPath = join(targetDir, normalized);
		if (normalized.endsWith("/")) {
			mkdirSync(outPath, { recursive: true });
			continue;
		}

		mkdirSync(dirname(outPath), { recursive: true });
		if (dataEnd > zip.length) break;

		const compressedData = zip.subarray(dataStart, dataEnd);
		let fileData: Buffer;
		if (compression === 0) {
			fileData = Buffer.from(compressedData);
		} else if (compression === 8) {
			try {
				fileData = inflateRawSync(compressedData);
			} catch {
				continue;
			}
		} else {
			continue;
		}
		writeFileSync(outPath, fileData);
	}
}

export function parseExtensionIdFromUrlOrId(input: string): string | null {
	const trimmed = input.trim();
	const match = trimmed.match(CHROME_WEB_STORE_ID_REGEX);
	if (match && match[1]) {
		return match[1].toLowerCase();
	}
	return null;
}

export function readExtensionManifest(extensionDir: string): {
	name: string;
	version: string;
	description?: string;
	homepageUrl?: string;
} {
	const manifestPath = join(extensionDir, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error("Missing manifest.json in extension directory.");
	}
	try {
		const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
		return {
			name: typeof raw.name === "string" ? raw.name : "Extension",
			version: typeof raw.version === "string" ? raw.version : "1.0.0",
			description:
				typeof raw.description === "string" ? raw.description : undefined,
			homepageUrl:
				typeof raw.homepage_url === "string" ? raw.homepage_url : undefined,
		};
	} catch {
		throw new Error("Unable to parse extension manifest.json.");
	}
}

export class BrowserExtensionManager {
	private readonly extensionsDir: string;
	private readonly metadataPath: string;
	private extensions: Map<string, InstalledExtension> = new Map();

	constructor(baseStorageDir: string) {
		this.extensionsDir = join(baseStorageDir, "browser-extensions");
		this.metadataPath = join(this.extensionsDir, "extensions.json");
		mkdirSync(this.extensionsDir, { recursive: true, mode: 0o700 });
		this.loadRegistry();
	}

	private loadRegistry(): void {
		if (!existsSync(this.metadataPath)) return;
		try {
			const data = JSON.parse(readFileSync(this.metadataPath, "utf8"));
			if (Array.isArray(data)) {
				for (const item of data) {
					const parsed = InstalledExtensionSchema.safeParse(item);
					if (parsed.success && existsSync(parsed.data.path)) {
						this.extensions.set(parsed.data.id, parsed.data);
					}
				}
			}
		} catch {
			this.extensions.clear();
		}
	}

	private saveRegistry(): void {
		const list = Array.from(this.extensions.values());
		writeFileSync(this.metadataPath, JSON.stringify(list, null, 2), "utf8");
	}

	async loadAll(session: Session): Promise<void> {
		for (const extension of this.extensions.values()) {
			if (extension.enabled && existsSync(extension.path)) {
				try {
					await session.loadExtension(extension.path, {
						allowFileAccess: true,
					});
				} catch (err) {
					console.warn(
						`[Extension] Failed to load extension ${extension.name}:`,
						err,
					);
				}
			}
		}
	}

	list(): InstalledExtension[] {
		return Array.from(this.extensions.values());
	}

	async installFromChromeWebStore(
		urlOrId: string,
		session?: Session,
	): Promise<InstalledExtension> {
		const id = parseExtensionIdFromUrlOrId(urlOrId);
		if (!id) {
			throw new Error(
				"Invalid Chrome Web Store URL or extension ID. Must be a 32-character ID.",
			);
		}

		// Download CRX from Google CRX endpoint
		const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=128.0.6613.120&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
		const response = await fetch(crxUrl);
		if (!response.ok) {
			throw new Error(
				`Failed to download extension from Chrome Web Store (HTTP ${response.status}).`,
			);
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		const targetDir = join(this.extensionsDir, id);
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });

		extractCrxOrZip(buffer, targetDir);

		const manifest = readExtensionManifest(targetDir);

		const record: InstalledExtension = {
			id,
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			homepageUrl: manifest.homepageUrl,
			enabled: true,
			source: "chrome_web_store",
			path: targetDir,
			installedAt: new Date().toISOString(),
		};

		if (session) {
			try {
				await session.loadExtension(targetDir, { allowFileAccess: true });
			} catch (err) {
				console.warn("[Extension] Warning during session load:", err);
			}
		}

		this.extensions.set(id, record);
		this.saveRegistry();
		return record;
	}

	async installFromUnpacked(
		folderPath: string,
		session?: Session,
	): Promise<InstalledExtension> {
		const resolvedPath = resolve(folderPath);
		if (!existsSync(resolvedPath)) {
			throw new Error("Extension directory does not exist.");
		}
		const manifest = readExtensionManifest(resolvedPath);
		const id = `ext-${randomUUID().slice(0, 8)}`;

		const record: InstalledExtension = {
			id,
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			homepageUrl: manifest.homepageUrl,
			enabled: true,
			source: "unpacked",
			path: resolvedPath,
			installedAt: new Date().toISOString(),
		};

		if (session) {
			await session.loadExtension(resolvedPath, { allowFileAccess: true });
		}

		this.extensions.set(id, record);
		this.saveRegistry();
		return record;
	}

	async installFromCrxOrZipFile(
		filePath: string,
		session?: Session,
	): Promise<InstalledExtension> {
		const resolvedPath = resolve(filePath);
		if (!existsSync(resolvedPath)) {
			throw new Error("Extension archive file does not exist.");
		}
		const buffer = readFileSync(resolvedPath);
		const id = `ext-${randomUUID().slice(0, 8)}`;
		const targetDir = join(this.extensionsDir, id);
		mkdirSync(targetDir, { recursive: true });

		extractCrxOrZip(buffer, targetDir);

		const manifest = readExtensionManifest(targetDir);
		const record: InstalledExtension = {
			id,
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			homepageUrl: manifest.homepageUrl,
			enabled: true,
			source: "file",
			path: targetDir,
			installedAt: new Date().toISOString(),
		};

		if (session) {
			await session.loadExtension(targetDir, { allowFileAccess: true });
		}

		this.extensions.set(id, record);
		this.saveRegistry();
		return record;
	}

	async toggle(
		id: string,
		enabled: boolean,
		session?: Session,
	): Promise<InstalledExtension> {
		const extension = this.extensions.get(id);
		if (!extension) throw new Error("Extension not found.");

		if (extension.enabled === enabled) return extension;

		if (session) {
			if (enabled) {
				await session.loadExtension(extension.path, { allowFileAccess: true });
			} else {
				session.removeExtension(id);
			}
		}

		extension.enabled = enabled;
		this.saveRegistry();
		return extension;
	}

	async uninstall(id: string, session?: Session): Promise<void> {
		const extension = this.extensions.get(id);
		if (!extension) return;

		if (session) {
			try {
				session.removeExtension(id);
			} catch {
				// Ignore error if extension wasn't active
			}
		}

		this.extensions.delete(id);
		this.saveRegistry();

		// If it's a managed directory in extensionsDir, clean up
		if (extension.path.startsWith(this.extensionsDir)) {
			try {
				rmSync(extension.path, { recursive: true, force: true });
			} catch {
				// Ignore file removal errors
			}
		}
	}
}
