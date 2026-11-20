import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { candidateDigest } from "./native-retirement-evidence.mjs";

function contained(root, path) {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function assertSafePath(root, path, { allowMissing = true, directory = false } = {}) {
	if (!contained(root, path)) throw new Error("Native package staging and output paths must stay inside the repository.");
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root)
		throw new Error("Native package repository root must be a canonical directory.");
	const rel = relative(root, path);
	let current = root;
	for (const part of rel ? rel.split(sep) : []) {
		current = join(current, part);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink() || ((current !== path || directory) && !info.isDirectory()))
				throw new Error("Native package staging and output ancestors must be real directories.");
			if (!contained(root, await realpath(current)) && current !== root)
				throw new Error("Native package staging and output paths cannot escape the repository.");
		} catch (error) {
			if (error.code !== "ENOENT" || !allowMissing) throw error;
		}
	}
}

async function ensureDirectory(root, path, ops) {
	await assertSafePath(root, path, { directory: true });
	const rel = relative(root, path);
	let current = root;
	for (const part of rel ? rel.split(sep) : []) {
		current = join(current, part);
		try { await lstat(current); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			await ops.mkdir(current, { mode: 0o700 });
		}
		await assertSafePath(root, current, { allowMissing: false, directory: true });
	}
}

/** Build/copy/verify first, then replace the prior release app with recoverable renames. */
export async function packageNativeChromiumArtifact({ root, destinationRoot, destinationApp, build, copy, digest = candidateDigest, ops = { mkdir, rename, rm } }) {
	const repo = resolve(root), outputRoot = resolve(destinationRoot), outputApp = resolve(destinationApp);
	await assertSafePath(repo, join(repo, ".tmp"));
	await ensureDirectory(repo, join(repo, ".tmp"), ops);
	await ensureDirectory(repo, outputRoot, ops);
	if (outputApp !== join(outputRoot, "Kestrel.app")) throw new Error("Native release output must remain Kestrel.app inside its package directory.");
	const stageRoot = join(repo, ".tmp", `native-package-stage-${process.pid}-${randomUUID()}`);
	const buildRoot = join(stageRoot, "build"), packageRoot = join(stageRoot, "package"), stagedApp = join(packageRoot, "Kestrel.app");
	const backupApp = join(outputRoot, `.Kestrel.app.previous-${randomUUID()}`);
	let movedPrevious = false, movedCandidate = false, createdStage = false, primaryError;
	try {
		await ops.mkdir(stageRoot, { mode: 0o700 });
		createdStage = true;
		await assertSafePath(repo, stageRoot, { allowMissing: false });
		const built = await build(buildRoot);
		if (typeof built !== "string" || resolve(built) !== join(buildRoot, "Kestrel.app")) throw new Error("Native package build must return its dedicated staged Kestrel.app.");
		await assertSafePath(repo, built, { allowMissing: false, directory: true });
		const expectedDigest = await digest(built);
		await ensureDirectory(repo, packageRoot, ops);
		await copy(built, stagedApp);
		await assertSafePath(repo, stagedApp, { allowMissing: false, directory: true });
		if (await digest(stagedApp) !== expectedDigest) throw new Error("Copied native package digest does not match its build.");

		try {
			const previous = await lstat(outputApp);
			if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error("Existing native release artifact is not a regular app directory.");
			await assertSafePath(repo, outputApp, { allowMissing: false, directory: true });
			await ops.rename(outputApp, backupApp);
			movedPrevious = true;
		} catch (error) { if (error.code !== "ENOENT") throw error; }

		try {
			await ops.rename(stagedApp, outputApp);
			movedCandidate = true;
			await assertSafePath(repo, outputApp, { allowMissing: false });
			if (await digest(outputApp) !== expectedDigest) throw new Error("Adopted native package digest does not match its verified copy.");
		} catch (error) {
			let removalError;
			if (movedCandidate) {
				try { await ops.rm(outputApp, { recursive: true, force: true }); }
				catch (cleanupError) { removalError = cleanupError; }
			}
			if (movedPrevious) {
				try { await ops.rename(backupApp, outputApp); movedPrevious = false; }
				catch (restoreError) {
					throw new AggregateError([error, ...(removalError ? [removalError] : []), restoreError],
						`Native package adoption failed (${error.message}) and the prior artifact is retained at ${backupApp}; restore failed: ${restoreError.message}`);
				}
			}
			if (removalError) throw new AggregateError([error, removalError],
				`Native package adoption failed (${error.message}); candidate cleanup also failed: ${removalError.message}`);
			throw error;
		}
		if (movedPrevious) { await ops.rm(backupApp, { recursive: true, force: true }); movedPrevious = false; }
		return outputApp;
	} catch (error) {
		primaryError = error;
		throw error;
	} finally {
		if (createdStage) {
			try { await ops.rm(stageRoot, { recursive: true, force: true }); }
			catch (cleanupError) {
				if (primaryError) throw new AggregateError([primaryError, cleanupError],
					`${primaryError.message}; temporary package staging cleanup also failed at ${stageRoot}: ${cleanupError.message}`);
				throw new Error(`Native package was adopted, but temporary staging cleanup failed at ${stageRoot}: ${cleanupError.message}`, { cause: cleanupError });
			}
		}
	}
}
