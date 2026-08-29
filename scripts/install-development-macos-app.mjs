#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  basename,
  join,
  resolve,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  defaultSearchRoots,
  isKestrelBundle,
  moveDuplicateKestrelAppsToTrash,
  moveToTrash,
  plistValue,
  preventSpotlightIndexing,
  register,
  samePath,
  supportedBundleIdentifiers,
  uniquePaths,
  unregister,
} from "./kestrel-macos-app-hygiene.mjs";

if (process.platform !== "darwin") {
  throw new Error("The macOS development app installer only runs on macOS.");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSource = join(repositoryRoot, "release", "mac-arm64", "Kestrel.app");
const source = resolve(process.argv[2] ?? defaultSource);
const home = process.env.HOME ?? homedir() ?? tmpdir();
const installRoot = resolve(process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications");
const destination = join(installRoot, "Kestrel.app");
const trashRoot = resolve(process.env.KESTREL_MACOS_TRASH_ROOT ?? join(home, ".Trash"));
const searchRoots = uniquePaths(
  (process.env.KESTREL_MACOS_SEARCH_ROOTS
    ? process.env.KESTREL_MACOS_SEARCH_ROOTS.split(":")
    : defaultSearchRoots(installRoot, home)
  ).filter(Boolean),
);

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

function validateSource(bundlePath) {
  const identifier = plistValue(bundlePath, "CFBundleIdentifier");
  if (
    !isKestrelBundle(bundlePath) ||
    !supportedBundleIdentifiers.has(identifier)
  ) {
    throw new Error(`Not a verified Kestrel app bundle: ${bundlePath}`);
  }
}

function moveDuplicatesToTrash(excludedPaths) {
  return moveDuplicateKestrelAppsToTrash({
    excludedPaths,
    searchRoots,
    trashRoot,
    mdfindPath: process.env.KESTREL_MDFIND_PATH,
    skipSpotlight: process.env.KESTREL_SKIP_SPOTLIGHT === "1",
    documentsRoot: process.env.KESTREL_DOCUMENTS_ROOT,
  });
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
  preventSpotlightIndexing(repositoryRoot);
  mkdirSync(installRoot, { recursive: true });
  if (existsSync(destination) && !isKestrelBundle(destination)) {
    throw new Error(`Refusing to replace a non-Kestrel app at ${destination}`);
  }

  const moved = moveDuplicatesToTrash([source, destination]);
  let stageRoot;
  if (!samePath(source, destination)) {
    const staged = stageBundle();
    stageRoot = staged.stageRoot;
    if (existsSync(destination)) {
      moved.push({
        from: destination,
        to: moveToTrash(destination, { trashRoot, reason: "previous" }),
      });
    }
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
  return { destination, moved };
}

const result = install();
console.log(`Installed Kestrel at ${result.destination}`);
for (const item of result.moved) console.log(`Moved duplicate to Trash: ${item.from} -> ${item.to}`);
