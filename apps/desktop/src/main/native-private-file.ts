import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export class NativePrivateFileError extends Error {
 constructor(readonly created: boolean) { super("Private file could not be saved safely."); }
}
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function regular(stat: BigIntStats): boolean {
 return stat.isFile() && stat.nlink === 1n && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}
async function checkParent(parent: string, directory: FileHandle, check: () => void): Promise<void> {
 check();
 const [held, current] = await Promise.all([directory.stat({ bigint: true }), lstat(parent, { bigint: true })]);
 check();
 if (!held.isDirectory() || !current.isDirectory() || !sameIdentity(held, current)) throw new Error("Directory changed.");
}
export async function writeNativePrivateFile(path: string, parent: string, data: Buffer, check: () => void, isCancelled: (error: unknown) => boolean): Promise<void> {
	check();
	const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	let file: FileHandle | undefined;
	let created = false;
	try {
		await checkParent(parent, directory, check);
		check();
		file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		created = true;
		check();
		await checkParent(parent, directory, check);
		const initial = await file.stat({ bigint: true });
		check();
		const named = await lstat(path, { bigint: true });
		check();
		if (!regular(initial) || initial.size !== 0n || (initial.mode & 0o077n) !== 0n || !sameIdentity(initial, named)) throw new Error("Invalid created file.");
		let offset = 0;
		while (offset < data.length) {
			check();
			const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
			check();
			if (!bytesWritten) throw new Error("Incomplete write.");
			offset += bytesWritten;
		}
		check();
		await file.sync();
		check();
		const [final, finalName] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })]);
		check();
		if (!regular(final) || (final.mode & 0o077n) !== 0n || !sameIdentity(initial, final) || !sameIdentity(final, finalName) || final.size !== BigInt(data.length)) throw new Error("File changed.");
		await checkParent(parent, directory, check);
		await directory.sync();
		check();
	} catch (error) {
		if (created) throw new NativePrivateFileError(true);
		if (isCancelled(error)) throw error;
		throw new NativePrivateFileError(false);
	} finally {
		try {
			try { await file?.close(); } finally { await directory.close(); }
		} catch {
			throw new NativePrivateFileError(created);
		}
	}
}
