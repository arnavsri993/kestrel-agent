import { basename, extname, isAbsolute } from "node:path";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type {
	FilePreview,
	SelectedAttachment,
	UserBrowserFile,
} from "@kestrel/shared-types";
import {
	FilePreviewSchema,
	SelectedAttachmentSchema,
	UserBrowserFileSchema,
} from "@kestrel/shared-types";

export const MAX_FILE_TAB_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 1_000_000;
export const MAX_INLINE_MEDIA_BYTES = 32 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".json": "application/json",
	".jsonl": "application/jsonl",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".js": "application/javascript",
	".jsx": "application/javascript",
	".mjs": "application/javascript",
	".cjs": "application/javascript",
	".py": "text/x-python",
	".rb": "text/x-ruby",
	".go": "text/x-go",
	".rs": "text/x-rust",
	".java": "text/x-java-source",
	".c": "text/x-c",
	".h": "text/x-c",
	".cc": "text/x-c++",
	".cpp": "text/x-c++",
	".hpp": "text/x-c++",
	".swift": "text/x-swift",
	".m": "text/x-objective-c",
	".mm": "text/x-objective-c",
	".php": "text/x-php",
	".sql": "application/sql",
	".sh": "application/x-sh",
	".bash": "application/x-sh",
	".zsh": "application/x-sh",
	".fish": "application/x-sh",
	".css": "text/css",
	".scss": "text/x-scss",
	".less": "text/x-less",
	".html": "text/html",
	".htm": "text/html",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".toml": "application/toml",
	".ini": "text/plain",
	".conf": "text/plain",
	".log": "text/plain",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx":
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".epub": "application/epub+zip",
};

const TEXT_MEDIA_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/typescript",
	"application/json",
	"application/jsonl",
	"text/csv",
	"text/tab-separated-values",
	"application/javascript",
	"text/x-python",
	"text/x-ruby",
	"text/x-go",
	"text/x-rust",
	"text/x-java-source",
	"text/x-c",
	"text/x-c++",
	"text/x-swift",
	"text/x-objective-c",
	"text/x-php",
	"application/sql",
	"application/x-sh",
	"text/css",
	"text/x-scss",
	"text/x-less",
	"text/html",
	"application/xml",
	"application/yaml",
	"application/toml",
]);

function cleanPath(value: string): string {
	if (!isAbsolute(value) || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value))
		throw new Error("Choose a regular local file.");
	return value;
}

export function mediaTypeForPath(path: string): string {
	return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function fileTabUrl(tabId: string): string {
	return `kestrel://file/${tabId}`;
}

export function isTextFileMediaType(mediaType: string): boolean {
	return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1_000) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes;
	let unit = -1;
	while (value >= 1_000 && unit < units.length - 1) {
		value /= 1_000;
		unit += 1;
	}
	return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export async function inspectFilePath(path: string): Promise<UserBrowserFile> {
	const requested = cleanPath(path);
	const canonical = await realpath(requested);
	const metadata = await stat(canonical);
	if (!metadata.isFile()) throw new Error(`${basename(requested)} is not a regular file.`);
	if (metadata.size > MAX_FILE_TAB_BYTES)
		throw new Error(`${basename(requested)} is larger than the 2 GB file-tab limit.`);
	const name = basename(canonical);
	return UserBrowserFileSchema.parse({
		path: canonical,
		name,
		extension: extname(name).toLowerCase().replace(/^\./, ""),
		mediaType: mediaTypeForPath(name),
		size: metadata.size,
		modifiedAt: metadata.mtime.toISOString(),
		status: "available",
	});
}

export function fileAttachment(file: UserBrowserFile): SelectedAttachment | undefined {
	if (file.status !== "available" || file.size > MAX_ATTACHMENT_BYTES) return undefined;
	return SelectedAttachmentSchema.parse({
		path: file.path,
		name: file.name,
		mediaType: file.mediaType,
		size: file.size,
		source: "external",
	});
}

async function readPrefix(path: string, bytes: number): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const result = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, result.bytesRead);
	} finally {
		await handle.close();
	}
}

export async function previewFile(
	tabId: string,
	file: UserBrowserFile,
): Promise<FilePreview> {
	try {
		const current = await inspectFilePath(file.path);
		const base = { tabId, mediaType: current.mediaType, bytes: current.size };
		if (isTextFileMediaType(current.mediaType)) {
			if (current.size > MAX_TEXT_PREVIEW_BYTES)
				return FilePreviewSchema.parse({
					...base,
					kind: "metadata",
					detail: `This text file is ${formatFileSize(current.size)}. Kestrel can attach it to a task, but keeps the in-window preview bounded to 1 MB.`,
				});
			const bytes = await readPrefix(current.path, current.size);
			if (bytes.includes(0))
				return FilePreviewSchema.parse({
					...base,
					kind: "metadata",
					detail: "This file contains binary data. Open it in its default app or ask Kestrel to inspect it.",
				});
			return FilePreviewSchema.parse({
				...base,
				kind: "text",
				text: bytes.toString("utf8"),
				truncated: false,
			});
		}
		if (current.mediaType.startsWith("image/") && current.size <= MAX_INLINE_MEDIA_BYTES) {
			const bytes = await readPrefix(current.path, current.size);
			return FilePreviewSchema.parse({
				...base,
				kind: "image",
				dataUrl: `data:${current.mediaType};base64,${bytes.toString("base64")}`,
			});
		}
		if (current.mediaType === "application/pdf" && current.size <= MAX_INLINE_MEDIA_BYTES) {
			const bytes = await readPrefix(current.path, current.size);
			return FilePreviewSchema.parse({
				...base,
				kind: "pdf",
				dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
			});
		}
		if (
			(current.mediaType.startsWith("audio/") || current.mediaType.startsWith("video/")) &&
			current.size <= MAX_INLINE_MEDIA_BYTES
		) {
			const bytes = await readPrefix(current.path, current.size);
			return FilePreviewSchema.parse({
				...base,
				kind: current.mediaType.startsWith("audio/") ? "audio" : "video",
				dataUrl: `data:${current.mediaType};base64,${bytes.toString("base64")}`,
			});
		}
		return FilePreviewSchema.parse({
			...base,
			kind: "metadata",
			detail: current.size > MAX_INLINE_MEDIA_BYTES
				? `This ${current.mediaType} file is ${formatFileSize(current.size)}. Kestrel keeps large media out of the renderer; use the default app or attach it to a task.`
				: "Kestrel can keep this file as a tab and pass it to a compatible agent route, but does not ship a bespoke renderer for this format.",
		});
	} catch (error) {
		return FilePreviewSchema.parse({
			tabId,
			kind: "metadata",
			mediaType: file.mediaType,
			bytes: file.size,
			detail:
				error instanceof Error
					? `${file.name} is no longer available. ${error.message}`
					: `${file.name} is no longer available.`,
		});
	}
}

export async function fileStillExists(path: string): Promise<boolean> {
	try {
		const metadata = await lstat(path);
		return metadata.isFile();
	} catch {
		return false;
	}
}
