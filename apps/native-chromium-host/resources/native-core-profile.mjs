import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

async function privateDirectory(path) {
	await mkdir(path, { mode: 0o700 });
}

async function ensurePrivateDirectory(path) {
	try {
		await privateDirectory(path);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const info = await lstat(path);
	if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
		throw new Error("Native Core requires a private directory owned by the current user.");
	}
}

async function durableKey(root, databasePath) {
	const keyPath = join(root, "database.key");
	try {
		await lstat(keyPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		// Never generate a new key over an existing encrypted database. Losing a
		// key is a recovery error, not permission to reset the person's data.
		for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
			try {
				await lstat(path);
				throw new Error("Native Core database key is missing. Restore the key; the database was preserved.");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		let created;
		try {
			created = await open(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			await created.writeFile(randomBytes(32));
			await created.sync();
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		} finally {
			await created?.close();
		}
	}
	const file = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size !== 32 ||
			(info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
			throw new Error("Native Core database key is invalid or not private. Existing data was preserved.");
		}
		const key = await file.readFile();
		if (key.length !== 32) throw new Error("Native Core database key changed during startup.");
		return key.toString("base64");
	} finally {
		await file.close();
	}
}

// Called only with the native host's explicitly selected profile. It never
// discovers, imports or opens the Electron profile or provider login caches.
export async function openNativeCoreProfile(profileRoot, { durable = false } = {}) {
	if (!isAbsolute(profileRoot)) throw new Error("Native Core requires an absolute profile root.");
	const profile = await realpath(profileRoot);
	const root = durable
		? join(profile, "native-core")
		: await mkdtemp(join(profile, "native-core-"));
	try {
		await ensurePrivateDirectory(root);
		const databaseRoot = join(root, "database");
		await ensurePrivateDirectory(databaseRoot);
		const databasePath = join(databaseRoot, "kestrel.sqlite");
		const encryptionKeyBase64 = durable
			? await durableKey(root, databasePath)
			: randomBytes(32).toString("base64");
		// Block links for SQLite and its side files before handing their paths to
		// the database layer. The profile remains owned by the current user.
		for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
			try {
				const info = await lstat(path);
				if (!info.isFile() || info.nlink !== 1) throw new Error("Native Core database paths must be regular files.");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		return {
			root,
			databasePath,
			encryptionKeyBase64,
			async close() {
				if (!durable) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
			},
		};
	} catch (error) {
		if (!durable) await rm(root, { recursive: true, force: true });
		throw error;
	}
}
