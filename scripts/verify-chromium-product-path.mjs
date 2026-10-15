#!/usr/bin/env node

/**
 * Asserts the default product path is Chromium/CEF — Electron only via
 * explicit :electron / KESTREL_DESKTOP_RUNTIME=electron opt-in.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
];

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

  for (const [name, expected] of Object.entries(DEFAULT_SCRIPTS)) {
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

  for (const name of ELECTRON_OPT_IN_SCRIPTS) {
    const actual = scripts[name];
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
      /install-development-macos-app/.test(actual);
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

export function assertCiPackagesChromiumFirst(ciWorkflow) {
  const failures = [];
  const nativeMarker = "Package native Chromium product path";
  const electronLegacyMarker = "Legacy Electron packaged smokes";
  const nativeIndex = ciWorkflow.indexOf(nativeMarker);
  const electronIndex = ciWorkflow.indexOf(electronLegacyMarker);
  if (nativeIndex === -1) {
    failures.push(
      ".github/workflows/ci.yml must package the Chromium product path before Electron legacy smokes",
    );
  }
  if (electronIndex === -1) {
    failures.push(
      ".github/workflows/ci.yml must label Electron packaged smokes as legacy until retire:electron",
    );
  }
  if (nativeIndex !== -1 && electronIndex !== -1 && nativeIndex > electronIndex) {
    failures.push(
      ".github/workflows/ci.yml must run Chromium packaged smoke before Electron legacy packaging",
    );
  }
  if (!ciWorkflow.includes("package:mac:dev") || !ciWorkflow.includes("test:packaged-native:arm64")) {
    failures.push(
      ".github/workflows/ci.yml must run package:mac:dev and test:packaged-native:arm64 on the product path",
    );
  }
  return failures;
}

export function verifyChromiumProductPath({
  rootDirectory = root,
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  const failures = [];
  const packageJson = JSON.parse(
    readText(join(rootDirectory, "package.json")),
  );
  failures.push(...assertPackageProductPath(packageJson));

  for (const relative of RUNTIME_SELECTORS) {
    const path = join(rootDirectory, relative);
    failures.push(
      ...assertRuntimeDefaultsToChromium(readText(path), relative),
    );
  }

  failures.push(
    ...assertCiPackagesChromiumFirst(
      readText(join(rootDirectory, ".github/workflows/ci.yml")),
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
