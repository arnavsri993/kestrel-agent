#!/usr/bin/env node

/**
 * Asserts the default product path is Chromium/CEF — Electron only via
 * explicit :electron / KESTREL_DESKTOP_RUNTIME=electron opt-in.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function electronRetired(rootDirectory = root) {
  return existsSync(join(rootDirectory, ".kestrel-electron-retired"));
}

const RUNTIME_SELECTORS = [
  "scripts/dev-desktop-runtime.mjs",
  "scripts/package-desktop-runtime.mjs",
  "scripts/install-desktop-runtime.mjs",
];

const DEFAULT_SCRIPTS = {
  dev: "node scripts/dev-desktop-runtime.mjs",
  "dev:desktop": "node scripts/dev-desktop-runtime.mjs",
  "package:mac:dev": "node scripts/package-desktop-runtime.mjs",
  "install:mac:dev": "node scripts/install-desktop-runtime.mjs",
};

const ELECTRON_OPT_IN_SCRIPTS = [
  "dev:desktop:electron",
  "package:mac:dev:electron",
  "install:mac:dev:electron",
  "test:desktop-smoke:electron",
  "build:desktop:electron",
];

const PRODUCT_PATH_SMOKE = {
  "test:desktop-smoke": "node scripts/smoke-native-desktop-shell.mjs",
  "test:native-desktop-shell": "node scripts/smoke-native-desktop-shell.mjs",
};

export function assertRuntimeDefaultsToChromium(source, path) {
  const failures = [];
  if (!source.includes('KESTREL_DESKTOP_RUNTIME ?? "chromium"')) {
    failures.push(
      `${path} must default with KESTREL_DESKTOP_RUNTIME ?? "chromium"`,
    );
  }
  if (/KESTREL_DESKTOP_RUNTIME\s*\?\?\s*"electron"/.test(source)) {
    failures.push(`${path} must not default KESTREL_DESKTOP_RUNTIME to electron`);
  }
  return failures;
}

export function assertPackageProductPath(packageJson) {
  const failures = [];
  const scripts = packageJson.scripts ?? {};

  for (const [name, expected] of Object.entries({
    ...DEFAULT_SCRIPTS,
    ...PRODUCT_PATH_SMOKE,
  })) {
    const actual = scripts[name];
    if (actual !== expected) {
      failures.push(
        `package.json scripts.${name} must be ${JSON.stringify(expected)} (got ${JSON.stringify(actual)})`,
      );
    }
    if (typeof actual === "string" && /\belectron\b/i.test(actual) && !/:electron\b/.test(name)) {
      failures.push(
        `package.json scripts.${name} must not invoke Electron on the default product path`,
      );
    }
  }

  if (scripts.verify?.includes("test:desktop-smoke:electron")) {
    failures.push(
      "package.json scripts.verify must use the Chromium desktop shell smoke, not test:desktop-smoke:electron",
    );
  }
  if (scripts.verify?.includes("test:desktop-single-instance")) {
    failures.push(
      "package.json scripts.verify must not gate on Electron Playwright desktop suites; keep those under verify:electron-legacy",
    );
  }
  if (scripts.verify?.includes("benchmark:browser-agent")) {
    failures.push(
      "package.json scripts.verify must not gate on the Electron browser-agent benchmark; keep it under verify:electron-legacy",
    );
  }

  const retired = electronRetired();
  for (const name of ELECTRON_OPT_IN_SCRIPTS) {
    const actual = scripts[name];
    if (retired) {
      if (typeof actual === "string") {
        failures.push(
          `package.json scripts.${name} must be removed after retire:electron`,
        );
      }
      continue;
    }
    if (typeof actual !== "string" || actual.length === 0) {
      failures.push(
        `package.json scripts.${name} must remain as an explicit Electron opt-in until retire:electron`,
      );
      continue;
    }
    const referencesElectronLane =
      /\belectron\b/i.test(actual) ||
      /KESTREL_DESKTOP_RUNTIME=electron/.test(actual) ||
      /@kestrel\/desktop/.test(actual) ||
      /package:mac:dev:electron/.test(actual) ||
      /install-development-macos-app/.test(actual) ||
      /smoke-desktop\.mjs/.test(actual) ||
      /test-desktop-/.test(actual);
    if (!referencesElectronLane) {
      failures.push(
        `package.json scripts.${name} must reference the Electron packaging lane (@kestrel/desktop, KESTREL_DESKTOP_RUNTIME=electron, or install-development-macos-app)`,
      );
    }
  }

  if (scripts["verify:meetup"]?.includes("package:mac:dev:electron")) {
    failures.push(
      "verify:meetup must package the Chromium product path (package:mac:dev), not package:mac:dev:electron",
    );
  }

  return failures;
}

export function assertCiPackagesChromiumFirst(
  ciWorkflow,
  electronLegacyWorkflow = "",
  { retired = false } = {},
) {
  const failures = [];
  const nativeMarker = "Package native Chromium product path";
  if (!ciWorkflow.includes(nativeMarker)) {
    failures.push(
      ".github/workflows/ci.yml must package the Chromium product path",
    );
  }
  for (const forbidden of [
    "Legacy Electron Playwright suite",
    "Legacy Electron packaged smokes",
    "build:desktop:electron",
    "package:mac:dev:electron",
    "test:packaged-desktop:arm64",
  ]) {
    if (ciWorkflow.includes(forbidden)) {
      failures.push(
        `.github/workflows/ci.yml must not run ${forbidden}; keep Electron under ci-electron-legacy.yml until retire:electron`,
      );
    }
  }
  if (
    !ciWorkflow.includes("package:mac:dev") ||
    !ciWorkflow.includes("test:packaged-native:arm64") ||
    !ciWorkflow.includes("test:packaged-native-desktop-shell:arm64") ||
    !ciWorkflow.includes("test:packaged-native-zero-electron-bundle:arm64") ||
    !ciWorkflow.includes("test:packaged-native-dock-canonical:arm64") ||
    !ciWorkflow.includes("test:native-desktop-shell")
  ) {
    failures.push(
      ".github/workflows/ci.yml must run package:mac:dev, packaged native host/shell/zero-electron-bundle/dock-canonical smokes, and test:native-desktop-shell on the product path",
    );
  }
  if (retired) {
    if (electronLegacyWorkflow.trim().length > 0) {
      failures.push(
        ".github/workflows/ci-electron-legacy.yml must be removed after retire:electron",
      );
    }
  } else if (
    !electronLegacyWorkflow.includes("Legacy Electron") ||
    !electronLegacyWorkflow.includes("build:desktop:electron") ||
    !electronLegacyWorkflow.includes("package:mac:dev:electron")
  ) {
    failures.push(
      ".github/workflows/ci-electron-legacy.yml must keep the opt-in Electron Playwright/packaged suite until retire:electron",
    );
  }
  return failures;
}

export function assertDesktopPackageProductBuild(desktopPackage, { retired = false } = {}) {
  const failures = [];
  const scripts = desktopPackage.scripts ?? {};
  if (scripts.build !== "pnpm build:renderer") {
    failures.push(
      'apps/desktop/package.json scripts.build must be "pnpm build:renderer" (Electron main/preload stays under build:electron until retirement)',
    );
  }
  if (retired) {
    if (scripts["build:electron"]) {
      failures.push(
        "apps/desktop/package.json scripts.build:electron must be removed after retire:electron",
      );
    }
  } else if (
    typeof scripts["build:electron"] !== "string" ||
    !scripts["build:electron"].includes("electron-vite")
  ) {
    failures.push(
      "apps/desktop/package.json scripts.build:electron must keep the Electron main/preload build until retire:electron",
    );
  }
  if (typeof scripts.build === "string" && /electron-vite/.test(scripts.build)) {
    failures.push(
      "apps/desktop/package.json scripts.build must not invoke electron-vite on the product path",
    );
  }
  return failures;
}

export function verifyChromiumProductPath({
  rootDirectory = root,
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  const failures = [];
  const retired = electronRetired(rootDirectory);
  const packageJson = JSON.parse(
    readText(join(rootDirectory, "package.json")),
  );
  failures.push(...assertPackageProductPath(packageJson));
  failures.push(
    ...assertDesktopPackageProductBuild(
      JSON.parse(readText(join(rootDirectory, "apps/desktop/package.json"))),
      { retired },
    ),
  );

  for (const relative of RUNTIME_SELECTORS) {
    const path = join(rootDirectory, relative);
    failures.push(
      ...assertRuntimeDefaultsToChromium(readText(path), relative),
    );
  }

  let legacyWorkflow = "";
  try {
    legacyWorkflow = readText(
      join(rootDirectory, ".github/workflows/ci-electron-legacy.yml"),
    );
  } catch {
    legacyWorkflow = "";
  }
  failures.push(
    ...assertCiPackagesChromiumFirst(
      readText(join(rootDirectory, ".github/workflows/ci.yml")),
      legacyWorkflow,
      { retired },
    ),
  );

  return failures;
}

function main() {
  const failures = verifyChromiumProductPath();
  if (failures.length > 0) {
    console.error("verify:chromium-product-path failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    "verify:chromium-product-path ok — default product path is Chromium; Electron is opt-in only.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
