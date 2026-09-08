import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { homedir } from "node:os";

export const kestrelBundleIdentifier = "com.kestrel.desktop";
export const kestrelApplicationName = "Kestrel";
export const developmentInstallStagePrefix = ".Kestrel-install-";
export const staleInstallStageAgeMs = 10 * 60 * 1000;
export const supportedBundleIdentifiers = new Set([
	"com.kestrel.desktop",
	"com.kestrel.desktop.dev",
	"com.kestrel.desktop.dev.launcher",
]);

export function uniquePaths(paths) {
	return [...new Set(paths.map((path) => resolve(path)))];
}

export function samePath(left, right) {
	return resolve(left) === resolve(right);
}

export function isInside(path, root) {
	const relativePath = relative(resolve(root), resolve(path));
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

export function statIsDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function plistValue(bundlePath, key) {
	try {
		return execFileSync(
			"/usr/libexec/PlistBuddy",
			["-c", `Print :${key}`, join(bundlePath, "Contents", "Info.plist")],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		return "";
	}
}

export function isKestrelBundle(bundlePath) {
	if (!bundlePath.endsWith(".app") || !statIsDirectory(bundlePath)) return false;
	const identifier = plistValue(bundlePath, "CFBundleIdentifier");
	const name = plistValue(bundlePath, "CFBundleName");
	const displayName = plistValue(bundlePath, "CFBundleDisplayName");
	const isKestrelIdentifier =
		identifier === kestrelBundleIdentifier ||
		identifier.startsWith(`${kestrelBundleIdentifier}.`);
	const isKestrelName = [name, displayName].some(
		(value) =>
			value === kestrelApplicationName ||
			value.startsWith(`${kestrelApplicationName} `),
	);
	return isKestrelIdentifier && isKestrelName;
}

export function markDirectoryUnindexed(directory) {
	if (!statIsDirectory(directory)) return false;
	const marker = join(directory, ".metadata_never_index");
	if (existsSync(marker)) return false;
	try {
		writeFileSync(marker, "");
		return true;
	} catch {
		return false;
	}
}

export function resolveDocumentsRoot(options = {}) {
	if (options.documentsRoot) return resolve(options.documentsRoot);
	if (process.env.KESTREL_DOCUMENTS_ROOT) {
		return resolve(process.env.KESTREL_DOCUMENTS_ROOT);
	}
	return join(homedir(), "Documents");
}

export function agentRepositoryRoots(documentsRoot = resolveDocumentsRoot()) {
	if (!statIsDirectory(documentsRoot)) return [];
	const roots = [];
	for (const entry of readdirSync(documentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^Agent(-|$)/.test(entry.name)) continue;
		roots.push(join(documentsRoot, entry.name));
	}
	return roots;
}

export function preventSpotlightIndexing(repositoryRoot) {
	const marked = [];
	for (const root of [repositoryRoot, ...agentRepositoryRoots()]) {
		for (const directory of [
			join(root, "release"),
			join(root, ".kestrel-dev-app"),
		]) {
			if (markDirectoryUnindexed(directory)) marked.push(directory);
		}
	}
	return marked;
}

export function staleInstallStageCandidates(
	installRoot,
	{ now = Date.now(), maxAgeMs = staleInstallStageAgeMs } = {},
) {
	if (!statIsDirectory(installRoot)) return [];
	let entries;
	try {
		entries = readdirSync(installRoot, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "EACCES" || error?.code === "EPERM") return [];
		throw error;
	}
	return entries
		.filter(
			(entry) =>
				entry.isDirectory() && entry.name.startsWith(developmentInstallStagePrefix),
		)
		.map((entry) => join(installRoot, entry.name))
		.filter((stageRoot) => {
			try {
				return now - statSync(stageRoot).mtimeMs > maxAgeMs;
			} catch {
				return false;
			}
		});
}

export function removeStaleInstallStagingDirectories(
	installRoot,
	{ now = Date.now(), maxAgeMs = staleInstallStageAgeMs } = {},
) {
	const removed = [];
	for (const stageRoot of staleInstallStageCandidates(installRoot, {
		now,
		maxAgeMs,
	})) {
		// A crashed install can leave a bundle registered under its temporary
		// path even after its files disappear. Remove that registration before
		// deleting the private staging directory.
		unregister(join(stageRoot, "Kestrel.app"));
		rmSync(stageRoot, { recursive: true, force: true });
		removed.push(stageRoot);
	}
	return removed;
}

export function repositoryReleaseBundle(repositoryRoot) {
	return join(resolve(repositoryRoot), "release", "mac-arm64", "Kestrel.app");
}

export function worktreeReleaseCandidates(documentsRoot = resolveDocumentsRoot()) {
	const candidates = [];
	for (const root of agentRepositoryRoots(documentsRoot)) {
		const bundle = repositoryReleaseBundle(root);
		if (isKestrelBundle(bundle)) candidates.push(bundle);
	}
	return candidates;
}

export function appCandidates(root) {
	if (!statIsDirectory(root)) return [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "EACCES" || error?.code === "EPERM") return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".app"))
		.map((entry) => join(root, entry.name))
		.filter(isKestrelBundle);
}

export function spotlightCandidates({
	mdfindPath = process.env.KESTREL_MDFIND_PATH ?? "/usr/bin/mdfind",
	trashRoot,
	skipSpotlight = process.env.KESTREL_SKIP_SPOTLIGHT === "1",
}) {
	if (skipSpotlight || !existsSync(mdfindPath)) return [];
	let output;
	try {
		output = execFileSync(
			mdfindPath,
			["kMDItemCFBundleIdentifier == 'com.kestrel.desktop*'c"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		return [];
	}
	return output
		.split(/\r?\n/)
		.map((path) => path.trim())
		.filter(Boolean)
		.filter((path) => !isInside(path, trashRoot))
		.filter(isKestrelBundle);
}

export function allAppCandidates({
	searchRoots,
	trashRoot,
	mdfindPath,
	skipSpotlight,
	documentsRoot,
}) {
	return [
		...searchRoots.flatMap((root) => appCandidates(root)),
		...spotlightCandidates({ mdfindPath, trashRoot, skipSpotlight }),
		...worktreeReleaseCandidates(documentsRoot),
	].filter(
		(candidate, index, candidates) =>
			candidates.findIndex((other) => samePath(candidate, other)) === index,
	);
}

export function unregister(path) {
	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (process.env.KESTREL_SKIP_LSREGISTER === "1" || !existsSync(lsregister)) return;
	try {
		execFileSync(lsregister, ["-u", path], { stdio: "ignore" });
	} catch {
		// LaunchServices cleanup is best effort.
	}
}

export function register(path) {
	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (process.env.KESTREL_SKIP_LSREGISTER === "1" || !existsSync(lsregister)) return;
	try {
		execFileSync(lsregister, ["-f", path], { stdio: "ignore" });
	} catch {
		// LaunchServices registration is best effort.
	}
}

function copyBundle(sourcePath, destinationPath) {
	execFileSync(
		"/usr/bin/ditto",
		["--rsrc", "--extattr", "--acl", sourcePath, destinationPath],
		{ stdio: "ignore" },
	);
}

function uniqueTrashPath(originalPath, trashRoot, reason) {
	const originalName = basename(originalPath, extname(originalPath));
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	let suffix = 0;
	while (true) {
		const extra = suffix === 0 ? "" : `-${suffix}`;
		const candidate = join(
			trashRoot,
			`${originalName}-${reason}-${stamp}${extra}.app`,
		);
		if (!existsSync(candidate)) return candidate;
		suffix += 1;
	}
}

export function moveToTrash(appPath, { trashRoot, reason }) {
	mkdirSync(trashRoot, { recursive: true });
	const trashPath = uniqueTrashPath(appPath, trashRoot, reason);
	unregister(appPath);
	try {
		renameSync(appPath, trashPath);
	} catch (error) {
		if (error?.code !== "EXDEV") throw error;
		copyBundle(appPath, trashPath);
		rmSync(appPath, { recursive: true, force: true });
	}
	unregister(trashPath);
	return trashPath;
}

export function moveDuplicateKestrelAppsToTrash({
	excludedPaths = [],
	searchRoots,
	trashRoot,
	mdfindPath,
	skipSpotlight,
	documentsRoot,
}) {
	const moved = [];
	for (const candidate of allAppCandidates({
		searchRoots,
		trashRoot,
		mdfindPath,
		skipSpotlight,
		documentsRoot,
	})) {
		if (excludedPaths.some((excludedPath) => samePath(candidate, excludedPath))) {
			continue;
		}
		moved.push({
			from: candidate,
			to: moveToTrash(candidate, { trashRoot, reason: "duplicate" }),
		});
	}
	return moved;
}

export function defaultSearchRoots(installRoot, home = homedir()) {
	return uniquePaths([
		installRoot,
		join(home, "Applications"),
		join(home, "Desktop"),
		join(home, "Downloads"),
	]);
}

export function cleanupDuplicateKestrelApps(options = {}) {
	const home = process.env.HOME ?? homedir();
	const installRoot = resolve(
		options.installRoot ?? process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications",
	);
	const trashRoot = resolve(
		options.trashRoot ??
			process.env.KESTREL_MACOS_TRASH_ROOT ??
			join(home, ".Trash"),
	);
	const searchRoots = uniquePaths(
		options.searchRoots ??
			(process.env.KESTREL_MACOS_SEARCH_ROOTS
				? process.env.KESTREL_MACOS_SEARCH_ROOTS.split(":")
				: defaultSearchRoots(installRoot, home)),
	);
	const repositoryRoot = resolve(
		options.repositoryRoot ?? join(import.meta.dirname, ".."),
	);
	const canonicalApp = join(installRoot, "Kestrel.app");
	const currentReleaseBundle = repositoryReleaseBundle(repositoryRoot);
	const excludedPaths = uniquePaths([
		canonicalApp,
		currentReleaseBundle,
		...(options.excludedPaths ?? []),
	]);
	const marked = preventSpotlightIndexing(repositoryRoot);
	const removedStaging = removeStaleInstallStagingDirectories(installRoot, {
		now: options.now,
		maxAgeMs: options.staleInstallStageAgeMs,
	});
	const moved = moveDuplicateKestrelAppsToTrash({
		excludedPaths,
		searchRoots,
		trashRoot,
		mdfindPath: options.mdfindPath,
		skipSpotlight: options.skipSpotlight,
		documentsRoot: options.documentsRoot,
	});
	return { marked, moved, removedStaging, canonicalApp };
}
