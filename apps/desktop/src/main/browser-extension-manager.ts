import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	statSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
	type ChromeWebStoreExtensionInspection,
	type ExtensionCompatibilityReport,
	ExtensionCompatibilityReportSchema,
	type InstalledExtension,
	InstalledExtensionSchema,
	parseChromeWebStoreExtensionId,
} from "@kestrel/shared-types";
import { z } from "zod";
import {
	analyzeExtensionCompatibility,
	compatibilityWithRuntime,
	emptyRuntimeVerification,
	type ExtensionCompatibilityRuntimeBackend,
} from "./extension-compatibility";
import type { ExtensionRuntime } from "./extension-runtime";

const MAX_EXTENSION_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTENSION_FILES = 10_000;
const MAX_EXTENSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EXTENSION_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const EXTENSION_STARTUP_TIMEOUT_MS = 10_000;
const INSPECTION_TTL_MS = 5 * 60_000;

function checkedRangeEnd(start: number, length: number, available: number): number {
	const end = start + length;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(length) ||
		start < 0 ||
		length < 0 ||
		end < start ||
		end > available
	)
		throw new Error("Extension archive contains an invalid byte range.");
	return end;
}

function extensionArchivePath(
	targetDir: string,
	filename: string,
): { outputPath: string; canonicalName: string; directory: boolean } {
	if (!filename || filename.includes("\0"))
		throw new Error("Extension archive contains an invalid path.");
	const normalized = filename.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
		throw new Error("Extension archive contains an absolute path.");
	const directory = normalized.endsWith("/");
	const components = normalized.split("/").filter(Boolean);
	if (
		components.length === 0 ||
		components.some((component) => component === "." || component === "..")
	)
		throw new Error("Extension archive contains a path traversal.");
	const canonicalName = components.join("/");
	const outputPath = resolve(targetDir, ...components);
	const relativePath = relative(resolve(targetDir), outputPath);
	if (
		!relativePath ||
		isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	)
		throw new Error("Extension archive path escaped its destination.");
	return { outputPath, canonicalName, directory };
}

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
	if (zip.length > MAX_EXTENSION_ARCHIVE_BYTES)
		throw new Error("Extension archive exceeds the 128 MB safety limit.");
	if (zip.length < 22) throw new Error("Extension archive is not a valid ZIP file.");

	// ZIP comments are bounded to 65,535 bytes, so the EOCD must occur near the end.
	let eocdOffset = -1;
	const earliestEocd = Math.max(0, zip.length - 22 - MAX_ZIP_COMMENT_BYTES);
	for (let i = zip.length - 22; i >= earliestEocd; i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			const commentLength = zip.readUInt16LE(i + 20);
			if (i + 22 + commentLength === zip.length) {
				eocdOffset = i;
				break;
			}
		}
	}
	if (eocdOffset === -1)
		throw new Error("Extension archive is missing its ZIP directory.");

	const totalEntries = zip.readUInt16LE(eocdOffset + 10);
	if (totalEntries > MAX_EXTENSION_FILES)
		throw new Error("Extension archive contains too many files.");
	const cdOffset = zip.readUInt32LE(eocdOffset + 16);
	const cdSize = zip.readUInt32LE(eocdOffset + 12);
	if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff)
		throw new Error("ZIP64 extension archives are not supported.");
	if (checkedRangeEnd(cdOffset, cdSize, zip.length) > eocdOffset)
		throw new Error("Extension archive has an invalid ZIP directory.");

	const seenPaths = new Set<string>();
	let extractedBytes = 0;
	let currentCdOffset = cdOffset;
	for (let entry = 0; entry < totalEntries; entry++) {
		checkedRangeEnd(currentCdOffset, 46, eocdOffset);
		if (zip.readUInt32LE(currentCdOffset) !== 0x02014b50)
			throw new Error("Extension archive has an invalid central-directory entry.");

		const flags = zip.readUInt16LE(currentCdOffset + 8);
		const compression = zip.readUInt16LE(currentCdOffset + 10);
		const compressedSize = zip.readUInt32LE(currentCdOffset + 20);
		const uncompressedSize = zip.readUInt32LE(currentCdOffset + 24);
		const filenameLen = zip.readUInt16LE(currentCdOffset + 28);
		const extraLen = zip.readUInt16LE(currentCdOffset + 30);
		const commentLen = zip.readUInt16LE(currentCdOffset + 32);
		const localHeaderOffset = zip.readUInt32LE(currentCdOffset + 42);
		if ((flags & 0x1) !== 0)
			throw new Error("Encrypted extension archives are not supported.");
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
			throw new Error("ZIP64 extension archives are not supported.");
		if (uncompressedSize > MAX_EXTENSION_FILE_BYTES)
			throw new Error("Extension archive contains a file larger than 64 MB.");
		extractedBytes += uncompressedSize;
		if (extractedBytes > MAX_EXTENSION_EXTRACTED_BYTES)
			throw new Error("Extension archive expands beyond the 256 MB safety limit.");
		const centralEntryEnd = checkedRangeEnd(
			currentCdOffset,
			46 + filenameLen + extraLen + commentLen,
			eocdOffset,
		);
		const filename = zip.toString(
			"utf8",
			currentCdOffset + 46,
			currentCdOffset + 46 + filenameLen,
		);
		currentCdOffset = centralEntryEnd;

		const archivePath = extensionArchivePath(targetDir, filename);
		const pathKey = archivePath.canonicalName.toLocaleLowerCase("en-US");
		if (seenPaths.has(pathKey))
			throw new Error("Extension archive contains duplicate paths.");
		seenPaths.add(pathKey);

		// Read local header to find exact data start
		checkedRangeEnd(localHeaderOffset, 30, cdOffset);
		if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50)
			throw new Error("Extension archive has an invalid local file header.");
		const localFlags = zip.readUInt16LE(localHeaderOffset + 6);
		const localCompression = zip.readUInt16LE(localHeaderOffset + 8);
		const localFnLen = zip.readUInt16LE(localHeaderOffset + 26);
		const localExtraLen = zip.readUInt16LE(localHeaderOffset + 28);
		if ((localFlags & 0x1) !== 0 || localCompression !== compression)
			throw new Error("Extension archive file headers do not agree.");
		const localHeaderEnd = checkedRangeEnd(
			localHeaderOffset,
			30 + localFnLen + localExtraLen,
			cdOffset,
		);
		const localFilename = zip.toString(
			"utf8",
			localHeaderOffset + 30,
			localHeaderOffset + 30 + localFnLen,
		);
		if (localFilename !== filename)
			throw new Error("Extension archive file names do not agree.");
		const dataStart = localHeaderEnd;
		const dataEnd = dataStart + compressedSize;
		checkedRangeEnd(dataStart, compressedSize, cdOffset);

		const compressedData = zip.subarray(dataStart, dataEnd);
		let fileData: Buffer;

		if (compression === 0) {
			if (compressedSize !== uncompressedSize)
				throw new Error("Stored extension file size is invalid.");
			fileData = Buffer.from(compressedData);
		} else if (compression === 8) {
			try {
				fileData = inflateRawSync(compressedData, {
					maxOutputLength: Math.min(
						MAX_EXTENSION_FILE_BYTES,
						uncompressedSize + 1,
					),
				});
			} catch (cause) {
				throw new Error("Extension archive contains invalid compressed data.", {
					cause,
				});
			}
		} else {
			throw new Error("Extension archive uses an unsupported compression method.");
		}
		if (fileData.byteLength !== uncompressedSize)
			throw new Error("Extension archive file size did not match its directory.");
		if (archivePath.directory) {
			if (fileData.byteLength !== 0)
				throw new Error("Extension archive has an invalid directory entry.");
			mkdirSync(archivePath.outputPath, { recursive: true, mode: 0o700 });
			continue;
		}
		mkdirSync(dirname(archivePath.outputPath), { recursive: true, mode: 0o700 });
		writeFileSync(archivePath.outputPath, fileData, { mode: 0o600 });
	}
	if (currentCdOffset !== cdOffset + cdSize)
		throw new Error("Extension archive directory length did not match its entries.");
}

export function parseExtensionIdFromUrlOrId(input: string): string | null {
	return parseChromeWebStoreExtensionId(input);
}

const MANIFEST_MESSAGE_TOKEN = /__MSG_([A-Za-z0-9_@]+)__/g;

function localizedManifestValue(
	value: unknown,
	extensionDir: string,
	defaultLocale: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	if (!value.includes("__MSG_")) return value;
	if (
		typeof defaultLocale !== "string" ||
		!/^[A-Za-z0-9_-]{1,50}$/.test(defaultLocale)
	)
		return undefined;
	try {
		const messagesPath = join(
			extensionDir,
			"_locales",
			defaultLocale,
			"messages.json",
		);
		const messages: unknown = JSON.parse(readFileSync(messagesPath, "utf8"));
		if (!messages || typeof messages !== "object" || Array.isArray(messages))
			return undefined;
		let resolved = true;
		const rendered = value.replace(MANIFEST_MESSAGE_TOKEN, (_token, key: string) => {
			const message = (messages as Record<string, unknown>)[key];
			const text =
				message && typeof message === "object" && !Array.isArray(message)
					? (message as Record<string, unknown>).message
					: undefined;
			if (
				typeof text !== "string"
			) {
				resolved = false;
				return "";
			}
			return text;
		});
		return resolved ? rendered : undefined;
	} catch {
		return undefined;
	}
}

export function readExtensionManifest(
	extensionDir: string,
	fallbackName = "Extension",
): {
	name: string;
	version: string;
	description?: string;
	homepageUrl?: string;
	requiresServiceWorker: boolean;
} {
	const manifestPath = join(extensionDir, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error("Missing manifest.json in extension directory.");
	}
	try {
		const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error("Invalid extension manifest.");
		const manifest = raw as Record<string, unknown>;
		const description = localizedManifestValue(
			manifest.description,
			extensionDir,
			manifest.default_locale,
		);
		const homepageUrl = localizedManifestValue(
			manifest.homepage_url,
			extensionDir,
			manifest.default_locale,
		);
		const background =
			manifest.background &&
			typeof manifest.background === "object" &&
			!Array.isArray(manifest.background)
				? (manifest.background as Record<string, unknown>)
				: undefined;
		return {
			name:
				localizedManifestValue(manifest.name, extensionDir, manifest.default_locale) ??
				fallbackName,
			version:
				typeof manifest.version === "string" ? manifest.version : "1.0.0",
			...(description !== undefined ? { description } : {}),
			...(homepageUrl !== undefined ? { homepageUrl } : {}),
			requiresServiceWorker:
				typeof background?.service_worker === "string" &&
				background.service_worker.length > 0,
		};
	} catch (cause) {
		if (cause instanceof Error && cause.message === "Invalid extension manifest.")
			throw cause;
		throw new Error("Unable to parse extension manifest.json.");
	}
}

async function confirmServiceWorkerStartup(
	runtime: ExtensionRuntime,
	extensionId: string,
): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			runtime.startServiceWorker(extensionId),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() =>
						reject(
							new Error(
								"Kestrel could not start this extension's background service worker. The extension may rely on Chrome APIs that Kestrel does not support.",
							),
						),
					EXTENSION_STARTUP_TIMEOUT_MS,
				);
			}),
		]);
	} catch (cause) {
		throw new Error(
			"Kestrel could not start this extension's background service worker. The extension may rely on Chrome APIs that Kestrel does not support.",
			{ cause },
		);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

const CRX3_MAGIC = "Cr24";
const CRX3_SIGNATURE_PREFIX = Buffer.from("CRX3 SignedData\0", "utf8");

type CrxProof = { publicKey: Buffer; signature: Buffer };

export type VerifiedChromeWebStoreCrx = {
	archive: Buffer;
	publicKey: Buffer;
};

async function readBoundedExtensionResponse(response: Response): Promise<Buffer> {
	const declaredLength = response.headers?.get("content-length");
	if (declaredLength) {
		const parsedLength = Number.parseInt(declaredLength, 10);
		if (
			Number.isFinite(parsedLength) &&
			parsedLength > MAX_EXTENSION_ARCHIVE_BYTES
		)
			throw new Error("Chrome Web Store package exceeds the 128 MB safety limit.");
	}
	if (!response.body) {
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > MAX_EXTENSION_ARCHIVE_BYTES)
			throw new Error("Chrome Web Store package exceeds the 128 MB safety limit.");
		return buffer;
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let received = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = Buffer.from(next.value);
			received += chunk.byteLength;
			if (received > MAX_EXTENSION_ARCHIVE_BYTES) {
				await reader.cancel("Chrome Web Store package exceeded its safety limit.");
				throw new Error("Chrome Web Store package exceeds the 128 MB safety limit.");
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, received);
}

function readVarint(buffer: Buffer, start: number): { value: number; offset: number } {
	let value = 0;
	let shift = 0;
	let offset = start;
	while (offset < buffer.length && shift < 35) {
		const byte = buffer[offset++];
		if (byte === undefined) throw new Error("Invalid CRX3 protobuf data.");
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return { value, offset };
		shift += 7;
	}
	throw new Error("Invalid CRX3 protobuf data.");
}

function protobufBytes(buffer: Buffer, targetField: number): Buffer[] {
	const values: Buffer[] = [];
	let offset = 0;
	while (offset < buffer.length) {
		const key = readVarint(buffer, offset);
		offset = key.offset;
		const field = Math.floor(key.value / 8);
		const wireType = key.value % 8;
		if (wireType === 0) {
			offset = readVarint(buffer, offset).offset;
			continue;
		}
		if (wireType === 1) {
			offset += 8;
			continue;
		}
		if (wireType === 5) {
			offset += 4;
			continue;
		}
		if (wireType !== 2) throw new Error("Unsupported CRX3 protobuf field.");
		const length = readVarint(buffer, offset);
		offset = length.offset;
		const end = offset + length.value;
		if (!Number.isSafeInteger(end) || end > buffer.length)
			throw new Error("Invalid CRX3 protobuf length.");
		if (field === targetField) values.push(buffer.subarray(offset, end));
		offset = end;
	}
	return values;
}

function extensionIdFromBytes(bytes: Buffer): string {
	if (bytes.length !== 16) throw new Error("Invalid CRX3 extension identity.");
	return Array.from(bytes, (byte) =>
		byte
			.toString(16)
			.padStart(2, "0")
			.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))),
	).join("");
}

function extensionIdFromPublicKey(publicKey: Buffer): string {
	return extensionIdFromBytes(createHash("sha256").update(publicKey).digest().subarray(0, 16));
}

function crx3Proofs(header: Buffer): CrxProof[] {
	return [2, 3].flatMap((field) =>
		protobufBytes(header, field).flatMap((encodedProof) => {
			const publicKeys = protobufBytes(encodedProof, 1);
			const signatures = protobufBytes(encodedProof, 2);
			const publicKey = publicKeys[0];
			const signature = signatures[0];
			return publicKeys.length === 1 && signatures.length === 1 && publicKey && signature
				? [{ publicKey, signature }]
				: [];
		}),
	);
}

/**
 * Validate a Chrome Web Store CRX3 before extracting it. The extension ID is
 * derived from the signing public key, and the CRX signature covers the
 * signed-header identity plus archive. Plain ZIPs and older CRX variants do
 * not provide enough evidence for store installs and are rejected.
 */
export function validateChromeWebStoreCrx(
	buffer: Buffer,
	expectedExtensionId: string,
): VerifiedChromeWebStoreCrx {
	if (
		buffer.length < 12 ||
		buffer.toString("utf8", 0, 4) !== CRX3_MAGIC ||
		buffer.readUInt32LE(4) !== 3
	) {
		throw new Error("Chrome Web Store download was not a verifiable CRX3 package.");
	}
	const headerLength = buffer.readUInt32LE(8);
	const headerStart = 12;
	const headerEnd = headerStart + headerLength;
	if (!Number.isSafeInteger(headerEnd) || headerEnd >= buffer.length)
		throw new Error("Invalid CRX3 header format.");

	const header = buffer.subarray(headerStart, headerEnd);
	const archive = buffer.subarray(headerEnd);
	const signedHeaders = protobufBytes(header, 10_000);
	if (signedHeaders.length !== 1)
		throw new Error("CRX3 package is missing its signed identity.");
	const signedHeader = signedHeaders[0];
	if (!signedHeader) throw new Error("CRX3 package is missing its signed identity.");
	const crxIds = protobufBytes(signedHeader, 1);
	const crxId = crxIds[0];
	if (crxIds.length !== 1 || !crxId || extensionIdFromBytes(crxId) !== expectedExtensionId)
		throw new Error("Chrome Web Store download identity did not match the requested extension.");

	const signedHeaderLength = Buffer.alloc(4);
	signedHeaderLength.writeUInt32LE(signedHeader.length, 0);
	const signedData = Buffer.concat([
		CRX3_SIGNATURE_PREFIX,
		signedHeaderLength,
		signedHeader,
		archive,
	]);
	const verifiedProof = crx3Proofs(header).find((proof) => {
		try {
			return (
				extensionIdFromPublicKey(proof.publicKey) === expectedExtensionId &&
				verify(
					"sha256",
					signedData,
					createPublicKey({ key: proof.publicKey, format: "der", type: "spki" }),
					proof.signature,
				)
			);
		} catch {
			return false;
		}
	});
	if (!verifiedProof)
		throw new Error("Chrome Web Store package signature could not be verified.");
	return { archive, publicKey: Buffer.from(verifiedProof.publicKey) };
}

function injectVerifiedManifestKey(extensionDir: string, publicKey: Buffer): void {
	const manifestPath = join(extensionDir, "manifest.json");
	let manifest: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("Extension manifest must be an object.");
		manifest = parsed as Record<string, unknown>;
	} catch (cause) {
		throw new Error(
			`Unable to prepare verified extension identity: ${cause instanceof Error ? cause.message : "invalid manifest"}`,
		);
	}

	if (typeof manifest.version !== "string")
		throw new Error("Kestrel rejected the package because its extension version is invalid.");
	chromeVersionParts(manifest.version);

	if (typeof manifest.key === "string") {
		try {
			if (extensionIdFromPublicKey(Buffer.from(manifest.key, "base64")) === extensionIdFromPublicKey(publicKey))
				return;
		} catch {
			// Reject an invalid or mismatched manifest key below.
		}
		throw new Error("Extension manifest key did not match the verified CRX identity.");
	}
	if (manifest.key !== undefined)
		throw new Error("Extension manifest key did not match the verified CRX identity.");
	manifest.key = publicKey.toString("base64");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
}

function manifestKeyMatchesExtensionId(
	extensionDir: string,
	expectedExtensionId: string,
): boolean {
	try {
		const manifest: unknown = JSON.parse(
			readFileSync(join(extensionDir, "manifest.json"), "utf8"),
		);
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
			return false;
		const key = (manifest as Record<string, unknown>).key;
		return (
			typeof key === "string" &&
			extensionIdFromPublicKey(Buffer.from(key, "base64")) ===
				expectedExtensionId
		);
	} catch {
		return false;
	}
}

/**
 * Stored compatibility reports evolve independently from the public extension
 * record.  Keep a previously installed extension loadable when a newer Kestrel
 * adds a report field; its report will be replaced with an explicit legacy
 * result instead of silently dropping the whole extension record.
 */
const StoredExtensionSchema = InstalledExtensionSchema.omit({
	compatibility: true,
}).extend({
	path: z.string().min(1),
	compatibility: z.unknown().optional(),
});

type StoredExtension = Omit<InstalledExtension, "compatibility"> & {
	path: string;
	compatibility?: ExtensionCompatibilityReport;
};

type PendingInspection = {
	id: string;
	inspection: ChromeWebStoreExtensionInspection;
	stagingDir?: string;
	expiresAt: number;
};

const UpdateJournalSchema = z.object({
	format: z.literal(1),
	id: z.string().regex(/^[a-p]{32}$/),
	stagingName: z.string().regex(/^\.inspection-[a-f0-9-]{36}$/),
	backupName: z.string().regex(/^\.[a-p]{32}-[a-f0-9-]{36}\.backup$/),
	candidateName: z.string().regex(/^\.recovery-[a-p]{32}-[a-f0-9-]{36}$/),
	previousPackageManifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
	previousRecord: StoredExtensionSchema.nullable(),
	previousRecordManaged: z.boolean(),
}).strict();
type UpdateJournal = z.infer<typeof UpdateJournalSchema>;
const MAX_UPDATE_JOURNAL_BYTES = 256 * 1024;
const UninstallJournalSchema = z.object({
	format: z.literal(1),
	id: z.string().regex(/^[a-p]{32}$/),
	source: z.literal("chrome_web_store"),
}).strict();
type UninstallJournal = z.infer<typeof UninstallJournalSchema>;
const MAX_UNINSTALL_JOURNAL_BYTES = 1024;

function syncDirectory(directory: string): void {
	const fd = openSync(directory, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurableJson(path: string, value: unknown): void {
	const temporaryPath = `${path}.${randomUUID()}.new`;
	let fd: number | undefined;
	try {
		fd = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporaryPath, path);
		syncDirectory(dirname(path));
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
	}
}

function packageManifestHash(path: string): string {
	return createHash("sha256").update(readFileSync(join(path, "manifest.json"))).digest("hex");
}

function publicExtension(extension: StoredExtension): InstalledExtension {
	const { path: _path, ...publicRecord } = extension;
	return publicRecord;
}

function legacyCompatibility(): ExtensionCompatibilityReport {
	return {
		state: "unknown",
		summary:
			"Installed before Kestrel recorded compatibility evidence. Reload it to collect current runtime checks.",
		manifest: {
			manifestVersion: null,
			permissions: [],
			optionalPermissions: [],
			hostPermissions: [],
			optionalHostPermissions: [],
			contentScriptCount: 0,
			background: "none",
			commands: [],
			hasAction: false,
			hasSidePanel: false,
			hasDeclarativeNetRequest: false,
			hasExternallyConnectable: false,
			webAccessibleResourceCount: 0,
			unknownManifestKeys: [],
		},
		declaredRequirements: [],
		detectedApiUsage: [],
		findings: [
			{
				capability: "legacy compatibility evidence",
				status: "unknown",
				reason:
					"This extension was installed before Kestrel could inspect its requirements.",
				evidence: "manifest",
			},
		],
		staticAnalysis: {
			filesScanned: 0,
			sourceBytesScanned: 0,
			truncated: true,
			dynamicApiAccessDetected: false,
		},
		runtime: emptyRuntimeVerification(),
	};
}

function restoredCompatibility(value: unknown): ExtensionCompatibilityReport {
	const parsed = ExtensionCompatibilityReportSchema.safeParse(value);
	return parsed.success ? parsed.data : legacyCompatibility();
}

function unresolvedRuntimeChecks(
	report: ExtensionCompatibilityReport,
): Pick<
	ExtensionCompatibilityReport["runtime"],
	"contentScripts" | "storageLocal" | "extensionAction" | "hostPermissions"
> {
	return {
		contentScripts:
			report.manifest.contentScriptCount > 0 ? "not_checked" : "not_applicable",
		storageLocal: report.manifest.permissions.includes("storage")
			? "not_checked"
			: "not_applicable",
		extensionAction: report.manifest.hasAction
			? "not_checked"
			: "not_applicable",
		hostPermissions:
			report.manifest.hostPermissions.length > 0 ? "not_checked" : "not_applicable",
	};
}

function isManagedChromeWebStoreExtension(
	extension: StoredExtension,
	extensionsDir: string,
): boolean {
	return (
		extension.source === "chrome_web_store" &&
		/^[a-p]{32}$/.test(extension.id) &&
		resolve(extension.path) === resolve(join(extensionsDir, extension.id)) &&
		manifestKeyMatchesExtensionId(extension.path, extension.id)
	);
}

// Chrome compares one to four unsigned 16-bit components, padding missing
// components with zero. A reviewed package must never downgrade an install.
function chromeVersionParts(version: string): number[] {
	if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version))
		throw new Error("Kestrel rejected the package because its extension version is invalid.");
	const parts = version.split(".").map(Number);
	if (parts.some((part) => part > 65535) || parts.every((part) => part === 0))
		throw new Error("Kestrel rejected the package because its extension version is invalid.");
	return parts;
}

function compareChromeVersions(next: string, installed: string): number {
	const nextParts = chromeVersionParts(next);
	const installedParts = chromeVersionParts(installed);
	for (let index = 0; index < 4; index++) {
		const difference = (nextParts[index] ?? 0) - (installedParts[index] ?? 0);
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

function isOwnedExtensionDirectory(path: string, extensionsDir: string): boolean {
	return (
		resolve(path).startsWith(
			`${resolve(extensionsDir)}${process.platform === "win32" ? "\\" : "/"}`,
		)
	);
}

export class BrowserExtensionManager {
	private readonly extensionsDir: string;
	private readonly metadataPath: string;
	private readonly updateJournalPath: string;
	private readonly uninstallJournalPath: string;
	private readonly chromiumVersion: string;
	private pendingUpdate: UpdateJournal | null = null;
	private updateJournalError: Error | null = null;
	private pendingUninstall: UninstallJournal | null = null;
	private uninstallJournalError: Error | null = null;
	private readonly allowLocalExtensions: boolean;
	private readonly runtimeBackend: ExtensionCompatibilityRuntimeBackend;
	private readonly loadedFromRegistry = new Set<string>();
	private readonly pendingInspections = new Map<string, PendingInspection>();
	private extensions: Map<string, StoredExtension> = new Map();
	private skippedExtensions: StoredExtension[] = [];
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		baseStorageDir: string,
		options: {
			allowLocalExtensions?: boolean;
			runtimeBackend?: ExtensionCompatibilityRuntimeBackend;
			chromiumVersion?: string;
		} = {},
	) {
		this.extensionsDir = join(baseStorageDir, "browser-extensions");
		this.metadataPath = join(this.extensionsDir, "extensions.json");
		this.updateJournalPath = join(this.extensionsDir, ".store-update-journal.json");
		this.uninstallJournalPath = join(this.extensionsDir, ".store-uninstall-journal.json");
		const chromiumVersion = options.chromiumVersion ?? "128.0.6613.120";
		if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(chromiumVersion))
			throw new Error("The Chromium version must contain four numeric components.");
		chromeVersionParts(chromiumVersion);
		this.chromiumVersion = chromiumVersion;
		this.allowLocalExtensions = options.allowLocalExtensions === true;
		this.runtimeBackend = options.runtimeBackend ?? "electron";
		mkdirSync(this.extensionsDir, { recursive: true, mode: 0o700 });
		this.loadUpdateJournal();
		this.loadUninstallJournal();
		if (!this.pendingUpdate && !this.updateJournalError && !this.pendingUninstall && !this.uninstallJournalError) this.removeExpiredInspectionDirectories();
		this.loadRegistry();
	}

	private analyzePackage(directory: string): ExtensionCompatibilityReport {
		return analyzeExtensionCompatibility(directory, {
			runtimeBackend: this.runtimeBackend,
		});
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private removeExpiredInspectionDirectories(): void {
		for (const entry of readdirSync(this.extensionsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith(".inspection-")) continue;
			try {
				rmSync(join(this.extensionsDir, entry.name), {
					recursive: true,
					force: true,
				});
			} catch {
				// A stale temporary package can be retried at the next launch. It is
				// never added to the install registry.
			}
		}
	}

	private loadRegistry(): void {
		if (!existsSync(this.metadataPath)) return;
		try {
			const data = JSON.parse(readFileSync(this.metadataPath, "utf8"));
			if (!Array.isArray(data)) return;
			for (const item of data) {
				const parsed = StoredExtensionSchema.safeParse(item);
				if (!parsed.success || !existsSync(parsed.data.path)) continue;
				const { compatibility: persistedCompatibility, ...storedRecord } =
					parsed.data;
				const extension: StoredExtension = {
					...storedRecord,
					compatibility: restoredCompatibility(persistedCompatibility),
				};
				if (
					!this.allowLocalExtensions &&
					!isManagedChromeWebStoreExtension(extension, this.extensionsDir)
				) {
					this.skippedExtensions.push(extension);
					continue;
				}
				this.extensions.set(extension.id, extension);
				this.loadedFromRegistry.add(extension.id);
			}
		} catch {
			this.extensions.clear();
			this.skippedExtensions = [];
			this.loadedFromRegistry.clear();
		}
	}

	private saveRegistry(previousRecord?: UpdateJournal["previousRecord"]): void {
		const records = [...this.skippedExtensions, ...this.extensions.values()];
		writeDurableJson(this.metadataPath, records.map(record =>
			previousRecord?.id === record.id ? previousRecord : record));
	}

	private loadUpdateJournal(): void {
		if (!existsSync(this.updateJournalPath)) return;
		try {
			if (statSync(this.updateJournalPath).size > MAX_UPDATE_JOURNAL_BYTES)
				throw new Error("The extension recovery journal exceeds its safety limit.");
			const journal = UpdateJournalSchema.parse(JSON.parse(readFileSync(this.updateJournalPath, "utf8")));
			if (!journal.backupName.startsWith(`.${journal.id}-`) ||
				!journal.candidateName.startsWith(`.recovery-${journal.id}-`) ||
				(journal.previousRecordManaged && !journal.previousRecord) ||
				(journal.previousRecord && journal.previousPackageManifestHash === null) ||
				(journal.previousRecord && (journal.previousRecord.id !== journal.id ||
					resolve(journal.previousRecord.path) !== resolve(join(this.extensionsDir, journal.id)))))
				throw new Error("The extension recovery journal contains inconsistent package paths.");
			this.pendingUpdate = journal;
		} catch (cause) {
			this.updateJournalError = new Error("Extension recovery is required; the update journal could not be verified. All package copies were preserved.", { cause });
		}
	}

	private assertRecoveryComplete(): void {
		if (this.updateJournalError) throw this.updateJournalError;
		if (this.uninstallJournalError) throw this.uninstallJournalError;
		if (this.pendingUninstall)
			throw new Error("Extension uninstall recovery is required. Initialize the extension runtime to finish removing the extension before listing or changing extensions.");
		if (this.pendingUpdate)
			throw new Error("Extension update recovery is required. Initialize the extension runtime to recover the previous package before listing or changing extensions.");
	}

	private loadUninstallJournal(): void {
		if (!existsSync(this.uninstallJournalPath)) return;
		try {
			if (statSync(this.uninstallJournalPath).size > MAX_UNINSTALL_JOURNAL_BYTES)
				throw new Error("The extension uninstall journal exceeds its safety limit.");
			const journal = UninstallJournalSchema.parse(JSON.parse(readFileSync(this.uninstallJournalPath, "utf8")));
			const record = this.extensions.get(journal.id);
			if (record && !isManagedChromeWebStoreExtension(record, this.extensionsDir))
				throw new Error("The extension uninstall journal does not identify an owned Store package.");
			this.pendingUninstall = journal;
		} catch (cause) {
			this.uninstallJournalError = new Error("Extension uninstall recovery is required; the uninstall journal could not be verified. All package data was preserved.", { cause });
		}
	}

	private writeUninstallJournal(journal: UninstallJournal): void {
		this.pendingUninstall = journal;
		writeDurableJson(this.uninstallJournalPath, journal);
	}

	private clearUninstallJournal(): void {
		rmSync(this.uninstallJournalPath, { force: true });
		syncDirectory(this.extensionsDir);
		this.pendingUninstall = null;
	}

	private async recoverPendingUninstall(runtime?: ExtensionRuntime): Promise<void> {
		if (this.uninstallJournalError) throw this.uninstallJournalError;
		const journal = this.pendingUninstall;
		if (!journal) return;
		if (runtime) {
			if (runtime.uninstallExtension) await runtime.uninstallExtension(journal.id);
			else await runtime.removeExtension(journal.id);
		}
		const previousRecord = this.extensions.get(journal.id);
		const previousSkipped = this.skippedExtensions;
		const wasLoaded = this.loadedFromRegistry.has(journal.id);
		this.extensions.delete(journal.id);
		this.skippedExtensions = this.skippedExtensions.filter(item => item.id !== journal.id);
		this.loadedFromRegistry.delete(journal.id);
		try { this.saveRegistry(); } catch (cause) {
			if (previousRecord) this.extensions.set(journal.id, previousRecord);
			this.skippedExtensions = previousSkipped;
			if (wasLoaded) this.loadedFromRegistry.add(journal.id);
			throw cause;
		}
		this.clearUninstallJournal();
		const packagePath = join(this.extensionsDir, journal.id);
		try { rmSync(packagePath, { recursive: true, force: true }); } catch { /* registry removal is durable */ }
	}

	private writeUpdateJournal(journal: UpdateJournal): void {
		if (Buffer.byteLength(JSON.stringify(journal, null, 2), "utf8") > MAX_UPDATE_JOURNAL_BYTES)
			throw new Error("The extension recovery journal exceeds its safety limit.");
		// Set the guard before writing: an fsync failure may occur after rename.
		this.pendingUpdate = journal;
		writeDurableJson(this.updateJournalPath, journal);
	}

	private clearUpdateJournal(): void {
		rmSync(this.updateJournalPath, { force: true });
		syncDirectory(this.extensionsDir);
		this.pendingUpdate = null;
	}

	private async recoverPendingUpdate(runtime: ExtensionRuntime, alreadyDisabled = false): Promise<void> {
		if (this.updateJournalError) throw this.updateJournalError;
		const journal = this.pendingUpdate;
		if (!journal) return;
		const target = join(this.extensionsDir, journal.id);
		const backup = join(this.extensionsDir, journal.backupName);
		const candidate = join(this.extensionsDir, journal.candidateName);
		const staging = join(this.extensionsDir, journal.stagingName);
		// The native profile may have auto-registered a candidate even though
		// this manager has not loaded anything yet. Disable by identity and wait.
		if (!alreadyDisabled) await runtime.removeExtension(journal.id);
		if (existsSync(backup)) {
			if (existsSync(target)) {
				if (existsSync(candidate)) throw new Error("Extension recovery found ambiguous candidate copies; all files were preserved.");
				renameSync(target, candidate);
				syncDirectory(this.extensionsDir);
			}
			renameSync(backup, target);
			syncDirectory(this.extensionsDir);
		}
		if (journal.previousPackageManifestHash !== null) {
			if (!existsSync(target) || packageManifestHash(target) !== journal.previousPackageManifestHash)
				throw new Error("Extension recovery could not verify the previous package; all copies were preserved.");
			if (journal.previousRecordManaged && journal.previousRecord &&
				compareChromeVersions(readExtensionManifest(target, journal.id).version, journal.previousRecord.version) !== 0)
				throw new Error("Extension recovery found mismatched previous version metadata; all copies were preserved.");
		} else if (existsSync(target)) {
			if (existsSync(candidate)) throw new Error("Extension recovery found ambiguous candidate copies; all files were preserved.");
			renameSync(target, candidate);
			syncDirectory(this.extensionsDir);
		}
		if (existsSync(staging)) {
			if (existsSync(candidate)) throw new Error("Extension recovery found multiple candidate packages; all copies were preserved.");
			renameSync(staging, candidate);
			syncDirectory(this.extensionsDir);
		}
		this.extensions.delete(journal.id);
		this.skippedExtensions = this.skippedExtensions.filter(extension => extension.id !== journal.id);
		if (journal.previousRecord) {
			const { compatibility, ...previousFields } = journal.previousRecord;
			const previous: StoredExtension = {
				...previousFields,
				...(compatibility !== undefined ? { compatibility: restoredCompatibility(compatibility) } : {}),
			};
			if (journal.previousRecordManaged) this.extensions.set(journal.id, previous);
			else this.skippedExtensions.push(previous);
		}
		this.saveRegistry(journal.previousRecord);
		this.clearUpdateJournal();
	}

	private assertLocalExtensionsAllowed(): void {
		if (!this.allowLocalExtensions)
			throw new Error("Local extension installs are available only in development builds.");
	}

	private cleanupExpiredInspections(): void {
		const now = Date.now();
		for (const [inspectionId, inspection] of this.pendingInspections) {
			if (inspection.expiresAt > now) continue;
			this.pendingInspections.delete(inspectionId);
			if (inspection.stagingDir && existsSync(inspection.stagingDir))
				rmSync(inspection.stagingDir, { recursive: true, force: true });
		}
	}

	private async downloadVerifiedStorePackage(
		id: string,
		inspectionId: string,
	): Promise<PendingInspection> {
		const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${this.chromiumVersion}&acceptformat=crx3&x=id%3D${id}%26uc`;
		const downloadController = new AbortController();
		const downloadTimeout = setTimeout(
			() =>
				downloadController.abort(
					new Error("Chrome Web Store download timed out."),
				),
			30_000,
		);
		let buffer: Buffer;
		try {
			const response = await fetch(crxUrl, {
				signal: downloadController.signal,
				redirect: "follow",
			});
			if (!response.ok)
				throw new Error(
					`Failed to download extension from Chrome Web Store (HTTP ${response.status}).`,
				);
			buffer = await readBoundedExtensionResponse(response);
		} finally {
			clearTimeout(downloadTimeout);
		}
		const verifiedCrx = validateChromeWebStoreCrx(buffer, id);
		const stagingDir = join(this.extensionsDir, `.inspection-${inspectionId}`);
		try {
			mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
			extractCrxOrZip(verifiedCrx.archive, stagingDir);
			injectVerifiedManifestKey(stagingDir, verifiedCrx.publicKey);
			const manifest = readExtensionManifest(stagingDir, id);
			chromeVersionParts(manifest.version);
			const compatibility = this.analyzePackage(stagingDir);
			return {
				id,
				inspection: {
					inspectionId,
					id,
					name: manifest.name,
					version: manifest.version,
					...(manifest.description ? { description: manifest.description } : {}),
					source: "chrome_web_store",
					compatibility,
				},
				stagingDir,
				expiresAt: Date.now() + INSPECTION_TTL_MS,
			};
		} catch (cause) {
			if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
			throw cause;
		}
	}

	async inspectChromeWebStore(
		urlOrId: string,
	): Promise<ChromeWebStoreExtensionInspection> {
		return this.serialize(async () => {
			this.assertRecoveryComplete();
			this.cleanupExpiredInspections();
			const id = parseExtensionIdFromUrlOrId(urlOrId);
			if (!id)
				throw new Error(
					"Invalid Chrome Web Store URL or extension ID. Must be a 32-character ID.",
				);
			const inspectionId = randomUUID();
			const pending = await this.downloadVerifiedStorePackage(id, inspectionId);
			this.pendingInspections.set(inspectionId, pending);
			return pending.inspection;
		});
	}

	private async loadVerifiedStoreExtension(
		runtime: ExtensionRuntime,
		extensionPath: string,
		expectedId: string,
		requiresServiceWorker: boolean,
		cleanupOnFailure = true,
		onLoaded?: (id: string) => void,
	): Promise<Pick<
		ExtensionCompatibilityReport["runtime"],
		"registered" | "ready" | "backgroundServiceWorker" | "remainedLoaded"
	>> {
		let loadedId: string | undefined;
		try {
			const loaded = await runtime.loadExtension(extensionPath, {
				// Kestrel's visible browser does not navigate file:// pages. Do not grant
				// store extensions broader local-file access than the browser itself.
				allowFileAccess: false,
			});
			loadedId = loaded.id;
			onLoaded?.(loaded.id);
			if (loaded.id !== expectedId)
				throw new Error("The extension runtime loaded an unexpected identity.");
			const observed = runtime.getExtension(expectedId);
			if (
				!observed ||
				observed.id !== expectedId ||
				resolve(observed.path) !== resolve(extensionPath) ||
				compareChromeVersions(
					observed.version,
					readExtensionManifest(extensionPath, expectedId).version,
				) !== 0
			)
				throw new Error("The extension runtime did not register the verified package.");
			let backgroundServiceWorker: "passed" | "not_applicable" = "not_applicable";
			if (requiresServiceWorker) {
				await confirmServiceWorkerStartup(runtime, expectedId);
				backgroundServiceWorker = "passed";
			}
			return {
				registered: "passed",
				ready: loaded.ready,
				backgroundServiceWorker,
				remainedLoaded: "passed",
			};
		} catch (cause) {
			if (loadedId && cleanupOnFailure) {
				try {
					await runtime.removeExtension(loadedId);
				} catch {
					// Best effort cleanup after an extension fails startup verification.
				}
			}
			throw cause;
		}
	}

	private async loadLocalExtension(
		runtime: ExtensionRuntime,
		extensionPath: string,
	): Promise<void> {
		await runtime.loadExtension(extensionPath, { allowFileAccess: true });
	}

	async loadAll(runtime: ExtensionRuntime): Promise<void> {
		return this.serialize(async () => {
			await this.recoverPendingUninstall(runtime);
			await this.recoverPendingUpdate(runtime);
			let registryChanged = false;
			for (const extension of this.extensions.values()) {
				if (!extension.enabled || !existsSync(extension.path)) continue;
				try {
					const manifest = readExtensionManifest(extension.path, extension.id);
					if (extension.source === "chrome_web_store") {
						const currentCompatibility =
							extension.compatibility ?? legacyCompatibility();
						const checks = await this.loadVerifiedStoreExtension(
							runtime,
							extension.path,
							extension.id,
							manifest.requiresServiceWorker,
						);
						extension.compatibility = compatibilityWithRuntime(
							currentCompatibility,
							{
								...unresolvedRuntimeChecks(currentCompatibility),
								...checks,
								persistedAcrossRestart: this.loadedFromRegistry.has(extension.id)
									? "passed"
									: currentCompatibility.runtime.persistedAcrossRestart ??
										"not_checked",
							},
						);
						registryChanged = true;
					} else {
						await this.loadLocalExtension(runtime, extension.path);
					}
				} catch (error) {
					extension.enabled = false;
					if (extension.source === "chrome_web_store")
						extension.compatibility = compatibilityWithRuntime(
							extension.compatibility ?? legacyCompatibility(),
							{
								registered: "failed",
								remainedLoaded: "failed",
							},
						);
					registryChanged = true;
					console.warn(`[Extension] Failed to load extension ${extension.name}:`, error);
				}
			}
			if (registryChanged) this.saveRegistry();
		});
	}

	list(): InstalledExtension[] {
		this.assertRecoveryComplete();
		return [...this.extensions.values()].map(publicExtension);
	}

	async installInspectedChromeWebStore(
		inspectionId: string,
		runtime: ExtensionRuntime,
	): Promise<InstalledExtension> {
		return this.serialize(async () => {
			this.assertRecoveryComplete();
			this.cleanupExpiredInspections();
			const pending = this.pendingInspections.get(inspectionId);
			if (!pending || pending.expiresAt <= Date.now())
				throw new Error("This extension review has expired. Review the package again before installing it.");
			this.pendingInspections.delete(inspectionId);
			const existing = this.extensions.get(pending.id);
			const previousSkipped = this.skippedExtensions;
			const targetDir = join(this.extensionsDir, pending.id);
			const backupDir = join(this.extensionsDir, `.${pending.id}-${randomUUID()}.backup`);
			let backupCreated = false;
			let oldRuntimeDisabled = false;
			const candidateIds = new Set<string>();
			try {
				if (pending.inspection.compatibility.state === "unsupported")
					throw new Error(
						"Kestrel will not install this extension because its reviewed package requires a Chrome API that Kestrel documents as unsupported.",
					);
				if (!pending.stagingDir || !existsSync(pending.stagingDir))
					throw new Error("The reviewed extension package is no longer available. Review it again before installing.");
				const manifest = readExtensionManifest(pending.stagingDir, pending.id);
				chromeVersionParts(manifest.version);
				if (existing) {
					const comparison = compareChromeVersions(manifest.version, existing.version);
					if (comparison < 0)
						throw new Error("Kestrel will not downgrade an installed extension to an older reviewed version.");
					if (comparison === 0) return publicExtension(existing);
				}
				const previousRecord = existing ?? previousSkipped.find(extension => extension.id === pending.id) ?? null;
				const rawRecords = existsSync(this.metadataPath) ? JSON.parse(readFileSync(this.metadataPath, "utf8")) : [];
				const persistedPrevious = Array.isArray(rawRecords)
					? rawRecords.find((record: StoredExtension) => record.id === pending.id) : undefined;
				const journal: UpdateJournal = {
					format: 1, id: pending.id,
					stagingName: pending.stagingDir.slice(this.extensionsDir.length + 1),
					backupName: backupDir.slice(this.extensionsDir.length + 1),
					candidateName: `.recovery-${pending.id}-${randomUUID()}`,
					previousPackageManifestHash: existsSync(targetDir) ? packageManifestHash(targetDir) : null,
					previousRecord: persistedPrevious ? StoredExtensionSchema.parse(persistedPrevious) : previousRecord,
					previousRecordManaged: !!existing,
				};
				if (Buffer.byteLength(JSON.stringify(journal, null, 2), "utf8") > MAX_UPDATE_JOURNAL_BYTES)
					throw new Error("The extension recovery journal exceeds its safety limit.");
				if (existing?.enabled || runtime.getExtension(pending.id)) {
					// This is a data-preserving disable, never an uninstall. Wait for
					// acknowledgement before moving any package the runtime may use.
					await runtime.removeExtension(pending.id);
					oldRuntimeDisabled = true;
				}
				this.writeUpdateJournal(journal);
				if (existsSync(targetDir)) {
					renameSync(targetDir, backupDir);
					syncDirectory(this.extensionsDir);
					backupCreated = true;
				}
				// Only the exact signed package the person reviewed becomes durable.
				renameSync(pending.stagingDir, targetDir);
				syncDirectory(this.extensionsDir);
				const enabled = existing?.enabled ?? true;
				let compatibility = pending.inspection.compatibility;
				if (enabled) {
					// A rejected load can still have activated the candidate. Its
					// disable must succeed before rollback touches the package.
					candidateIds.add(pending.id);
					const checks = await this.loadVerifiedStoreExtension(
						runtime,
						targetDir,
						pending.id,
						manifest.requiresServiceWorker,
						false,
						(id) => candidateIds.add(id),
					);
					if (existing && checks.ready !== "passed")
						throw new Error("The updated extension did not provide live readiness acknowledgement.");
					compatibility = compatibilityWithRuntime(compatibility, {
						...unresolvedRuntimeChecks(compatibility),
						...checks,
						persistedAcrossRestart: "not_checked",
					});
				}
				const record: StoredExtension = {
					id: pending.id,
					name: manifest.name,
					version: manifest.version,
					...(manifest.description ? { description: manifest.description } : {}),
					...(manifest.homepageUrl ? { homepageUrl: manifest.homepageUrl } : {}),
					enabled,
					source: "chrome_web_store",
					path: targetDir,
					installedAt: existing?.installedAt ?? new Date().toISOString(),
					compatibility,
				};
				this.skippedExtensions = previousSkipped.filter(
					(extension) => extension.id !== pending.id,
				);
				this.extensions.set(pending.id, record);
				this.saveRegistry();
				this.clearUpdateJournal();
				if (backupCreated) {
					try {
						rmSync(backupDir, { recursive: true, force: true });
					} catch {
						// The verified update is durable; retain a recoverable backup
						// if only housekeeping failed.
					}
				}
				return publicExtension(record);
			} catch (cause) {
				if (!this.pendingUpdate) throw cause;
				try {
					for (const candidateId of candidateIds)
						await runtime.removeExtension(candidateId);
				} catch (disableCause) {
					throw new AggregateError([cause, disableCause],
						`Extension update failed and candidate disable was not acknowledged. Runtime state is unresolved; all package copies and recovery journal remain at ${this.extensionsDir}.`,
					);
				}
				try {
					await this.recoverPendingUpdate(runtime, candidateIds.size > 0 || oldRuntimeDisabled);
					if (existing?.enabled && oldRuntimeDisabled) {
						const previousManifest = readExtensionManifest(existing.path, existing.id);
						const checks = await this.loadVerifiedStoreExtension(
							runtime, existing.path, existing.id, previousManifest.requiresServiceWorker,
						);
						if (checks.ready !== "passed")
							throw new Error("The previous extension did not acknowledge readiness after rollback.");
					}
				} catch (recoveryCause) {
					if (!this.pendingUpdate && existing) {
						this.extensions.set(pending.id, { ...existing, enabled: false });
						this.saveRegistry();
					}
					throw new AggregateError([cause, recoveryCause],
						`Extension update failed and recovery could not be fully verified. All remaining package copies were preserved at ${this.extensionsDir}.`);
				}
				throw cause;
			} finally {
				if (!this.pendingUpdate && pending.stagingDir && existsSync(pending.stagingDir))
					rmSync(pending.stagingDir, { recursive: true, force: true });
			}
		});
	}

	async installFromUnpacked(
		folderPath: string,
		runtime?: ExtensionRuntime,
	): Promise<InstalledExtension> {
		return this.serialize(async () => {
			this.assertRecoveryComplete();
			this.assertLocalExtensionsAllowed();
			const resolvedPath = resolve(folderPath);
			if (!existsSync(resolvedPath))
				throw new Error("Extension directory does not exist.");
			const manifest = readExtensionManifest(resolvedPath);
			const id = `ext-${randomUUID().slice(0, 8)}`;
			const record: StoredExtension = {
				id,
				name: manifest.name,
				version: manifest.version,
				...(manifest.description ? { description: manifest.description } : {}),
				...(manifest.homepageUrl ? { homepageUrl: manifest.homepageUrl } : {}),
				enabled: true,
				source: "unpacked",
				path: resolvedPath,
				installedAt: new Date().toISOString(),
				compatibility: this.analyzePackage(resolvedPath),
			};
			if (runtime) await this.loadLocalExtension(runtime, resolvedPath);
			this.extensions.set(id, record);
			this.saveRegistry();
			return publicExtension(record);
		});
	}

	async installFromCrxOrZipFile(
		filePath: string,
		runtime?: ExtensionRuntime,
	): Promise<InstalledExtension> {
		return this.serialize(async () => {
			this.assertRecoveryComplete();
			this.assertLocalExtensionsAllowed();
			const resolvedPath = resolve(filePath);
			if (!existsSync(resolvedPath))
				throw new Error("Extension archive file does not exist.");
			const buffer = readFileSync(resolvedPath);
			const id = `ext-${randomUUID().slice(0, 8)}`;
			const targetDir = join(this.extensionsDir, id);
			mkdirSync(targetDir, { recursive: true, mode: 0o700 });
			try {
				extractCrxOrZip(buffer, targetDir);
				const manifest = readExtensionManifest(targetDir);
				const record: StoredExtension = {
					id,
					name: manifest.name,
					version: manifest.version,
					...(manifest.description ? { description: manifest.description } : {}),
					...(manifest.homepageUrl ? { homepageUrl: manifest.homepageUrl } : {}),
					enabled: true,
					source: "file",
					path: targetDir,
					installedAt: new Date().toISOString(),
					compatibility: this.analyzePackage(targetDir),
				};
				if (runtime) await this.loadLocalExtension(runtime, targetDir);
				this.extensions.set(id, record);
				this.saveRegistry();
				return publicExtension(record);
			} catch (cause) {
				rmSync(targetDir, { recursive: true, force: true });
				throw cause;
			}
		});
	}

	async toggle(
		id: string,
		enabled: boolean,
		runtime?: ExtensionRuntime,
	): Promise<InstalledExtension> {
		return this.serialize(async () => {
			this.assertRecoveryComplete();
			const extension = this.extensions.get(id);
			if (!extension) throw new Error("Extension not found.");
			if (extension.enabled === enabled) return publicExtension(extension);
			if (runtime) {
				if (enabled) {
					const manifest = readExtensionManifest(extension.path, extension.id);
					if (extension.source === "chrome_web_store") {
						const currentCompatibility =
							extension.compatibility ?? legacyCompatibility();
						const checks = await this.loadVerifiedStoreExtension(
							runtime,
							extension.path,
							extension.id,
							manifest.requiresServiceWorker,
						);
						extension.compatibility = compatibilityWithRuntime(
							currentCompatibility,
							{
								...unresolvedRuntimeChecks(currentCompatibility),
								...checks,
							},
						);
					} else await this.loadLocalExtension(runtime, extension.path);
				} else {
					await runtime.removeExtension(id);
				}
			}
			extension.enabled = enabled;
			this.saveRegistry();
			return publicExtension(extension);
		});
	}

	async reload(id: string, runtime: ExtensionRuntime): Promise<InstalledExtension> {
		return this.serialize(async () => {
			this.assertRecoveryComplete();
			const extension = this.extensions.get(id);
			if (!extension) throw new Error("Extension not found.");
			if (!extension.enabled) throw new Error("Enable this extension before reloading it.");
			try {
				await runtime.removeExtension(id);
			} catch {
				// A reload should also recover if the runtime had already unloaded it.
			}
			try {
				const manifest = readExtensionManifest(extension.path, extension.id);
				if (extension.source === "chrome_web_store") {
					const currentCompatibility =
						extension.compatibility ?? legacyCompatibility();
					const checks = await this.loadVerifiedStoreExtension(
						runtime,
						extension.path,
						extension.id,
						manifest.requiresServiceWorker,
					);
					extension.compatibility = compatibilityWithRuntime(
						currentCompatibility,
						{
							...unresolvedRuntimeChecks(currentCompatibility),
							...checks,
						},
					);
				} else await this.loadLocalExtension(runtime, extension.path);
				this.saveRegistry();
				return publicExtension(extension);
			} catch (cause) {
				extension.enabled = false;
				if (extension.source === "chrome_web_store")
					extension.compatibility = compatibilityWithRuntime(
						extension.compatibility ?? legacyCompatibility(),
						{ registered: "failed" },
					);
				this.saveRegistry();
				throw cause;
			}
		});
	}

	async uninstall(id: string, runtime?: ExtensionRuntime): Promise<void> {
		return this.serialize(async () => {
			if (this.pendingUninstall?.id === id && runtime) return this.recoverPendingUninstall(runtime);
			this.assertRecoveryComplete();
			const extension = this.extensions.get(id);
			if (!extension) return;
			if (!isManagedChromeWebStoreExtension(extension, this.extensionsDir)) {
				// Local development packages are not eligible for durable Store uninstall intent.
				if (runtime) {
					if (runtime.uninstallExtension) await runtime.uninstallExtension(id);
					else await runtime.removeExtension(id);
				}
				this.extensions.delete(id);
				try { this.saveRegistry(); } catch (cause) {
					this.extensions.set(id, extension);
					throw cause;
				}
				if (isOwnedExtensionDirectory(extension.path, this.extensionsDir)) {
					try { rmSync(extension.path, { recursive: true, force: true }); } catch { /* durable registry removal */ }
				}
				return;
			}
			this.writeUninstallJournal({ format: 1, id, source: "chrome_web_store" });
			return this.recoverPendingUninstall(runtime);
		});
	}
}
