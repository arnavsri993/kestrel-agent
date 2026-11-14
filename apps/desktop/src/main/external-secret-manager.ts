import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
	type ExternalSecretConfiguration,
	ExternalSecretConfigurationSchema,
	type ExternalSecretProviderId,
	type ExternalSecretProviderStatus,
} from "@kestrel/shared-types";
import {
	BROKERED_CREDENTIALS,
	type BrokeredCredentialId,
	type CredentialBroker,
	type ResolvedExternalCredentials,
} from "./credential-broker";

const execFileAsync = promisify(execFile);
const CONFIGURATION_SECRET_ID = "external-secret-configuration";
const ONEPASSWORD_TOKEN_SECRET_ID = "external-secret-onepassword-token";
const BITWARDEN_TOKEN_SECRET_ID = "external-secret-bitwarden-token";
const verificationQueues = new Map<string, Promise<void>>();

const BWS_MANIFEST = {
	version: "2.0.0",
	url: "https://github.com/bitwarden/sdk-sm/releases/download/bws-v2.0.0/bws-macos-universal-2.0.0.zip",
	fileName: "bws-macos-universal-2.0.0.zip",
	bytes: 12_371_243,
	sha256: "67ab9bc345e2ec3b5dfddd116f938fdab79538042623a6bcca5ca0c1b0c42d95",
	binaryPath: "bws",
} as const;

type SourceVerification = {
	state: "verified" | "error";
	detail: string;
	resolvedCredentialIds: BrokeredCredentialId[];
	lastSyncedAt: string;
};

type VerificationState = Partial<
	Record<ExternalSecretProviderId, SourceVerification>
>;

interface PrivateFileIdentity {
	dev: string;
	ino: string;
	uid: string;
	mode: number;
	nlink: number;
	size: number;
	mtimeNs: string;
	ctimeNs: string;
}

interface PrivateDirectoryIdentity {
	dev: string;
	ino: string;
	uid: string;
	mode: number;
}

interface VerificationSnapshot {
	verification: VerificationState;
	valid: boolean;
	directory?: PrivateDirectoryIdentity;
	file?: PrivateFileIdentity;
}

const VERIFICATION_MAX_BYTES = 64 * 1024;
const BITWARDEN_MANIFEST_MAX_BYTES = 16 * 1024;
const BITWARDEN_BINARY_MAX_BYTES = 128 * 1024 * 1024;
const PROVIDER_IDS = ["onepassword", "bitwarden", "command"] as const;
const CREDENTIAL_IDS = new Set(Object.keys(BROKERED_CREDENTIALS));

function verificationDetail(state: SourceVerification["state"]): string {
	return state === "verified"
		? "Supported provider credentials resolved."
		: "Secret source could not be verified.";
}

function sameFileIdentity(
	left: PrivateFileIdentity,
	right: PrivateFileIdentity,
): boolean {
	return Object.keys(left).every((key) =>
		left[key as keyof PrivateFileIdentity] === right[key as keyof PrivateFileIdentity],
	);
}

function fileIdentity(stat: BigIntStats): PrivateFileIdentity {
	return {
		dev: String(stat.dev),
		ino: String(stat.ino),
		uid: String(stat.uid),
		mode: Number(stat.mode) & 0o7777,
		nlink: Number(stat.nlink),
		size: Number(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
	};
}

function directoryIdentity(stat: BigIntStats): PrivateDirectoryIdentity {
	return {
		dev: String(stat.dev),
		ino: String(stat.ino),
		uid: String(stat.uid),
		mode: Number(stat.mode) & 0o7777,
	};
}

function sameDirectoryIdentity(
	left: PrivateDirectoryIdentity,
	right: PrivateDirectoryIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino &&
		left.uid === right.uid && left.mode === right.mode;
}

function parseVerificationState(value: unknown): VerificationState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: VerificationState = {};
	for (const [providerId, raw] of Object.entries(value)) {
		if (!(PROVIDER_IDS as readonly string[]).includes(providerId) ||
			!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const record = raw as Record<string, unknown>;
		if (Object.keys(record).sort().join(",") !==
			["detail", "lastSyncedAt", "resolvedCredentialIds", "state"].sort().join(",") ||
			(record.state !== "verified" && record.state !== "error") ||
			typeof record.detail !== "string" || record.detail.length > 512 ||
			typeof record.lastSyncedAt !== "string" ||
			!Array.isArray(record.resolvedCredentialIds) ||
			record.resolvedCredentialIds.length > CREDENTIAL_IDS.size) return undefined;
		const parsedDate = new Date(record.lastSyncedAt);
		if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== record.lastSyncedAt)
			return undefined;
		const ids: BrokeredCredentialId[] = [];
		for (const id of record.resolvedCredentialIds) {
			if (typeof id !== "string" || !CREDENTIAL_IDS.has(id) || ids.includes(id as BrokeredCredentialId))
				return undefined;
			ids.push(id as BrokeredCredentialId);
		}
		if ((record.state === "verified" && ids.length === 0) ||
			(record.state === "error" && ids.length !== 0)) return undefined;
		const state = record.state;
		result[providerId as ExternalSecretProviderId] = {
			state,
			detail: verificationDetail(state),
			resolvedCredentialIds: ids,
			lastSyncedAt: record.lastSyncedAt,
		};
	}
	return result;
}

function sameIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
	return sameFileIdentity(left, right);
}

async function hashPrivateFile(path: string, expectedMode: number): Promise<{ sha256: string; bytes: number }> {
	const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const before = await handle.stat({ bigint: true });
		const identity = fileIdentity(before);
		if (!before.isFile() || identity.nlink !== 1 || identity.mode !== expectedMode ||
			identity.size > BITWARDEN_BINARY_MAX_BYTES ||
			(owner !== undefined && Number(before.uid) !== owner))
			throw new Error("The managed Bitwarden CLI file is unsafe.");
		const digest = createHash("sha256");
		let bytes = 0;
		for (;;) {
			const buffer = Buffer.alloc(64 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			bytes += bytesRead;
			if (bytes > BITWARDEN_BINARY_MAX_BYTES)
				throw new Error("The managed Bitwarden CLI binary exceeds its size limit.");
			digest.update(buffer.subarray(0, bytesRead));
		}
		const after = fileIdentity(await handle.stat({ bigint: true }));
		const pathIdentity = fileIdentity(await lstat(path, { bigint: true }));
		if (!sameIdentity(identity, after) || !sameIdentity(identity, pathIdentity) || bytes !== identity.size)
			throw new Error("The managed Bitwarden CLI file changed during verification.");
		return { sha256: digest.digest("hex"), bytes };
	} finally {
		await handle.close();
	}
}

async function readPrivateFile(path: string, expectedMode: number, maxBytes: number): Promise<Buffer> {
	const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const beforeStat = await handle.stat({ bigint: true });
		const before = fileIdentity(beforeStat);
		if (!beforeStat.isFile() || before.mode !== expectedMode || before.nlink !== 1 || before.size > maxBytes ||
			(owner !== undefined && Number(before.uid) !== owner))
			throw new Error("The managed Bitwarden CLI file is unsafe.");
		const parts: Buffer[] = [];
		let bytes = 0;
		for (;;) {
			const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1 - bytes));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			bytes += bytesRead;
			if (bytes > maxBytes) throw new Error("The managed Bitwarden CLI file exceeds its limit.");
			parts.push(buffer.subarray(0, bytesRead));
		}
		const after = fileIdentity(await handle.stat({ bigint: true }));
		const pathAfter = fileIdentity(await lstat(path, { bigint: true }));
		if (!sameIdentity(before, after) || !sameIdentity(before, pathAfter) || bytes !== before.size)
			throw new Error("The managed Bitwarden CLI file changed during verification.");
		return Buffer.concat(parts);
	} finally {
		await handle.close();
	}
}

async function writePrivateExclusive(path: string, contents: Buffer, mode: number): Promise<PrivateFileIdentity> {
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
		mode,
	);
	let before: PrivateFileIdentity;
	try {
		before = fileIdentity(await handle.stat({ bigint: true }));
		let offset = 0;
		while (offset < contents.length) {
			const { bytesWritten } = await handle.write(contents, offset, contents.length - offset, null);
			if (bytesWritten <= 0) throw new Error("The managed Bitwarden CLI file could not be written.");
			offset += bytesWritten;
		}
		await handle.sync();
		const after = fileIdentity(await handle.stat({ bigint: true }));
		if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid ||
			after.nlink !== 1 || after.mode !== mode || after.size !== contents.length)
			throw new Error("The managed Bitwarden CLI file changed while being written.");
		return after;
	} finally {
		await handle.close();
	}
}

async function managedBitwardenDirectoryMatches(
	directory: string,
	expected: Record<string, unknown>,
): Promise<boolean> {
	try {
		const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
		const root = await lstat(directory, { bigint: true });
		if (!root.isDirectory() || root.isSymbolicLink() || (Number(root.mode) & 0o7777) !== 0o700 ||
			(owner !== undefined && Number(root.uid) !== owner)) return false;
		const marker = JSON.parse((await readPrivateFile(
			join(directory, "workstrand-install.json"), 0o600, BITWARDEN_MANIFEST_MAX_BYTES,
		)).toString("utf8")) as Record<string, unknown>;
		const binary = await hashPrivateFile(join(directory, "bws"), 0o700);
		return marker.version === expected.version && marker.sha256 === expected.sha256 &&
			marker.binarySha256 === binary.sha256 && marker.binaryBytes === binary.bytes;
	} catch {
		return false;
	}
}

/** Preserve an incomplete private managed install in a unique recovery folder. */
export async function preservePrivateManagedBitwardenDirectoryIfIncomplete(input: {
	finalDirectory: string;
	expectedMarker: Record<string, unknown>;
}): Promise<string | undefined> {
	const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
	const parentPath = dirname(input.finalDirectory);
	const parent = await lstat(parentPath, { bigint: true });
	const parentIdentity = directoryIdentity(parent);
	const parentRealPath = await realpath(parentPath);
	if (!parent.isDirectory() || parent.isSymbolicLink() ||
		(owner !== undefined && Number(parent.uid) !== owner) ||
		(Number(parent.mode) & 0o7777) !== 0o700)
		throw new Error("The managed Bitwarden CLI recovery location is unsafe.");

	let current: Awaited<ReturnType<typeof lstat>>;
	try {
		current = await lstat(input.finalDirectory, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("The managed Bitwarden CLI install cannot be preserved safely.");
	}
	const currentIdentity = directoryIdentity(current);
	const currentMode = Number(current.mode) & 0o7777;
	if (!current.isDirectory() || current.isSymbolicLink() || currentMode !== 0o700 ||
		(owner !== undefined && Number(current.uid) !== owner) ||
		await realpath(input.finalDirectory) !== join(parentRealPath, input.finalDirectory.slice(parentPath.length + 1)))
		throw new Error("The managed Bitwarden CLI install cannot be preserved safely.");
	if (await managedBitwardenDirectoryMatches(input.finalDirectory, input.expectedMarker))
		throw new Error("A verified managed Bitwarden CLI install already exists.");

	const parentHandle = await open(parentPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
	let recoveryHandle: Awaited<ReturnType<typeof open>> | undefined;
	const reservation = join(parentPath, `.bws-preserved-${randomUUID()}`);
	const preservedPath = join(reservation, "previous");
	try {
		sourceHandle = await open(input.finalDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
		await mkdir(reservation, { mode: 0o700 });
		recoveryHandle = await open(reservation, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
		const recoveryStat = await recoveryHandle.stat({ bigint: true });
		const recoveryIdentity = directoryIdentity(recoveryStat);
		if (!recoveryStat.isDirectory() || recoveryStat.isSymbolicLink() ||
			(Number(recoveryStat.mode) & 0o7777) !== 0o700 ||
			(owner !== undefined && Number(recoveryStat.uid) !== owner) ||
			(await readdir(reservation)).length !== 0)
			throw new Error("The managed Bitwarden CLI recovery location changed.");

		const sourceFdIdentity = directoryIdentity(await sourceHandle.stat({ bigint: true }));
		const parentFdIdentity = directoryIdentity(await parentHandle.stat({ bigint: true }));
		const parentPathIdentity = directoryIdentity(await lstat(parentPath, { bigint: true }));
		const sourcePathIdentity = directoryIdentity(await lstat(input.finalDirectory, { bigint: true }));
		if (!sameDirectoryIdentity(parentIdentity, parentFdIdentity) ||
			!sameDirectoryIdentity(parentIdentity, parentPathIdentity) ||
			await realpath(parentPath) !== parentRealPath ||
			!sameDirectoryIdentity(currentIdentity, sourceFdIdentity) ||
			!sameDirectoryIdentity(currentIdentity, sourcePathIdentity) ||
			!sameDirectoryIdentity(recoveryIdentity, directoryIdentity(await lstat(reservation, { bigint: true }))) ||
			(await readdir(reservation)).length !== 0)
			throw new Error("The managed Bitwarden CLI install changed before preservation.");

		// Ordinary rename is used only after identity checks. If a concurrent path
		// change races these checks, the post-check fails and both paths are kept.
		await rename(input.finalDirectory, preservedPath);
		const moved = directoryIdentity(await lstat(preservedPath, { bigint: true }));
		if (!sameDirectoryIdentity(currentIdentity, moved) ||
			!sameDirectoryIdentity(parentIdentity, directoryIdentity(await parentHandle.stat({ bigint: true }))) ||
			!sameDirectoryIdentity(parentIdentity, directoryIdentity(await lstat(parentPath, { bigint: true }))) ||
			await realpath(parentPath) !== parentRealPath)
			throw new Error("The managed Bitwarden CLI install changed during preservation.");
		await recoveryHandle.sync();
		await parentHandle.sync();
		return reservation;
	} finally {
		await Promise.all([
			sourceHandle?.close().catch(() => undefined),
			recoveryHandle?.close().catch(() => undefined),
			parentHandle.close().catch(() => undefined),
		]);
	}
}

/** Publish a verified binary into a new private directory without replacing existing content. */
export async function publishPrivateManagedBitwardenDirectory(input: {
	sourceBinary: string;
	finalDirectory: string;
	marker: Record<string, unknown>;
	preserveExisting?: boolean;
}): Promise<void> {
	const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
	const parentPath = dirname(input.finalDirectory);
	const parent = await lstat(parentPath, { bigint: true });
	const parentIdentity = directoryIdentity(parent);
	if (!parent.isDirectory() || parent.isSymbolicLink() ||
		(owner !== undefined && Number(parent.uid) !== owner) ||
		(Number(parent.mode) & 0o077) !== 0)
		throw new Error("The managed Bitwarden CLI destination is unsafe.");
	if (input.preserveExisting)
		await preservePrivateManagedBitwardenDirectoryIfIncomplete({
			finalDirectory: input.finalDirectory,
			expectedMarker: input.marker,
		});
	await mkdir(input.finalDirectory, { mode: 0o700 });
	const finalStat = await lstat(input.finalDirectory, { bigint: true });
	const finalIdentity = directoryIdentity(finalStat);
	if (!finalStat.isDirectory() || finalStat.isSymbolicLink() ||
		(owner !== undefined && Number(finalStat.uid) !== owner) ||
		(Number(finalStat.mode) & 0o077) !== 0)
		throw new Error("The managed Bitwarden CLI destination is unsafe.");
	const source = await hashPrivateFile(input.sourceBinary, 0o700);
	const binaryPath = join(input.finalDirectory, "bws");
	let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
	let binaryHandle: Awaited<ReturnType<typeof open>> | undefined;
	let binaryIdentity: PrivateFileIdentity | undefined;
	try {
		sourceHandle = await open(
			input.sourceBinary,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		binaryHandle = await open(
			binaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o700,
		);
		const sourceBefore = fileIdentity(await sourceHandle.stat({ bigint: true }));
		binaryIdentity = fileIdentity(await binaryHandle.stat({ bigint: true }));
		const digest = createHash("sha256");
		let bytes = 0;
		for (;;) {
			const buffer = Buffer.alloc(64 * 1024);
			const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			const chunk = buffer.subarray(0, bytesRead);
			digest.update(chunk);
			bytes += bytesRead;
			if (bytes > BITWARDEN_BINARY_MAX_BYTES)
				throw new Error("The managed Bitwarden CLI binary exceeds its size limit.");
			let offset = 0;
			while (offset < bytesRead) {
				const { bytesWritten } = await binaryHandle.write(chunk, offset, bytesRead - offset, null);
				if (bytesWritten <= 0) throw new Error("The managed Bitwarden CLI binary could not be copied.");
				offset += bytesWritten;
			}
		}
		const sourceAfter = fileIdentity(await sourceHandle.stat({ bigint: true }));
		const binaryAfter = fileIdentity(await binaryHandle.stat({ bigint: true }));
		const copiedDigest = digest.digest("hex");
		if (!sameIdentity(sourceBefore, sourceAfter) || bytes !== source.bytes ||
			copiedDigest !== source.sha256 || binaryAfter.dev !== binaryIdentity.dev ||
			binaryAfter.ino !== binaryIdentity.ino || binaryAfter.uid !== binaryIdentity.uid ||
			binaryAfter.mode !== 0o700 || binaryAfter.nlink !== 1 || binaryAfter.size !== bytes)
			throw new Error("The managed Bitwarden CLI binary failed verification.");
		await binaryHandle.sync();
	} finally {
		await Promise.all([sourceHandle?.close().catch(() => undefined), binaryHandle?.close().catch(() => undefined)]);
	}
	const copied = await hashPrivateFile(binaryPath, 0o700);
	if (copied.sha256 !== source.sha256 || copied.bytes !== source.bytes)
		throw new Error("The managed Bitwarden CLI binary failed verification.");
	const finalParent = directoryIdentity(await lstat(parentPath, { bigint: true }));
	const finalDirectoryNow = directoryIdentity(await lstat(input.finalDirectory, { bigint: true }));
	if (!sameDirectoryIdentity(parentIdentity, finalParent) || !sameDirectoryIdentity(finalIdentity, finalDirectoryNow))
		throw new Error("The managed Bitwarden CLI destination changed.");
	const manifest = Buffer.from(`${JSON.stringify({ ...input.marker, binarySha256: copied.sha256, binaryBytes: copied.bytes }, null, 2)}\n`, "utf8");
	if (manifest.byteLength > BITWARDEN_MANIFEST_MAX_BYTES)
		throw new Error("The managed Bitwarden CLI manifest exceeds its limit.");
	await writePrivateExclusive(join(input.finalDirectory, "workstrand-install.json"), manifest, 0o600);
	const directoryHandle = await open(input.finalDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!sameDirectoryIdentity(finalIdentity, directoryIdentity(await directoryHandle.stat({ bigint: true }))))
			throw new Error("The managed Bitwarden CLI destination changed.");
		await directoryHandle.sync();
	} finally {
		await directoryHandle.close();
	}
}

interface ExecutionOptions {
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	maxBuffer: number;
}

interface ExternalSecretManagerDependencies {
	fetch?: typeof fetch;
	execute?: (
		file: string,
		args: string[],
		options: ExecutionOptions,
	) => Promise<{ stdout: string }>;
	now?: () => Date;
	platform?: NodeJS.Platform;
	architecture?: string;
}

export const DEFAULT_EXTERNAL_SECRET_CONFIGURATION: ExternalSecretConfiguration =
	{
		version: 1,
		onepassword: {
			enabled: false,
			account: "",
			mappings: {},
			overrideStored: true,
		},
		bitwarden: {
			enabled: false,
			projectId: "",
			serverUrl: "",
			autoInstall: true,
			overrideStored: true,
		},
		command: {
			enabled: false,
			executablePath: "",
			arguments: [],
			timeoutMs: 3_000,
			overrideStored: false,
		},
	};

const environmentToCredential = Object.fromEntries(
	(
		Object.entries(BROKERED_CREDENTIALS) as Array<
			[BrokeredCredentialId, { environmentKey: string }]
		>
	).map(([id, descriptor]) => [descriptor.environmentKey, id]),
) as Record<string, BrokeredCredentialId>;

function minimalEnvironment(): NodeJS.ProcessEnv {
	return {
		...(process.env.HOME ? { HOME: process.env.HOME } : {}),
		...(process.env.PATH
			? { PATH: process.env.PATH }
			: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
	};
}

function safeSecret(value: string, source: string): string {
	const clean = value.trim();
	if (clean.length < 8 || clean.length > 20_000 || /[\r\n\0]/.test(clean)) {
		throw new Error(
			`${source} returned an empty or invalid provider credential.`,
		);
	}
	return clean;
}

export function safeExternalSecretArchiveEntries(stdout: string): string[] {
	const entries = stdout
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length !== 1 || entries[0] !== BWS_MANIFEST.binaryPath) {
		throw new Error("The Bitwarden archive has an unexpected file list.");
	}
	return entries;
}

function validateConfiguration(
	configuration: ExternalSecretConfiguration,
): ExternalSecretConfiguration {
	const parsed = ExternalSecretConfigurationSchema.parse(configuration);
	if (
		parsed.onepassword.binaryPath &&
		!isAbsolute(parsed.onepassword.binaryPath)
	) {
		throw new Error("The 1Password binary path must be absolute.");
	}
	if (
		parsed.onepassword.account &&
		!/^[A-Za-z0-9.-]+$/.test(parsed.onepassword.account)
	) {
		throw new Error(
			"The 1Password account must be an account shorthand or sign-in host.",
		);
	}
	for (const reference of Object.values(parsed.onepassword.mappings)) {
		if (!/^op:\/\/[^/\s]+\/[^/\s]+\/[^\r\n\0]+$/.test(reference)) {
			throw new Error(
				"Every 1Password mapping must use op://vault/item/field.",
			);
		}
	}
	if (parsed.bitwarden.binaryPath && !isAbsolute(parsed.bitwarden.binaryPath)) {
		throw new Error("The Bitwarden binary path must be absolute.");
	}
	if (
		parsed.bitwarden.projectId &&
		!/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/i.test(parsed.bitwarden.projectId)
	) {
		throw new Error("The Bitwarden project ID must be a UUID.");
	}
	if (parsed.bitwarden.serverUrl) {
		let server: URL;
		try {
			server = new URL(parsed.bitwarden.serverUrl);
		} catch {
			throw new Error(
				"The Bitwarden server must be a credential-free HTTPS URL.",
			);
		}
		if (
			server.protocol !== "https:" ||
			server.username ||
			server.password ||
			server.hash
		) {
			throw new Error(
				"The Bitwarden server must be a credential-free HTTPS URL.",
			);
		}
	}
	if (
		parsed.command.executablePath &&
		!isAbsolute(parsed.command.executablePath)
	) {
		throw new Error("The command helper executable path must be absolute.");
	}
	for (const argument of parsed.command.arguments) {
		if (!argument || /[\r\n\0]/.test(argument))
			throw new Error(
				"Command helper arguments must be non-empty single-line values.",
			);
	}
	return parsed;
}

function validateBootstrapToken(value: string, label: string): string {
	const clean = value.trim();
	if (clean.length < 8 || clean.length > 20_000 || /[\r\n\0]/.test(clean))
		throw new Error(`${label} is invalid.`);
	return clean;
}

export class ExternalSecretManager {
	private readonly fetcher: typeof fetch;
	private readonly execute: NonNullable<
		ExternalSecretManagerDependencies["execute"]
	>;
	private readonly now: () => Date;
	private readonly currentPlatform: NodeJS.Platform;
	private readonly currentArchitecture: string;
	private readonly statusPath: string;

	constructor(
		private readonly root: string,
		private readonly broker: CredentialBroker,
		dependencies: ExternalSecretManagerDependencies = {},
	) {
		this.fetcher = dependencies.fetch ?? fetch;
		this.execute =
			dependencies.execute ??
			(async (file, args, options) => {
				try {
					const result = await execFileAsync(file, args, {
						env: options.env,
						timeout: options.timeoutMs,
						maxBuffer: options.maxBuffer,
						encoding: "utf8",
						windowsHide: true,
						killSignal: "SIGKILL",
					});
					return { stdout: result.stdout };
				} catch {
					throw new Error(
						"The secret-source process failed, timed out, or requires authentication.",
					);
				}
			});
		this.now = dependencies.now ?? (() => new Date());
		this.currentPlatform = dependencies.platform ?? process.platform;
		this.currentArchitecture = dependencies.architecture ?? process.arch;
		this.statusPath = join(root, "secure", "external-secret-status.json");
	}

	async configuration(): Promise<ExternalSecretConfiguration> {
		const stored = await this.broker.getOpaqueSecret(CONFIGURATION_SECRET_ID);
		if (!stored) return structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		try {
			return validateConfiguration(
				JSON.parse(stored) as ExternalSecretConfiguration,
			);
		} catch {
			throw new Error(
				"The encrypted external-secret configuration is invalid.",
			);
		}
	}

	async save(
		configuration: ExternalSecretConfiguration,
		tokens: { onePasswordToken?: string; bitwardenToken?: string } = {},
	): Promise<void> {
		const normalized = validateConfiguration(configuration);
		let writeAttempted = false;
		try {
			if (tokens.onePasswordToken) {
				writeAttempted = true;
				await this.broker.setOpaqueSecret(
					ONEPASSWORD_TOKEN_SECRET_ID,
					validateBootstrapToken(
						tokens.onePasswordToken,
						"The 1Password service-account token",
					),
				);
			}
			if (tokens.bitwardenToken) {
				writeAttempted = true;
				await this.broker.setOpaqueSecret(
					BITWARDEN_TOKEN_SECRET_ID,
					validateBootstrapToken(
						tokens.bitwardenToken,
						"The Bitwarden machine-account token",
					),
				);
			}
			writeAttempted = true;
			await this.broker.setOpaqueSecret(
				CONFIGURATION_SECRET_ID,
				JSON.stringify(normalized),
			);
		} finally {
			if (writeAttempted) await this.invalidateVerification();
		}
	}

	async invalidateVerification(): Promise<void> {
		await this.updateVerification((verification) => {
			for (const providerId of PROVIDER_IDS) delete verification[providerId];
		});
	}

	async remove(providerId: ExternalSecretProviderId): Promise<void> {
		const configuration = await this.configuration();
		const next = structuredClone(configuration);
		next[providerId] = structuredClone(
			DEFAULT_EXTERNAL_SECRET_CONFIGURATION[providerId],
		) as never;
		await this.broker.setOpaqueSecret(
			CONFIGURATION_SECRET_ID,
			JSON.stringify(next),
		);
		if (providerId === "onepassword")
			await this.broker.removeOpaqueSecret(ONEPASSWORD_TOKEN_SECRET_ID);
		if (providerId === "bitwarden")
			await this.broker.removeOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID);
		await this.invalidateVerification();
	}

	async status(): Promise<{
		configuration: ExternalSecretConfiguration;
		sources: ExternalSecretProviderStatus[];
	}> {
		const configuration = await this.configuration();
		const verification = await this.readVerification();
		const onePasswordBinary = await this.resolveKnownBinary(
			configuration.onepassword.binaryPath,
			"op",
		);
		const bitwardenBinary = await this.resolveKnownBinary(
			configuration.bitwarden.binaryPath,
			"bws",
		);
		const commandBinary = await this.resolveExplicitBinary(
			configuration.command.executablePath,
		);
		const managedBinary = await this.hasManagedBitwarden();
		const hasOnePasswordToken = Boolean(
			await this.broker.getOpaqueSecret(ONEPASSWORD_TOKEN_SECRET_ID),
		);
		const hasBitwardenToken = Boolean(
			await this.broker.getOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID),
		);
		return {
			configuration,
			sources: [
				this.sourceStatus(
					"onepassword",
					configuration.onepassword.enabled,
					Boolean(onePasswordBinary),
					false,
					onePasswordBinary,
					verification.onepassword,
					Object.keys(configuration.onepassword.mappings).length > 0,
					"Install and sign in to the official 1Password CLI, then add at least one op:// mapping.",
					hasOnePasswordToken
						? "Configured with an encrypted service-account token."
						: "Configured for the 1Password desktop or CLI session.",
				),
				this.sourceStatus(
					"bitwarden",
					configuration.bitwarden.enabled,
					Boolean(bitwardenBinary),
					managedBinary,
					bitwardenBinary,
					verification.bitwarden,
					Boolean(configuration.bitwarden.projectId && hasBitwardenToken),
					"Add a machine-account token and project ID. Kestrel can install the verified bws CLI.",
					"Configured; sync to verify the project and supported secret names.",
				),
				this.sourceStatus(
					"command",
					configuration.command.enabled,
					Boolean(commandBinary),
					false,
					commandBinary,
					verification.command,
					Boolean(commandBinary),
					"Choose an executable helper that prints supported KEY=VALUE records.",
					"Configured for argv-only execution; sync to verify its output.",
				),
			],
		};
	}

	async resolveEnabled(): Promise<ResolvedExternalCredentials> {
		const configuration = await this.configuration();
		const values: Partial<Record<BrokeredCredentialId, string>> = {};
		const overrideStoredIds: BrokeredCredentialId[] = [];
		const providers = ["onepassword", "bitwarden", "command"] as const;

		const results = await Promise.all(
			providers.map(async (providerId) => {
				if (!configuration[providerId].enabled) {
					return { providerId, enabled: false };
				}
				try {
					const sourceValues = await this.resolveSource(
						providerId,
						configuration,
					);
					return { providerId, enabled: true, sourceValues, error: undefined };
				} catch (error) {
					return { providerId, enabled: true, sourceValues: undefined, error };
				}
			}),
		);

		for (const result of results) {
			if (!result.enabled) continue;
			const providerId = result.providerId;
			if (result.error) {
				await this.recordVerification(
					providerId,
					"error",
					[],
					result.error instanceof Error
						? result.error.message
						: "Secret source failed.",
				);
			} else if (result.sourceValues) {
				const sourceValues = Object.fromEntries(
					Object.entries(result.sourceValues).filter(([id, value]) =>
						CREDENTIAL_IDS.has(id) && typeof value === "string" && value.trim().length > 0,
					),
				) as Partial<Record<BrokeredCredentialId, string>>;
				if (Object.keys(sourceValues).length === 0) {
					await this.recordVerification(
						providerId,
						"error",
						[],
						"Secret source returned no supported credentials.",
					);
					continue;
				}
				for (const [id, value] of Object.entries(sourceValues) as Array<
					[BrokeredCredentialId, string]
				>) {
					if (values[id]) continue;
					values[id] = value;
					if (configuration[providerId].overrideStored)
						overrideStoredIds.push(id);
				}
				await this.recordVerification(
					providerId,
					"verified",
					Object.keys(sourceValues) as BrokeredCredentialId[],
					"Supported provider credentials resolved.",
				);
			}
		}

		return { values, overrideStoredIds };
	}

	async sync(
		providerId: ExternalSecretProviderId,
	): Promise<ExternalSecretProviderStatus[]> {
		const configuration = await this.configuration();
		if (!configuration[providerId].enabled)
			throw new Error("Enable this secret source before syncing it.");
		try {
			const values = await this.resolveSource(providerId, configuration);
			const ids = Object.keys(values) as BrokeredCredentialId[];
			if (ids.length === 0)
				throw new Error(
					"The secret source returned no supported provider credentials.",
				);
			await this.recordVerification(
				providerId,
				"verified",
				ids,
				`${ids.length} supported credentials resolved.`,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Secret source failed.";
			await this.recordVerification(providerId, "error", [], message);
			throw new Error(message);
		}
		return (await this.status()).sources;
	}

	async installBitwarden(): Promise<ExternalSecretProviderStatus[]> {
		if (
			!["arm64", "x64"].includes(this.currentArchitecture) ||
			this.currentPlatform !== "darwin"
		) {
			throw new Error(
				"Managed Bitwarden CLI installation is available only on supported macOS builds.",
			);
		}
		if (!(await this.hasManagedBitwarden())) await this.downloadBitwarden(true);
		const configuration = await this.configuration();
		configuration.bitwarden.binaryPath = this.managedBitwardenPath();
		await this.broker.setOpaqueSecret(
			CONFIGURATION_SECRET_ID,
			JSON.stringify(configuration),
		);
		await this.invalidateVerification();
		return (await this.status()).sources;
	}

	private sourceStatus(
		id: ExternalSecretProviderId,
		enabled: boolean,
		available: boolean,
		managedBinary: boolean,
		binaryPath: string | undefined,
		verification: SourceVerification | undefined,
		setupComplete: boolean,
		setupDetail: string,
		readyDetail: string,
	): ExternalSecretProviderStatus {
		const label =
			id === "onepassword"
				? "1Password"
				: id === "bitwarden"
					? "Bitwarden Secrets Manager"
					: "Command helper";
		if (!enabled)
			return {
				id,
				label,
				state: "disabled",
				available,
				managedBinary,
				detail: "Disabled; saved configuration is not resolved at startup.",
				resolvedCredentialIds: [],
				...(binaryPath ? { binaryPath } : {}),
			};
		if (!available || !setupComplete)
			return {
				id,
				label,
				state: "needs_setup",
				available,
				managedBinary,
				detail: setupDetail,
				resolvedCredentialIds: [],
				...(binaryPath ? { binaryPath } : {}),
			};
		if (verification) {
			return {
				id,
				label,
				state: verification.state,
				available,
				managedBinary,
				detail: verification.detail,
				resolvedCredentialIds: verification.resolvedCredentialIds,
				lastSyncedAt: verification.lastSyncedAt,
				...(binaryPath ? { binaryPath } : {}),
			};
		}
		return {
			id,
			label,
			state: "ready",
			available,
			managedBinary,
			detail: readyDetail,
			resolvedCredentialIds: [],
			...(binaryPath ? { binaryPath } : {}),
		};
	}

	private async resolveSource(
		providerId: ExternalSecretProviderId,
		configuration: ExternalSecretConfiguration,
	): Promise<Partial<Record<BrokeredCredentialId, string>>> {
		if (providerId === "onepassword")
			return this.resolveOnePassword(configuration);
		if (providerId === "bitwarden") return this.resolveBitwarden(configuration);
		return this.resolveCommand(configuration);
	}

	private async resolveOnePassword(
		configuration: ExternalSecretConfiguration,
	): Promise<Partial<Record<BrokeredCredentialId, string>>> {
		const binary = await this.resolveKnownBinary(
			configuration.onepassword.binaryPath,
			"op",
		);
		if (!binary)
			throw new Error(
				"The official 1Password CLI is unavailable. Install it or set an absolute binary path.",
			);
		const mappings = Object.entries(
			configuration.onepassword.mappings,
		) as Array<[BrokeredCredentialId, string]>;
		if (mappings.length === 0)
			throw new Error("Add at least one 1Password credential mapping.");
		const environment = minimalEnvironment();
		for (const [key, value] of Object.entries(process.env)) {
			if (/^OP_SESSION_[A-Z0-9_]+$/.test(key) && value)
				environment[key] = value;
		}
		const token = await this.broker.getOpaqueSecret(
			ONEPASSWORD_TOKEN_SECRET_ID,
		);
		if (token) environment.OP_SERVICE_ACCOUNT_TOKEN = token;
		const values: Partial<Record<BrokeredCredentialId, string>> = {};
		await Promise.all(
			mappings.map(async ([id, reference]) => {
				const args = [
					"read",
					reference,
					"--no-newline",
					...(configuration.onepassword.account
						? ["--account", configuration.onepassword.account]
						: []),
				];
				const result = await this.runSecretProcess(
					binary,
					args,
					{ env: environment, timeoutMs: 5_000, maxBuffer: 24_000 },
					"1Password",
				);
				values[id] = safeSecret(result.stdout, "1Password");
			}),
		);
		return values;
	}

	private async resolveBitwarden(
		configuration: ExternalSecretConfiguration,
	): Promise<Partial<Record<BrokeredCredentialId, string>>> {
		let binary = await this.resolveKnownBinary(
			configuration.bitwarden.binaryPath,
			"bws",
		);
		if (!binary && configuration.bitwarden.autoInstall) {
			await this.downloadBitwarden();
			configuration.bitwarden.binaryPath = this.managedBitwardenPath();
			await this.broker.setOpaqueSecret(
				CONFIGURATION_SECRET_ID,
				JSON.stringify(configuration),
			);
			await this.invalidateVerification();
			binary = this.managedBitwardenPath();
		}
		if (!binary)
			throw new Error(
				"The Bitwarden Secrets Manager CLI is unavailable. Install the verified binary or set an absolute path.",
			);
		if (!configuration.bitwarden.projectId)
			throw new Error("Add the Bitwarden Secrets Manager project ID.");
		const token = await this.broker.getOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID);
		if (!token)
			throw new Error("Add the Bitwarden machine-account access token.");
		const environment = minimalEnvironment();
		environment.BWS_ACCESS_TOKEN = token;
		if (configuration.bitwarden.serverUrl)
			environment.BWS_SERVER_URL = configuration.bitwarden.serverUrl;
		const result = await this.runSecretProcess(
			binary,
			["secret", "list", configuration.bitwarden.projectId, "--output", "json"],
			{ env: environment, timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
			"Bitwarden",
		);
		let payload: unknown;
		try {
			payload = JSON.parse(result.stdout);
		} catch {
			throw new Error("Bitwarden returned invalid JSON.");
		}
		if (!Array.isArray(payload))
			throw new Error("Bitwarden returned an invalid secret list.");
		const values: Partial<Record<BrokeredCredentialId, string>> = {};
		for (const item of payload) {
			if (!item || typeof item !== "object") continue;
			const key = (item as { key?: unknown }).key;
			const value = (item as { value?: unknown }).value;
			if (typeof key !== "string" || typeof value !== "string") continue;
			const id = environmentToCredential[key];
			if (!id) continue;
			if (values[id])
				throw new Error(`Bitwarden returned duplicate ${key} entries.`);
			values[id] = safeSecret(value, "Bitwarden");
		}
		return values;
	}

	private async resolveCommand(
		configuration: ExternalSecretConfiguration,
	): Promise<Partial<Record<BrokeredCredentialId, string>>> {
		const binary = await this.resolveExplicitBinary(
			configuration.command.executablePath,
		);
		if (!binary) throw new Error("Choose an executable command helper.");
		const result = await this.runSecretProcess(
			binary,
			configuration.command.arguments,
			{
				env: minimalEnvironment(),
				timeoutMs: configuration.command.timeoutMs,
				maxBuffer: 1024 * 1024,
			},
			"The command helper",
		);
		const values: Partial<Record<BrokeredCredentialId, string>> = {};
		for (const rawLine of result.stdout.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
			if (!match)
				throw new Error("The command helper output was not a KEY=VALUE map.");
			const id = environmentToCredential[match[1]!];
			if (!id) continue;
			let value = match[2]!.trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			)
				value = value.slice(1, -1);
			if (!value.trim()) continue;
			if (values[id])
				throw new Error(
					`The command helper returned duplicate ${match[1]} entries.`,
				);
			values[id] = safeSecret(value, "The command helper");
		}
		return values;
	}

	private async resolveKnownBinary(
		configured: string | undefined,
		name: "op" | "bws",
	): Promise<string | undefined> {
		if (configured) {
			if (name === "bws" && configured === this.managedBitwardenPath() &&
				!(await this.hasManagedBitwarden())) return undefined;
			return this.resolveExplicitBinary(configured);
		}
		const home = process.env.HOME;
		const candidates =
			name === "op"
				? [
						"/opt/homebrew/bin/op",
						"/usr/local/bin/op",
						home ? join(home, ".local", "bin", "op") : undefined,
					]
				: [
						this.managedBitwardenPath(),
						"/opt/homebrew/bin/bws",
						"/usr/local/bin/bws",
						home ? join(home, ".local", "bin", "bws") : undefined,
					];
		for (const candidate of candidates) {
			if (!candidate) continue;
			if (name === "bws" && candidate === this.managedBitwardenPath() &&
				!(await this.hasManagedBitwarden())) continue;
			const resolved = await this.resolveExplicitBinary(candidate);
			if (resolved) return resolved;
		}
		return undefined;
	}

	private async resolveExplicitBinary(
		path: string | undefined,
	): Promise<string | undefined> {
		if (!path || !isAbsolute(path)) return undefined;
		try {
			const resolved = await realpath(path);
			if (resolved === this.managedBitwardenPath() && !(await this.hasManagedBitwarden()))
				return undefined;
			const metadata = await lstat(resolved);
			return metadata.isFile() && (metadata.mode & 0o111) !== 0
				? resolved
				: undefined;
		} catch {
			return undefined;
		}
	}

	private managedBitwardenRoot(): string {
		return join(this.root, "managed-tools", "bws", BWS_MANIFEST.version);
	}

	private managedBitwardenPath(): string {
		return join(this.managedBitwardenRoot(), BWS_MANIFEST.binaryPath);
	}

	private async hasManagedBitwarden(): Promise<boolean> {
		try {
			const root = await lstat(this.managedBitwardenRoot(), { bigint: true });
			if (!root.isDirectory() || root.isSymbolicLink() ||
				(Number(root.mode) & 0o7777) !== 0o700 ||
				(typeof process.getuid === "function" && Number(root.uid) !== process.getuid())) return false;
			const markerPath = join(this.managedBitwardenRoot(), "workstrand-install.json");
			const markerBytes = await readPrivateFile(markerPath, 0o600, BITWARDEN_MANIFEST_MAX_BYTES);
			const marker = JSON.parse(markerBytes.toString("utf8")) as Record<string, unknown>;
			const binary = await hashPrivateFile(this.managedBitwardenPath(), 0o700);
			return (
				marker.version === BWS_MANIFEST.version &&
				marker.sha256 === BWS_MANIFEST.sha256 &&
				marker.binarySha256 === binary.sha256 &&
				marker.binaryBytes === binary.bytes
			);
		} catch {
			return false;
		}
	}

	private async downloadBitwarden(preserveExisting = false): Promise<void> {
		const parent = dirname(this.managedBitwardenRoot());
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const parentStat = await lstat(parent, { bigint: true });
		const parentIdentity = directoryIdentity(parentStat);
		const canonicalParent = join(await realpath(this.root), "managed-tools", "bws");
		if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
			(typeof process.getuid === "function" && Number(parentStat.uid) !== process.getuid()) ||
			(Number(parentStat.mode) & 0o077) !== 0 || await realpath(parent) !== canonicalParent)
			throw new Error("The managed Bitwarden CLI destination is unsafe.");
		const staging = join(parent, `.bws-install-${randomUUID()}`);
		const archive = join(staging, BWS_MANIFEST.fileName);
		await mkdir(staging, { mode: 0o700 });
		const stagingStat = await lstat(staging, { bigint: true });
		const stagingIdentity = directoryIdentity(stagingStat);
		if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink() ||
			(typeof process.getuid === "function" && Number(stagingStat.uid) !== process.getuid()) ||
			(Number(stagingStat.mode) & 0o7777) !== 0o700)
			throw new Error("The managed Bitwarden CLI staging directory is unsafe.");
		try {
			const response = await this.fetcher(BWS_MANIFEST.url, {
				redirect: "follow",
				signal: AbortSignal.timeout(120_000),
			});
			if (!response.ok || !response.body)
				throw new Error(
					`The Bitwarden CLI download returned ${response.status}.`,
				);
			let finalUrl: URL;
			try {
				finalUrl = new URL(response.url || BWS_MANIFEST.url);
			} catch {
				throw new Error(
					"The Bitwarden CLI download redirected to an untrusted host.",
				);
			}
			if (
				finalUrl.protocol !== "https:" ||
				![
					"github.com",
					"objects.githubusercontent.com",
					"release-assets.githubusercontent.com",
				].includes(finalUrl.hostname)
			) {
				throw new Error(
					"The Bitwarden CLI download redirected to an untrusted host.",
				);
			}
			const file = await open(archive, "wx", 0o600);
			const digest = createHash("sha256");
			let bytes = 0;
			try {
				const reader = response.body.getReader();
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > BWS_MANIFEST.bytes)
						throw new Error(
							"The Bitwarden CLI download exceeded the pinned size.",
						);
					digest.update(chunk.value);
						let offset = 0;
						while (offset < chunk.value.byteLength) {
							const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.byteLength - offset, null);
							if (bytesWritten <= 0) throw new Error("The Bitwarden CLI download could not be saved.");
							offset += bytesWritten;
						}
				}
			} finally {
					try { await file.sync(); }
					finally { await file.close(); }
			}
			if (
				bytes !== BWS_MANIFEST.bytes ||
				digest.digest("hex") !== BWS_MANIFEST.sha256
			) {
				throw new Error(
					"The Bitwarden CLI download did not match the pinned release manifest.",
				);
			}
			safeExternalSecretArchiveEntries(
				(
					await this.execute("/usr/bin/tar", ["-tf", archive], {
						env: minimalEnvironment(),
						timeoutMs: 10_000,
						maxBuffer: 64_000,
					})
				).stdout,
			);
			await this.execute("/usr/bin/tar", ["-xf", archive, "-C", staging], {
				env: minimalEnvironment(),
				timeoutMs: 20_000,
				maxBuffer: 64_000,
			});
			const stagedBinary = join(staging, BWS_MANIFEST.binaryPath);
			const binary = await lstat(stagedBinary, { bigint: true });
			if (!binary.isFile() || binary.isSymbolicLink() || Number(binary.nlink) !== 1 ||
				(typeof process.getuid === "function" && Number(binary.uid) !== process.getuid()))
				throw new Error("The extracted Bitwarden CLI executable is invalid.");
			await chmod(stagedBinary, 0o700);
			const version = await this.execute(
				stagedBinary,
				["--version"],
				{ env: minimalEnvironment(), timeoutMs: 5_000, maxBuffer: 10_000 },
			);
			if (
				!new RegExp(
					`\\b${BWS_MANIFEST.version.replaceAll(".", "\\.")}\\b`,
				).test(version.stdout)
			)
				throw new Error(
					"The installed Bitwarden CLI reported an unexpected version.",
				);
			const parentNow = directoryIdentity(await lstat(parent, { bigint: true }));
			const stageNow = directoryIdentity(await lstat(staging, { bigint: true }));
			if (!sameDirectoryIdentity(parentIdentity, parentNow) ||
				!sameDirectoryIdentity(stagingIdentity, stageNow))
				throw new Error("The managed Bitwarden CLI staging directory changed.");
			await publishPrivateManagedBitwardenDirectory({
				sourceBinary: stagedBinary,
				finalDirectory: this.managedBitwardenRoot(),
				marker: {
					tool: "bws",
					version: BWS_MANIFEST.version,
					source: BWS_MANIFEST.url,
					sha256: BWS_MANIFEST.sha256,
					bytes: BWS_MANIFEST.bytes,
					installedAt: this.now().toISOString(),
				},
				preserveExisting,
			});
		} catch {
			// Keep the unique private staging directory for safe recovery and diagnosis.
			// Its contents are never recursively removed because ownership may have changed.
			throw new Error("The Bitwarden CLI could not be installed safely.");
		}
	}

	private async inspectVerificationDirectory(
		create: boolean,
	): Promise<PrivateDirectoryIdentity | undefined> {
		const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
		let rootStat: BigIntStats;
		try {
			rootStat = await lstat(this.root, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error("Secret-source verification storage is unavailable.");
		}
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
			(owner !== undefined && Number(rootStat.uid) !== owner))
			throw new Error("Secret-source verification storage is unsafe.");

		const securePath = join(this.root, "secure");
		let secureStat: BigIntStats;
		try {
			secureStat = await lstat(securePath, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw new Error("Secret-source verification storage is unavailable.");
			}
			try {
				await mkdir(securePath, { mode: 0o700 });
			} catch {
				throw new Error("Secret-source verification storage is unsafe.");
			}
			secureStat = await lstat(securePath, { bigint: true });
		}
		if (!secureStat.isDirectory() || secureStat.isSymbolicLink() ||
			(owner !== undefined && Number(secureStat.uid) !== owner) ||
			(Number(secureStat.mode) & 0o077) !== 0)
			throw new Error("Secret-source verification storage is unsafe.");
		return directoryIdentity(secureStat);
	}

	private async readVerificationSnapshot(
		createDirectory = false,
	): Promise<VerificationSnapshot> {
		let directory: PrivateDirectoryIdentity | undefined;
		try {
			directory = await this.inspectVerificationDirectory(createDirectory);
		} catch {
			return { verification: {}, valid: false };
		}
		if (!directory) return { verification: {}, valid: true };
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(
				this.statusPath,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { verification: {}, valid: true, directory };
			return { verification: {}, valid: false };
		}
		try {
			const before = await handle.stat({ bigint: true });
			const beforeIdentity = fileIdentity(before);
			const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (!before.isFile() || before.isSymbolicLink() || beforeIdentity.nlink !== 1 ||
				(owner !== undefined && Number(beforeIdentity.uid) !== owner) ||
				beforeIdentity.mode !== 0o600 || beforeIdentity.size > VERIFICATION_MAX_BYTES)
				return { verification: {}, valid: false };
			const chunks: Buffer[] = [];
			let total = 0;
			while (total <= VERIFICATION_MAX_BYTES) {
				const buffer = Buffer.alloc(Math.min(8192, VERIFICATION_MAX_BYTES + 1 - total));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				total += bytesRead;
				if (total > VERIFICATION_MAX_BYTES)
					return { verification: {}, valid: false };
				chunks.push(buffer.subarray(0, bytesRead));
			}
			const after = fileIdentity(await handle.stat({ bigint: true }));
			const pathStat = await lstat(this.statusPath, { bigint: true });
			const parentStat = await lstat(join(this.root, "secure"), { bigint: true });
			if (!sameFileIdentity(beforeIdentity, after) || total !== beforeIdentity.size ||
				!pathStat.isFile() || pathStat.isSymbolicLink() ||
				!sameFileIdentity(beforeIdentity, fileIdentity(pathStat)) ||
				!sameDirectoryIdentity(directory, directoryIdentity(parentStat)))
				return { verification: {}, valid: false };
			const parsed = parseVerificationState(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			return parsed
				? { verification: parsed, valid: true, directory, file: beforeIdentity }
				: { verification: {}, valid: false };
		} catch {
			return { verification: {}, valid: false };
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	private async readVerification(): Promise<VerificationState> {
		return (await this.readVerificationSnapshot()).verification;
	}

	private async runSecretProcess(
		file: string,
		args: string[],
		options: ExecutionOptions,
		label: string,
	): Promise<{ stdout: string }> {
		try {
			return await this.execute(file, args, options);
		} catch {
			throw new Error(
				`${label} failed, timed out, or requires authentication.`,
			);
		}
	}

	private async writeVerification(
		verification: VerificationState,
		expected: VerificationSnapshot,
	): Promise<void> {
		if (!expected.valid || !expected.directory)
			throw new Error("Secret-source verification storage is unsafe.");
		const directoryPath = join(this.root, "secure");
		const tempPath = join(directoryPath, `.external-secret-status.${randomUUID()}.new`);
		let tempIdentity: PrivateFileIdentity | undefined;
		let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const currentDirectory = await this.inspectVerificationDirectory(false);
			if (!currentDirectory || !sameDirectoryIdentity(expected.directory, currentDirectory))
				throw new Error("Secret-source verification storage changed.");
			const currentTarget = await this.readVerificationSnapshot();
			if (!currentTarget.valid ||
				(expected.file
					? !currentTarget.file || !sameFileIdentity(expected.file, currentTarget.file)
					: Boolean(currentTarget.file)))
				throw new Error("Secret-source verification record changed.");
			tempHandle = await open(
				tempPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
					(constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			tempIdentity = fileIdentity(await tempHandle.stat({ bigint: true }));
			const contents = Buffer.from(`${JSON.stringify(verification, null, 2)}\n`, "utf8");
			if (contents.byteLength > VERIFICATION_MAX_BYTES)
				throw new Error("Secret-source verification record exceeds its limit.");
			await tempHandle.writeFile(contents);
			await tempHandle.sync();
			const settledIdentity = fileIdentity(await tempHandle.stat({ bigint: true }));
			if (settledIdentity.dev !== tempIdentity.dev || settledIdentity.ino !== tempIdentity.ino ||
				settledIdentity.uid !== tempIdentity.uid || settledIdentity.nlink !== 1 ||
				settledIdentity.mode !== 0o600 || settledIdentity.size !== contents.byteLength)
				throw new Error("Secret-source verification record changed.");
			await tempHandle.close();
			tempHandle = undefined;
			const latestDirectory = await this.inspectVerificationDirectory(false);
			if (!latestDirectory || !sameDirectoryIdentity(expected.directory, latestDirectory))
				throw new Error("Secret-source verification storage changed.");
			const latestTarget = await this.readVerificationSnapshot();
			if (!latestTarget.valid ||
				(expected.file
					? !latestTarget.file || !sameFileIdentity(expected.file, latestTarget.file)
					: Boolean(latestTarget.file)))
				throw new Error("Secret-source verification record changed.");
			await rename(tempPath, this.statusPath);
			const directoryHandle = await open(
				directoryPath,
				constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
			);
			try {
				const committedDirectory = directoryIdentity(await directoryHandle.stat({ bigint: true }));
				if (!sameDirectoryIdentity(expected.directory, committedDirectory))
					throw new Error("Secret-source verification storage changed.");
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} finally {
			await tempHandle?.close().catch(() => undefined);
			if (tempIdentity) {
				try {
					const current = fileIdentity(await lstat(tempPath, { bigint: true }));
					if (current.dev === tempIdentity.dev && current.ino === tempIdentity.ino)
						await rm(tempPath, { force: true });
				} catch {
					// A missing or replaced temporary entry is not ours to remove.
				}
			}
		}
	}

	private async updateVerification(
		update: (verification: VerificationState) => void,
	): Promise<void> {
		const previous =
			verificationQueues.get(this.statusPath) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.catch(() => undefined).then(() => current);
		verificationQueues.set(this.statusPath, queued);
		await previous.catch(() => undefined);
		try {
			const snapshot = await this.readVerificationSnapshot(true);
			if (!snapshot.valid)
				throw new Error("Secret-source verification storage is unsafe.");
			const verification = snapshot.verification;
			update(verification);
			await this.writeVerification(verification, snapshot);
		} finally {
			release();
			if (verificationQueues.get(this.statusPath) === queued)
				verificationQueues.delete(this.statusPath);
		}
	}

	private async recordVerification(
		providerId: ExternalSecretProviderId,
		state: SourceVerification["state"],
		resolvedCredentialIds: BrokeredCredentialId[],
		detail: string,
	): Promise<void> {
		void detail;
		await this.updateVerification((verification) => {
			verification[providerId] = {
				state,
				detail: verificationDetail(state),
				resolvedCredentialIds,
				lastSyncedAt: this.now().toISOString(),
			};
		});
	}
}
