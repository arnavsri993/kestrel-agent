import { execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { validateChromiumSigningClones } from "./native-code-sign-clone.mjs";

const BUILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_BUILD = "native-chromium-host";

function ownedPrivateDirectory(info, uid) {
	return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o022) === 0;
}

async function validateCandidate(supplied, { root, uid = process.getuid() } = {}, allowChromiumSigningClones = false) {
	if (!supplied || !root) throw new Error("A candidate path and repository root are required.");
	const repository = await realpath(resolve(root));
	const tempRoot = join(repository, ".tmp");
	const expectedTempRoot = resolve(tempRoot);
	if (await realpath(tempRoot).catch(() => "") !== expectedTempRoot)
		throw new Error("Repository .tmp must be a real directory, not a symlink.");
	const tempInfo = await lstat(tempRoot);
	if (!ownedPrivateDirectory(tempInfo, uid)) throw new Error("Repository .tmp must be owned and not group/world writable.");

	const selected = resolve(supplied);
	if (selected !== supplied) throw new Error("Candidate path must be absolute and canonical.");
	if (/[\x00-\x1f\x7f]/.test(selected)) throw new Error("Candidate path contains control characters.");
	const relativeParts = relative(expectedTempRoot, selected).split(/[\\/]/);
	if (relativeParts.length !== 2 || relativeParts[0] === ".." || relativeParts[1] !== "Kestrel.app" || !BUILD_NAME.test(relativeParts[0]))
		throw new Error("Candidate must be .tmp/<simple-build-name>/Kestrel.app.");
	if (relativeParts[0] === RESERVED_BUILD) throw new Error("The reserved native-chromium-host candidate is never eligible.");
	if (dirname(selected) !== join(expectedTempRoot, relativeParts[0])) throw new Error("Candidate must be a direct .tmp build child.");

	const buildDirectory = join(expectedTempRoot, relativeParts[0]);
	const app = selected;
	const executable = join(app, "Contents", "MacOS", "Kestrel");
	for (const path of [buildDirectory, app, join(app, "Contents"), join(app, "Contents", "MacOS")]) {
		const info = await lstat(path);
		if (!ownedPrivateDirectory(info, uid)) throw new Error("Candidate path contains an unowned, writable, or non-directory component.");
		if (await realpath(path) !== path) throw new Error("Candidate path contains a symlink or alias.");
	}
	const executableInfo = await lstat(executable);
	if (!executableInfo.isFile() || executableInfo.isSymbolicLink() || executableInfo.uid !== uid || (!allowChromiumSigningClones && executableInfo.nlink !== 1) ||
		(executableInfo.mode & 0o111) === 0 || (executableInfo.mode & 0o022) !== 0)
		throw new Error("Candidate executable must be owned, executable, non-writable, and single-link regular file.");
	if (await realpath(executable) !== executable) throw new Error("Candidate executable resolves through an alias.");
	const signingClones = allowChromiumSigningClones ? await validateChromiumSigningClones(app, { uid }) : undefined;
	return { candidate: app, executable, buildName: relativeParts[0], ...(signingClones ? { signingClones } : {}) };
}

export const validateRealKeychainCandidate = (supplied, options) => validateCandidate(supplied, options);
// Only the custom Chromium vault preflight uses signing-clone accounting.
// The generic/legacy validator has no caller-selectable alias exception.
export const validateChromiumVaultCandidatePath = (supplied, options) => validateCandidate(supplied, options, true);

export function assertNoExactExecutableRunning(executable, { ps = execFileSync } = {}) {
	const output = ps("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
	for (const line of output.split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(.+)$/);
		if (match && match[2] === executable)
			throw new Error("The selected candidate executable is already running.");
	}
}
