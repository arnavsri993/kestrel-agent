#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { tmpdir } from "node:os";

if (process.platform !== "darwin") {
  throw new Error("The macOS development app installer only runs on macOS.");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSource = join(repositoryRoot, "release", "mac-arm64", "Kestrel.app");
const source = resolve(process.argv[2] ?? defaultSource);
const home = process.env.HOME ?? tmpdir();
const installRoot = resolve(process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications");
const destination = join(installRoot, "Kestrel.app");
const trashRoot = resolve(process.env.KESTREL_MACOS_TRASH_ROOT ?? join(home, ".Trash"));
const serviceRoot = resolve(
  process.env.KESTREL_MACOS_SERVICE_ROOT ?? join(home, "Library", "Services"),
);
const serviceDestination = join(serviceRoot, "Ask Kestrel.app");
const mdfind = process.env.KESTREL_MDFIND_PATH ?? "/usr/bin/mdfind";
const kestrelBundleIdentifier = "com.kestrel.desktop";
const kestrelApplicationName = "Kestrel";
const supportedBundleIdentifiers = new Set([
	"com.kestrel.desktop",
	"com.kestrel.desktop.dev",
]);
const searchRoots = uniquePaths(
  (process.env.KESTREL_MACOS_SEARCH_ROOTS
    ? process.env.KESTREL_MACOS_SEARCH_ROOTS.split(":")
    : [
        installRoot,
        join(home, "Applications"),
        join(home, "Desktop"),
        join(home, "Downloads"),
      ]
  ).filter(Boolean),
);
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function uniquePaths(paths) {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function copyBundle(sourcePath, destinationPath) {
  // Node's cpSync rewrites the relative symlinks used by macOS framework
  // bundles into absolute links to the build directory. The installed app
  // then loses Electron Framework as soon as that directory is cleaned up.
  // ditto preserves bundle symlinks and macOS metadata during the staged copy.
  execFileSync(
    "/usr/bin/ditto",
    ["--rsrc", "--extattr", "--acl", sourcePath, destinationPath],
    { stdio: "ignore" },
  );
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

function isInside(path, root) {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function plistValue(bundlePath, key) {
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

function isKestrelBundle(bundlePath) {
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

function isAskKestrelService(bundlePath) {
  return (
    bundlePath.endsWith(".app") &&
    statIsDirectory(bundlePath) &&
    plistValue(bundlePath, "CFBundleIdentifier") === "com.kestrel.services.ask" &&
    plistValue(bundlePath, "CFBundleName") === "Ask Kestrel"
  );
}

function validateSource(bundlePath) {
  const identifier = plistValue(bundlePath, "CFBundleIdentifier");
  if (
    !isKestrelBundle(bundlePath) ||
    !supportedBundleIdentifiers.has(identifier)
  ) {
    throw new Error(`Not a verified Kestrel app bundle: ${bundlePath}`);
  }
}

function unregister(path) {
  if (process.env.KESTREL_SKIP_LSREGISTER === "1" || !existsSync(lsregister)) return;
  try {
    execFileSync(lsregister, ["-u", path], { stdio: "ignore" });
  } catch {
    // LaunchServices cleanup is best effort; the filesystem move is authoritative.
  }
}

function register(path) {
  if (process.env.KESTREL_SKIP_LSREGISTER === "1" || !existsSync(lsregister)) return;
  try {
    execFileSync(lsregister, ["-f", path], { stdio: "ignore" });
  } catch {
    // LaunchServices registration is best effort.
  }
}

function refreshServices() {
  const pbs = "/System/Library/CoreServices/pbs";
  if (!existsSync(pbs)) return;
  try {
    execFileSync(pbs, ["-update"], { stdio: "ignore" });
  } catch {
    // The next login or Services menu open will refresh the provider list.
  }
}

function installAskKestrelService(appPath) {
  const sourceService = join(
    appPath,
    "Contents",
    "Resources",
    "Ask Kestrel.app",
  );
  if (!isAskKestrelService(sourceService)) {
    throw new Error(`Packaged Kestrel app is missing the native Ask Kestrel Service: ${sourceService}`);
  }
  mkdirSync(serviceRoot, { recursive: true });
  if (existsSync(serviceDestination) && !isAskKestrelService(serviceDestination)) {
    throw new Error(`Refusing to replace a non-Kestrel Service at ${serviceDestination}`);
  }
  const stageRoot = mkdtempSync(join(serviceRoot, ".Ask-Kestrel-service-"));
  const stagedService = join(stageRoot, "Ask Kestrel.app");
  try {
    copyBundle(sourceService, stagedService);
    if (existsSync(serviceDestination))
      rmSync(serviceDestination, { recursive: true, force: true });
    renameSync(stagedService, serviceDestination);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  register(serviceDestination);
  refreshServices();
  return serviceDestination;
}

function preventSpotlightIndexing() {
  const releaseDir = join(repositoryRoot, "release");
  if (existsSync(releaseDir)) {
    const marker = join(releaseDir, ".metadata_never_index");
    if (!existsSync(marker)) {
      try {
        writeFileSync(marker, "");
      } catch {
        // Spotlight exclusion marker is best effort.
      }
    }
  }
}

function appCandidates(root) {
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

function spotlightCandidates() {
  // Finder indexes packaged bundles left in old worktrees even when they are
  // not in a common install directory. Query the Kestrel bundle ID prefix so
  // a new install can move stale variants to the same reversible Trash path.
  if (
    process.env.KESTREL_SKIP_SPOTLIGHT === "1" ||
    !existsSync(mdfind)
  ) {
    return [];
  }
  let output;
  try {
    output = execFileSync(
      mdfind,
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

function allAppCandidates() {
  return [
    ...searchRoots.flatMap((root) => appCandidates(root)),
    ...spotlightCandidates(),
  ].filter((candidate, index, candidates) =>
    candidates.findIndex((other) => samePath(candidate, other)) === index,
  );
}

function uniqueTrashPath(originalPath, reason) {
  const originalName = basename(originalPath, extname(originalPath));
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  let suffix = 0;
  while (true) {
    const extra = suffix === 0 ? "" : `-${suffix}`;
    const candidate = join(trashRoot, `${originalName}-${reason}-${stamp}${extra}.app`);
    if (!existsSync(candidate)) return candidate;
    suffix += 1;
  }
}

function moveToTrash(appPath, reason) {
  mkdirSync(trashRoot, { recursive: true });
  const trashPath = uniqueTrashPath(appPath, reason);
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

function moveDuplicatesToTrash(excludedPaths) {
  const moved = [];
  for (const candidate of allAppCandidates()) {
    if (excludedPaths.some((excludedPath) => samePath(candidate, excludedPath))) {
      continue;
    }
    moved.push({ from: candidate, to: moveToTrash(candidate, "duplicate") });
  }
  return moved;
}

function stageBundle() {
  const stageRoot = mkdtempSync(join(installRoot, ".Kestrel-install-"));
  const stagedBundle = join(stageRoot, "Kestrel.app");
  try {
    copyBundle(source, stagedBundle);
    return { stageRoot, stagedBundle };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function install() {
  validateSource(source);
  preventSpotlightIndexing();
  mkdirSync(installRoot, { recursive: true });
  if (existsSync(destination) && !isKestrelBundle(destination)) {
    throw new Error(`Refusing to replace a non-Kestrel app at ${destination}`);
  }

  const moved = moveDuplicatesToTrash([source, destination]);
  let stageRoot;
  if (!samePath(source, destination)) {
    const staged = stageBundle();
    stageRoot = staged.stageRoot;
    if (existsSync(destination)) moved.push({ from: destination, to: moveToTrash(destination, "previous") });
    renameSync(staged.stagedBundle, destination);
    // Unregister source build bundle so Spotlight/LaunchServices only sees the installed destination
    unregister(source);
  }
  if (stageRoot) rmSync(stageRoot, { recursive: true, force: true });

  // A second pass catches duplicates that shared the canonical install root.
  // Keep the source build artifact available for packaged smoke tests; it is
  // already excluded from the first pass and must stay excluded here too.
  moved.push(...moveDuplicatesToTrash([destination, source]));
  validateSource(destination);
  register(destination);
  const service = installAskKestrelService(destination);
  return { destination, moved, service };
}

const result = install();
console.log(`Installed Kestrel at ${result.destination}`);
console.log(`Registered macOS Service at ${result.service}`);
for (const item of result.moved) console.log(`Moved duplicate to Trash: ${item.from} -> ${item.to}`);
