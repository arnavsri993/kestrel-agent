import { open, lstat, realpath, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const markerName = ".kestrel-native-test-profile-v1";
const marker = "native-test-profile-v1\n";

// Validation for deliberately retained generated fixtures. This does not read
// the test key or relax the native host's independent development-only guard.
export async function validateDisposableNativeTestProfile(profileRoot) {
	const requested = resolve(profileRoot), canonical = await realpath(requested);
	const info = await lstat(requested), temporary = await realpath(tmpdir());
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
		info.uid !== process.getuid() || !canonical.startsWith(`${temporary}/`)) {
		throw new Error("Retained native fixtures require an owned private temporary profile.");
	}
	for (const [name, size] of [[markerName, Buffer.byteLength(marker)], [".kestrel-native-test-core-key-v1", 32]]) {
		const entry = await lstat(join(canonical, name));
		if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid() ||
			(entry.mode & 0o777) !== 0o600 || entry.size !== size) {
			throw new Error("Retained native fixture marker or test-key metadata is invalid.");
		}
	}
	const handle = await open(join(canonical, markerName), "r");
	try {
		if (await handle.readFile("utf8") !== marker) throw new Error("Retained native fixture marker is invalid.");
	} finally { await handle.close(); }
	return canonical;
}

// Explicit opt-in used only by disposable native Chromium canaries. The native
// host independently checks the temp-root containment, marker, mode, owner,
// and development bundle identity before it will use a test key file.
export async function markDisposableNativeTestProfile(profileRoot) {
	const requested = resolve(profileRoot);
	const canonical = await realpath(requested);
	const info = await lstat(requested);
	const temporary = await realpath(tmpdir());
	if (!info.isDirectory() || info.isSymbolicLink() ||
		(info.mode & 0o077) !== 0 || info.uid !== process.getuid() ||
		!canonical.startsWith(`${temporary}/`)) {
		throw new Error("Disposable native test key mode requires a fresh owned private temporary profile.");
	}
	if ((await readdir(canonical)).length !== 0) {
		throw new Error("Disposable native test keys can only be staged into an empty temporary profile.");
	}
	const handle = await open(join(canonical, markerName), "wx", 0o600);
	try {
		await handle.writeFile(marker, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	const testKey = randomBytes(32);
	const keyFile = await open(join(canonical, ".kestrel-native-test-core-key-v1"), "wx", 0o600);
	try {
		await keyFile.writeFile(testKey);
		await keyFile.chmod(0o600);
		await keyFile.sync();
	} finally {
		testKey.fill(0);
		await keyFile.close();
	}
	const directory = await open(canonical, "r");
	try { await directory.sync(); } finally { await directory.close(); }
}
