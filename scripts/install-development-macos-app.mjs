#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  basename,
  join,
  resolve,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { enterDeploymentLock } from "./macos-deployment-lock.mjs";
import { assertDeploymentCandidate, claimDeploymentOwner } from "./macos-deployment-policy.mjs";
import {
  defaultSearchRoots,
  isKestrelBundle,
  markDirectoryUnindexed,
  moveDuplicateKestrelAppsToTrash,
  moveToTrash,
  plistValue,
  preventSpotlightIndexing,
  removeStaleInstallStagingDirectories,
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
const sourceArgument = process.argv.slice(2).find((argument, index, arguments_) =>
  !argument.startsWith("--") && !["--deployment-lock-token", "--handoff-from"].includes(arguments_[index - 1]));
const source = resolve(process.argv.includes("--claim-owner") ? defaultSource : sourceArgument ?? defaultSource);
const home = process.env.HOME ?? homedir() ?? tmpdir();
const installRoot = resolve(process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications");
const destination = join(installRoot, "Kestrel.app");
const assertLock = enterDeploymentLock(import.meta.filename, installRoot, {
  workspace: repositoryRoot, intendedArtifact: source,
  intendedCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
});
if (process.argv.includes("--claim-owner")) {
  assertLock();
  const handoffIndex = process.argv.indexOf("--handoff-from");
  const owner = claimDeploymentOwner(repositoryRoot, installRoot, handoffIndex === -1 ? undefined : process.argv[handoffIndex + 1]);
  console.log(`Canonical deployment owner: ${owner.workspace} (${owner.sourceCommit})`);
  process.exit(0);
}
// Existing installer fixtures are restricted to dedicated temporary install
// roots. This switch can never bypass policy at /Applications or a real profile.
const fixtureInstall = process.env.KESTREL_MACOS_TEST_INSTALL === "1" &&
  realpathSync(installRoot).startsWith(`${realpathSync(tmpdir())}/kestrel-installer-`);
function assertCandidate(bundlePath = source) {
  assertLock();
  if (!fixtureInstall) return assertDeploymentCandidate({ repositoryRoot, installRoot, source: bundlePath, destination });
}
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
  if (!fixtureInstall) {
    // Validate every signed resource, including framework links and the
    // provenance manifest, before touching the previous canonical bundle.
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundlePath], { stdio: "ignore" });
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
  // Keep the temporary copy out of Spotlight while ditto is copying it. A
  // transient registration here otherwise survives the rename into /Applications
  // and makes Finder show a second Kestrel after a later cleanup.
  markDirectoryUnindexed(stageRoot);
  try {
    copyBundle(source, stagedBundle);
    return { stageRoot, stagedBundle };
  } catch (error) {
    unregister(stagedBundle);
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function install() {
  validateSource(source);
  assertCandidate();
  preventSpotlightIndexing(repositoryRoot);
  mkdirSync(installRoot, { recursive: true });
  if (existsSync(destination) && !isKestrelBundle(destination)) {
    throw new Error(`Refusing to replace a non-Kestrel app at ${destination}`);
  }

  const removedStaging = removeStaleInstallStagingDirectories(installRoot);
  const moved = moveDuplicatesToTrash([source, destination]);
  let staged;
  if (!samePath(source, destination)) {
    staged = stageBundle();
    try {
      // Revalidate owner, integrated source and the copied artifact immediately
      // before moving the previous app. A changed source/build cannot slip in.
      validateSource(staged.stagedBundle);
      assertCandidate(staged.stagedBundle);
      let previousPath;
      if (existsSync(destination)) {
        previousPath = moveToTrash(destination, { trashRoot, reason: "previous" });
        moved.push({
          from: destination,
          to: previousPath,
        });
      }
      // Unregister the temporary path before the atomic rename so LaunchServices
      // cannot retain a second path for the same bundle.
      unregister(staged.stagedBundle);
      try {
        assertLock();
        renameSync(staged.stagedBundle, destination);
      } catch (error) {
        // Retain a runnable canonical path if replacement fails after backup.
        if (previousPath && !existsSync(destination)) renameSync(previousPath, destination);
        throw error;
      }
      unregister(source);
    } finally {
      unregister(staged.stagedBundle);
      rmSync(staged.stageRoot, { recursive: true, force: true });
    }
  }

  // A second pass catches duplicates that shared the canonical install root.
  // Keep the source build artifact available for packaged smoke tests; it is
  // already excluded from the first pass and must stay excluded here too.
  moved.push(...moveDuplicatesToTrash([destination, source]));
  validateSource(destination);
  register(destination);
  return { destination, moved, removedStaging };
}

const result = install();
console.log(`Installed Kestrel at ${result.destination}`);
for (const directory of result.removedStaging) {
  console.log(`Removed stale Kestrel install staging directory: ${directory}`);
}
for (const item of result.moved) console.log(`Moved duplicate to Trash: ${item.from} -> ${item.to}`);
