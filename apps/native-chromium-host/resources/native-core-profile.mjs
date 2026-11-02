import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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

async function suppliedProtectedKey(root, value) {
	const keyPath = join(root, "database.key");
	try {
		await lstat(keyPath);
		throw new Error("Native Core profile has a legacy file-backed key; explicit migration is required.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (typeof value !== "string") {
		throw new Error("Native Core requires its protected profile key from the trusted host.");
	}
	const key = Buffer.from(value, "base64");
	if (key.length !== 32 || key.toString("base64") !== value) {
		key.fill(0);
		throw new Error("Native Core received a malformed protected profile key.");
	}
	const canonical = key.toString("base64");
	key.fill(0);
	return canonical;
}

// Called only with the native host's explicitly selected profile. It never
// discovers, imports or opens the Electron profile or provider login caches.
export async function openNativeCoreProfile(profileRoot, { durable = false, protectedKeyBase64 } = {}) {
	if (!isAbsolute(profileRoot)) throw new Error("Native Core requires an absolute profile root.");
	const requestedProfile = await realpath(profileRoot);
	const requestedInfo = await lstat(profileRoot);
	if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink() ||
		requestedProfile !== profileRoot || (requestedInfo.mode & 0o077) !== 0 ||
		requestedInfo.uid !== process.getuid()) {
		throw new Error("Native Core requires a canonical, owned private profile directory.");
	}
	const profile = requestedProfile;
	const root = durable
		? join(profile, "native-core")
		: await mkdtemp(join(profile, "native-core-"));
	try {
		// Validate the trusted host key before creating native-core. The host
		// uses absence of this directory to distinguish a genuinely fresh
		// profile from existing data that must not be silently re-keyed.
		const encryptionKeyBase64 = durable
			? await suppliedProtectedKey(root, protectedKeyBase64)
			: randomBytes(32).toString("base64");
		await ensurePrivateDirectory(root);
		const databaseRoot = join(root, "database");
		await ensurePrivateDirectory(databaseRoot);
		const databasePath = join(databaseRoot, "kestrel.sqlite");
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
