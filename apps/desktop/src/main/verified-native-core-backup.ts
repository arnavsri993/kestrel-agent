import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export type VerifiedNativeCoreBackup = {
	path: string;
	createdAt: string;
	files: number;
	bytes: number;
	verified: true;
};

export type VerifiedNativeCoreBackupLimits = {
	maxEntries: number;
	maxFiles: number;
	maxBytes: number;
	maxDepth: number;
	maxTreeEntries: number;
};

export type VerifiedNativeCoreBackupOptions = {
	sourceRoot: string;
	destinationParent: string;
	forbiddenDestinationRoots: readonly string[];
	entries: readonly string[];
	selectedChildren?: Readonly<Record<string, readonly string[]>>;
	appVersion: string;
	signal?: AbortSignal;
	limits?: Partial<VerifiedNativeCoreBackupLimits>;
	publishDirectory: (
		stagingPath: string,
		finalPath: string,
		identity: { parentDev: string; parentIno: string; stagingDev: string; stagingIno: string },
	) => Promise<void>;
};

export class VerifiedNativeCoreBackupError extends Error {
	constructor(readonly code: "cancelled" | "unsafe" | "failed" | "committedSyncUncertain") {
		super(code === "cancelled" ? "Native Core backup was cancelled. A private incomplete staging directory may remain." : code === "committedSyncUncertain" ? "Native core backup was published, but directory synchronization could not be confirmed." : "Native Core backup could not be verified safely. Private incomplete staging files may remain.");
		this.name = "VerifiedNativeCoreBackupError";
	}
}

const DEFAULT_LIMITS: VerifiedNativeCoreBackupLimits = {
	maxEntries: 256,
	maxFiles: 100_000,
	maxBytes: 16 * 1024 * 1024 * 1024,
	maxDepth: 32,
	maxTreeEntries: 200_000,
};
const MANIFEST_NAME = "kestrel-native-core-backup.json";
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type TreeItem = {
	rel: string;
	type: "directory" | "file";
	dev: bigint;
	ino: bigint;
	mode: bigint;
	uid: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
};
type CopiedFile = { path: string; size: number; sha256: string };
type TreeSnapshot = { items: Map<string, TreeItem>; absent: Set<string> };

const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const isOwner = (s: BigIntStats) => typeof process.getuid !== "function" || s.uid === BigInt(process.getuid());
const snapshotItem = (rel: string, stat: BigIntStats): TreeItem => ({
	rel,
	type: stat.isDirectory() ? "directory" : "file",
	dev: stat.dev,
	ino: stat.ino,
	mode: stat.mode,
	uid: stat.uid,
	nlink: stat.nlink,
	size: stat.size,
	mtimeNs: stat.mtimeNs,
	ctimeNs: stat.ctimeNs,
});
const sameItem = (a: TreeItem, b: TreeItem) => a.rel === b.rel && a.type === b.type && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new VerifiedNativeCoreBackupError("cancelled");
}
function checkedName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}
function inside(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function privateOwnedDirectory(stat: BigIntStats): boolean {
	return stat.isDirectory() && isOwner(stat) && (stat.mode & 0o077n) === 0n;
}
function ownedDirectory(stat: BigIntStats): boolean {
	return stat.isDirectory() && isOwner(stat);
}
function regularOwnedFile(stat: BigIntStats): boolean {
	return stat.isFile() && isOwner(stat) && stat.nlink === 1n;
}
function recordTreeItem(map: Map<string, TreeItem>, rel: string, stat: BigIntStats, limits: VerifiedNativeCoreBackupLimits): void {
	if (!isOwner(stat) || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("unsafe source item");
	if (stat.isFile() && stat.nlink !== 1n) throw new Error("linked source file");
	if (map.size >= limits.maxTreeEntries) throw new Error("source tree too large");
	map.set(rel, snapshotItem(rel, stat));
}

async function snapshotTree(rootPath: string, limits: VerifiedNativeCoreBackupLimits, signal?: AbortSignal, selectedRoots?: readonly string[], selectedChildren?: Readonly<Record<string, readonly string[]>>): Promise<TreeSnapshot> {
	const map = new Map<string, TreeItem>();
	const absent = new Set<string>();
	const rootHandle = await open(rootPath, DIR_FLAGS);
	try {
		const rootStat = await rootHandle.stat({ bigint: true });
		const rootNamed = await lstat(rootPath, { bigint: true });
		if (!privateOwnedDirectory(rootStat) || !identity(rootStat, rootNamed)) throw new Error("source root is not private");
		map.set("", snapshotItem("", rootStat));
		const visit = async (dirPath: string, rel: string, depth: number): Promise<void> => {
			checkAbort(signal);
			if (depth > limits.maxDepth) throw new Error("source depth exceeded");
			const dir = await open(dirPath, DIR_FLAGS);
			try {
				const held = await dir.stat({ bigint: true });
				const named = await lstat(dirPath, { bigint: true });
				if (!held.isDirectory() || !identity(held, named) || !ownedDirectory(held)) throw new Error("source directory changed");
				const names = await readdir(dirPath);
				const children = selectedChildren?.[rel];
				const allowedChildren = children ? new Set(children) : undefined;
				if (children) for (const child of children) if (!names.includes(child)) absent.add(`${rel}/${child}`);
				for (const name of names) {
					checkAbort(signal);
					if (allowedChildren && !allowedChildren.has(name)) continue;
					if (!checkedName(name)) throw new Error("invalid source name");
					const childRel = rel ? `${rel}/${name}` : name;
					const childPath = join(dirPath, name);
					const stat = await lstat(childPath, { bigint: true });
					recordTreeItem(map, childRel, stat, limits);
					if (stat.isDirectory()) await visit(childPath, childRel, depth + 1);
				}
			} finally { await dir.close(); }
		};
		if (selectedRoots) {
			for (const name of selectedRoots) {
				checkAbort(signal);
				const childPath = join(rootPath, name);
				let stat: BigIntStats;
				try { stat = await lstat(childPath, { bigint: true }); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") { absent.add(name); continue; }
					throw error;
				}
				recordTreeItem(map, name, stat, limits);
				if (selectedChildren?.[name] && !stat.isDirectory()) throw new Error("filtered source entry is not a directory");
				if (stat.isDirectory()) await visit(childPath, name, 1);
			}
		} else await visit(rootPath, "", 0);
		return { items: map, absent };
	} finally { await rootHandle.close(); }
}

function assertSameTree(before: TreeSnapshot, after: TreeSnapshot, filteredRoots: ReadonlySet<string> = new Set()): void {
	if (before.items.size !== after.items.size || before.absent.size !== after.absent.size) throw new Error("source tree changed");
	for (const name of before.absent) if (!after.absent.has(name)) throw new Error("selected source appeared");
	for (const [rel, item] of before.items) {
		const current = after.items.get(rel);
		if (!current) throw new Error("source tree changed");
		if (rel === "") {
			if (item.type !== current.type || item.dev !== current.dev || item.ino !== current.ino || item.mode !== current.mode || item.uid !== current.uid) throw new Error("source root changed");
		} else if (filteredRoots.has(rel) && item.type === "directory") {
			if (current.type !== "directory" || item.dev !== current.dev || item.ino !== current.ino || item.mode !== current.mode || item.uid !== current.uid) throw new Error("filtered source directory changed");
		} else if (!sameItem(item, current)) throw new Error("source tree changed");
	}
}

async function checkHeldSource(path: string, handle: FileHandle, item: TreeItem): Promise<BigIntStats> {
	const [held, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
	if (!regularOwnedFile(held) || !identity(held, named) || held.dev !== item.dev || held.ino !== item.ino || held.size !== item.size || held.mtimeNs !== item.mtimeNs || held.ctimeNs !== item.ctimeNs) throw new Error("source file changed");
	return held;
}

async function mkdirChecked(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 });
	const stat = await lstat(path, { bigint: true });
	if (!privateOwnedDirectory(stat) || (stat.mode & 0o777n) !== 0o700n) throw new Error("unsafe staging directory");
}

async function copyOne(
	sourceRoot: string,
	stage: string,
	item: TreeItem,
	signal: AbortSignal | undefined,
	onSettled: (rel: string, stat: BigIntStats, sha256: string) => void,
): Promise<CopiedFile> {
	checkAbort(signal);
	const sourcePath = join(sourceRoot, ...item.rel.split("/"));
	const destinationPath = join(stage, ...item.rel.split("/"));
	const source = await open(sourcePath, FILE_FLAGS);
	let destination: FileHandle | undefined;
	let hash = createHash("sha256");
	let writtenTotal = 0;
	try {
		await checkHeldSource(sourcePath, source, item);
		destination = await open(destinationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		const dstInitial = await destination.stat({ bigint: true });
		if (!regularOwnedFile(dstInitial) || dstInitial.size !== 0n || (dstInitial.mode & 0o077n) !== 0n) throw new Error("unsafe staged file");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let offset = 0;
		while (offset < Number(item.size)) {
			checkAbort(signal);
			const requested = Math.min(chunk.length, Number(item.size) - offset);
			const { bytesRead } = await source.read(chunk, 0, requested, offset);
			if (bytesRead <= 0) throw new Error("source shortened");
			let written = 0;
			while (written < bytesRead) {
				checkAbort(signal);
				const { bytesWritten } = await destination.write(chunk, written, bytesRead - written, offset + written);
				if (!bytesWritten) throw new Error("staged write failed");
				hash.update(chunk.subarray(written, written + bytesWritten));
				written += bytesWritten;
				writtenTotal += bytesWritten;
			}
			offset += bytesRead;
		}
		await checkHeldSource(sourcePath, source, item);
		await destination.sync();
		const dstFinal = await destination.stat({ bigint: true });
		const dstNamed = await lstat(destinationPath, { bigint: true });
		if (!regularOwnedFile(dstFinal) || !identity(dstFinal, dstNamed) || dstFinal.size !== item.size || BigInt(writtenTotal) !== item.size || (dstFinal.mode & 0o077n) !== 0n) throw new Error("staged file changed");
		const sha256 = hash.digest("hex");
		onSettled(item.rel, dstFinal, sha256);
		return { path: item.rel, size: Number(item.size), sha256 };
	} finally {
		try { await source.close(); } finally { await destination?.close(); }
	}
}

async function hashFile(path: string, signal?: AbortSignal): Promise<{ size: number; sha256: string; stat: BigIntStats }> {
	const file = await open(path, FILE_FLAGS);
	try {
		checkAbort(signal);
		const stat = await file.stat({ bigint: true });
		if (!regularOwnedFile(stat) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid staged file");
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let offset = 0;
		while (offset < Number(stat.size)) {
			checkAbort(signal);
			const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, Number(stat.size) - offset), offset);
			if (!bytesRead) throw new Error("staged file shortened");
			hash.update(chunk.subarray(0, bytesRead));
			offset += bytesRead;
		}
		checkAbort(signal);
		const final = await file.stat({ bigint: true });
		if (!identity(stat, final) || stat.size !== final.size || stat.mtimeNs !== final.mtimeNs || stat.ctimeNs !== final.ctimeNs) throw new Error("staged file changed");
		const named = await lstat(path, { bigint: true });
		if (!identity(final, named)) throw new Error("staged file replaced");
		return { size: Number(stat.size), sha256: hash.digest("hex"), stat: final };
	} finally { await file.close(); }
}

function compareStage(expected: Map<string, TreeItem>, current: TreeSnapshot): void {
	if (current.absent.size || current.items.size !== expected.size) throw new Error("staging tree changed");
	for (const [rel, old] of expected) {
		const item = current.items.get(rel);
		if (!item || item.type !== old.type || item.dev !== old.dev || item.ino !== old.ino || item.mode !== old.mode || item.uid !== old.uid) throw new Error("staging item changed");
		if (item.type === "file" && (item.nlink !== old.nlink || item.size !== old.size || item.mtimeNs !== old.mtimeNs || item.ctimeNs !== old.ctimeNs)) throw new Error("staged file changed");
	}
}

async function verifyStage(stage: string, expected: Map<string, TreeItem>, hashes: Map<string, string>, limits: VerifiedNativeCoreBackupLimits, signal?: AbortSignal): Promise<void> {
	checkAbort(signal);
	const before = await snapshotTree(stage, limits, signal);
	compareStage(expected, before);
	for (const [rel, old] of expected) {
		checkAbort(signal);
		if (old.type !== "file") continue;
		const hash = await hashFile(join(stage, ...rel.split("/")), signal);
		if (hash.size !== Number(old.size) || hash.sha256 !== hashes.get(rel) || !sameItem(old, snapshotItem(rel, hash.stat))) throw new Error("staged content changed");
	}
	checkAbort(signal);
	const after = await snapshotTree(stage, limits, signal);
	compareStage(expected, after);
}

export async function createVerifiedNativeCoreBackup(options: VerifiedNativeCoreBackupOptions): Promise<VerifiedNativeCoreBackup> {
	const { sourceRoot: inputSource, destinationParent: inputParent, entries, selectedChildren = {}, appVersion, signal, publishDirectory } = options;
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	let stagePath: string | undefined;
	let stageExpected = new Map<string, TreeItem>();
	const stageHashes = new Map<string, string>();
	try {
		checkAbort(signal);
		if (!publishDirectory || !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || !Number.isSafeInteger(limits.maxTreeEntries) || limits.maxTreeEntries < 1) throw new Error("invalid options");
		if (!entries.length || entries.length > limits.maxEntries || new Set(entries).size !== entries.length || entries.some(name => !checkedName(name) || basename(name) !== name)) throw new Error("invalid entries");
		if (!entries.includes("database") || !appVersion || appVersion.length > 128) throw new Error("missing required backup input");
		if (!selectedChildren || typeof selectedChildren !== "object" || Array.isArray(selectedChildren)) throw new Error("invalid child selection");
		let childSelectionCount = 0;
		for (const [rootName, children] of Object.entries(selectedChildren)) {
			if (!checkedName(rootName) || !entries.includes(rootName) || !Array.isArray(children) || new Set(children).size !== children.length || children.some(name => !checkedName(name) || basename(name) !== name)) throw new Error("invalid child selection");
			childSelectionCount += children.length;
			if (childSelectionCount > limits.maxEntries) throw new Error("child selection too large");
		}
		const sourceInputPath = resolve(inputSource);
		const parentInputPath = resolve(inputParent);
		const [sourceRoot, destinationParent, sourceInputInfo, parentInputInfo] = await Promise.all([
			realpath(sourceInputPath), realpath(parentInputPath), lstat(sourceInputPath, { bigint: true }), lstat(parentInputPath, { bigint: true }),
		]);
		if (sourceInputInfo.isSymbolicLink() || parentInputInfo.isSymbolicLink()) throw new Error("symlink root");
		const [sourceInfo, parentInfo] = await Promise.all([lstat(sourceRoot, { bigint: true }), lstat(destinationParent, { bigint: true })]);
		if (!privateOwnedDirectory(sourceInfo) || !parentInfo.isDirectory() || !isOwner(parentInfo)) throw new Error("unsafe roots");
		if (inside(sourceRoot, destinationParent)) throw new Error("destination inside source");
		for (const forbiddenInput of options.forbiddenDestinationRoots) {
			const forbiddenInputPath = resolve(forbiddenInput);
			const [forbidden, forbiddenInfo] = await Promise.all([realpath(forbiddenInputPath), lstat(forbiddenInputPath, { bigint: true })]);
			if (forbiddenInfo.isSymbolicLink() || inside(forbidden, destinationParent)) throw new Error("forbidden destination");
		}
		const initialTree = await snapshotTree(sourceRoot, limits, signal, entries, selectedChildren);
		const database = initialTree.items.get("database/kestrel.sqlite");
		if (!database || database.type !== "file") throw new Error("required database missing");
		const selected = [...initialTree.items.values()].filter(item => item.rel);
		const selectedFiles = selected.filter(item => item.type === "file");
		const totalBytes = selectedFiles.reduce((sum, item) => sum + item.size, 0n);
		if (selectedFiles.length > limits.maxFiles || totalBytes > BigInt(limits.maxBytes) || selectedFiles.some(item => item.size > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("backup limit exceeded");
		const createdAt = new Date().toISOString();
		const suffix = randomBytes(12).toString("hex");
		stagePath = join(destinationParent, `.kestrel-native-core-${suffix}.partial`);
		await mkdirChecked(stagePath);
		const stageStat = await lstat(stagePath, { bigint: true });
		stageExpected.set("", snapshotItem("", stageStat));
		for (const item of selected.filter(value => value.type === "directory").sort((a, b) => a.rel.split("/").length - b.rel.split("/").length)) {
			checkAbort(signal);
			await mkdirChecked(join(stagePath, ...item.rel.split("/")));
			const made = await lstat(join(stagePath, ...item.rel.split("/")), { bigint: true });
			stageExpected.set(item.rel, snapshotItem(item.rel, made));
		}
		const copied: CopiedFile[] = [];
		for (const item of selectedFiles) {
			checkAbort(signal);
			const record = await copyOne(sourceRoot, stagePath, item, signal,
				(rel, stat, hash) => { stageExpected.set(rel, snapshotItem(rel, stat)); stageHashes.set(rel, hash); },
			);
			copied.push(record);
		}
		const postCopyTree = await snapshotTree(sourceRoot, limits, signal, entries, selectedChildren);
		assertSameTree(initialTree, postCopyTree, new Set(Object.keys(selectedChildren)));
		const manifest = {
			format: "native-core-data",
			version: 1,
			appVersion,
			createdAt,
			sourceRootHash: createHash("sha256").update(sourceRoot).digest("hex"),
			compatibility: "This backup is for the same Mac and original Kestrel profile; the original profile Keychain identity is required.",
			limitations: "This is a data backup only and does not claim restore readiness. Keys, Chromium data, and provider CLI caches are excluded.",
			files: copied,
		};
		const manifestPath = join(stagePath, MANIFEST_NAME);
		const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		const manifestFile = await open(manifestPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		try {
			let offset = 0;
			while (offset < manifestBytes.length) {
				checkAbort(signal);
				const { bytesWritten } = await manifestFile.write(manifestBytes, offset, manifestBytes.length - offset, offset);
				if (!bytesWritten) throw new Error("manifest write failed");
				offset += bytesWritten;
			}
			await manifestFile.sync();
		} finally { await manifestFile.close(); }
		const manifestStat = await lstat(manifestPath, { bigint: true });
		if (!regularOwnedFile(manifestStat) || manifestStat.nlink !== 1n || (manifestStat.mode & 0o077n) !== 0n) throw new Error("unsafe manifest");
		stageExpected.set(MANIFEST_NAME, snapshotItem(MANIFEST_NAME, manifestStat));
		stageHashes.set(MANIFEST_NAME, createHash("sha256").update(manifestBytes).digest("hex"));
		await verifyStage(stagePath, stageExpected, stageHashes, limits, signal);
		const stageHandle = await open(stagePath, DIR_FLAGS);
		const parentHandle = await open(destinationParent, DIR_FLAGS);
		let parentHeld: BigIntStats;
		let stageHeld: BigIntStats;
		try {
			parentHeld = await parentHandle.stat({ bigint: true });
			stageHeld = await stageHandle.stat({ bigint: true });
			const [parentNamed, stageNamed] = await Promise.all([lstat(destinationParent, { bigint: true }), lstat(stagePath, { bigint: true })]);
			if (!identity(parentHeld, parentNamed) || !identity(stageHeld, stageNamed) || !privateOwnedDirectory(stageHeld)) throw new Error("publish directory changed");
			for (const dirRel of [...stageExpected.values()].filter(item => item.type === "directory").map(item => item.rel).sort((a, b) => b.split("/").length - a.split("/").length)) {
				const directory = await open(dirRel ? join(stagePath, ...dirRel.split("/")) : stagePath, DIR_FLAGS);
				try { await directory.sync(); } finally { await directory.close(); }
			}
			await parentHandle.sync();
		} finally { try { await stageHandle.close(); } finally { await parentHandle.close(); } }
		checkAbort(signal);
		const finalPath = join(destinationParent, `Kestrel-Native-Core-${createdAt.replace(/[:.]/g, "-")}-${suffix}`);
		await publishDirectory(stagePath, finalPath, { parentDev: parentHeld!.dev.toString(), parentIno: parentHeld!.ino.toString(), stagingDev: stageHeld!.dev.toString(), stagingIno: stageHeld!.ino.toString() });
		return { path: finalPath, createdAt, files: copied.length, bytes: Number(totalBytes), verified: true };
	} catch (error) {
		if ((error as { code?: unknown } | undefined)?.code === "KESTREL_BACKUP_COMMITTED_SYNC_UNCERTAIN") {
			throw new VerifiedNativeCoreBackupError("committedSyncUncertain");
		}
		if (error instanceof VerifiedNativeCoreBackupError && error.code === "cancelled") throw error;
		if (signal?.aborted) throw new VerifiedNativeCoreBackupError("cancelled");
		throw new VerifiedNativeCoreBackupError("unsafe");
	}
}
