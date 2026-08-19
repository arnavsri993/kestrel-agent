import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "install-development-macos-app.mjs");

function createBundle(
  root,
  name,
  identifier = "com.kestrel.desktop.dev",
  productName = "Kestrel",
) {
  const bundle = join(root, name);
  mkdirSync(join(bundle, "Contents"), { recursive: true });
  writeFileSync(
    join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>${productName}</string>
<key>CFBundleDisplayName</key><string>${productName}</string>
</dict></plist>
`,
  );
  writeFileSync(join(bundle, "Contents", "payload.txt"), name);
  return bundle;
}

function runInstaller(source, installRoot, searchRoots, trashRoot, mdfindPath) {
  const environment = {
    ...process.env,
    KESTREL_MACOS_INSTALL_ROOT: installRoot,
    KESTREL_MACOS_SEARCH_ROOTS: searchRoots.join(":"),
    KESTREL_MACOS_TRASH_ROOT: trashRoot,
    KESTREL_SKIP_LSREGISTER: "1",
  };
  if (mdfindPath) environment.KESTREL_MDFIND_PATH = mdfindPath;
  else environment.KESTREL_SKIP_SPOTLIGHT = "1";

  return execFileSync(process.execPath, [script, source], {
    encoding: "utf8",
    env: environment,
  });
}

const testSuite = process.platform === "darwin" ? describe : describe.skip;

testSuite("development macOS app installer", () => {
  it("keeps one canonical app and trashes duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-installer-test-"));
    const installRoot = join(root, "Applications");
    const desktopRoot = join(root, "Desktop");
    const trashRoot = join(root, "Trash");
    mkdirSync(installRoot);
    mkdirSync(desktopRoot);

    const sourceRoot = join(root, "release");
    mkdirSync(sourceRoot);
    const source = createBundle(sourceRoot, "Kestrel.app");
    const previous = createBundle(installRoot, "Kestrel.app");
    writeFileSync(join(previous, "Contents", "payload.txt"), "previous");
    const duplicate = createBundle(desktopRoot, "Kestrel 2.app");
    const legacyVariant = createBundle(
      desktopRoot,
      "Kestrel Legacy.app",
      "com.kestrel.desktop.legacy",
      "Kestrel Legacy",
    );

    const output = runInstaller(source, installRoot, [installRoot, desktopRoot], trashRoot);
    const canonical = join(installRoot, "Kestrel.app");

    expect(output).toContain(`Installed Kestrel at ${canonical}`);
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(join(canonical, "Contents", "payload.txt"))).toBe(true);
    expect(readPayload(canonical)).toBe("Kestrel.app");
    expect(existsSync(duplicate)).toBe(false);
    expect(existsSync(legacyVariant)).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(trashRoot)).toHaveLength(3);
  });

  it("is safe to run repeatedly", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-installer-repeat-"));
    const installRoot = join(root, "Applications");
    const trashRoot = join(root, "Trash");
    mkdirSync(installRoot);
    const sourceRoot = join(root, "release");
    mkdirSync(sourceRoot);
    const source = createBundle(sourceRoot, "Kestrel.app");

    runInstaller(source, installRoot, [installRoot], trashRoot);
    runInstaller(source, installRoot, [installRoot], trashRoot);

    expect(readdirSync(installRoot)).toEqual(["Kestrel.app"]);
    expect(readdirSync(trashRoot)).toHaveLength(1);
  });

  it("trashes Spotlight-indexed build artifacts outside common install roots", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-installer-spotlight-"));
    const installRoot = join(root, "Applications");
    const trashRoot = join(root, "Trash");
    mkdirSync(installRoot);

    const sourceRoot = join(root, "release");
    mkdirSync(sourceRoot);
    const source = createBundle(sourceRoot, "Kestrel.app");
    const staleRoot = join(root, "old-worktree", "release", "mac-arm64");
    mkdirSync(staleRoot, { recursive: true });
    const stale = createBundle(staleRoot, "Kestrel.app");

    const fakeMdfind = join(root, "mdfind");
    writeFileSync(
      fakeMdfind,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${stale}\n`)});\n`,
      { mode: 0o755 },
    );
    chmodSync(fakeMdfind, 0o755);

    runInstaller(source, installRoot, [installRoot], trashRoot, fakeMdfind);

    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(trashRoot)).toHaveLength(1);
  });

  it("preserves relative framework symlinks when staging the app", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-installer-symlink-"));
    const installRoot = join(root, "Applications");
    const trashRoot = join(root, "Trash");
    mkdirSync(installRoot);
    const sourceRoot = join(root, "release");
    mkdirSync(sourceRoot);
    const source = createBundle(sourceRoot, "Kestrel.app");
    const frameworkRoot = join(
      source,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    mkdirSync(join(frameworkRoot, "Versions", "A"), { recursive: true });
    writeFileSync(
      join(frameworkRoot, "Versions", "A", "Electron Framework"),
      "framework",
    );
    symlinkSync("A", join(frameworkRoot, "Versions", "Current"));
    symlinkSync(
      "Versions/Current/Electron Framework",
      join(frameworkRoot, "Electron Framework"),
    );

    runInstaller(source, installRoot, [installRoot], trashRoot);

    const installedFramework = join(
      installRoot,
      "Kestrel.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    expect(readlinkSync(join(installedFramework, "Versions", "Current"))).toBe("A");
    expect(readlinkSync(join(installedFramework, "Electron Framework"))).toBe(
      "Versions/Current/Electron Framework",
    );
  });
});

function readPayload(bundle) {
  return readFileSync(join(bundle, "Contents", "payload.txt"), "utf8");
}
