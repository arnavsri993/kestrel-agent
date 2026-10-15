#!/usr/bin/env node

/**
 * Proves Electron packages and product-path Electron scripts are gone.
 * Run after retire:electron + pnpm install; fails while Electron remains.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertZeroElectron({
  rootDirectory = root,
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  const failures = [];
  const desktopPackage = JSON.parse(
    readText(join(rootDirectory, "apps/desktop/package.json")),
  );
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const bag = desktopPackage[section] ?? {};
    for (const name of ["electron", "electron-builder", "electron-vite", "electron-updater"]) {
      if (name in bag) {
        failures.push(`apps/desktop/package.json still declares ${section}.${name}`);
      }
    }
  }
  const scripts = desktopPackage.scripts ?? {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === "string" && /electron-vite|electron-builder|\belectron\b/.test(value)) {
      failures.push(`apps/desktop/package.json scripts.${name} still references Electron tooling`);
    }
  }

  const rootPackage = JSON.parse(readText(join(rootDirectory, "package.json")));
  const rootScripts = rootPackage.scripts ?? {};
  for (const [name, value] of Object.entries(rootScripts)) {
    if (name.endsWith(":electron") || /KESTREL_DESKTOP_RUNTIME=electron/.test(value)) {
      failures.push(`package.json scripts.${name} still exposes an Electron opt-in`);
    }
  }

  return failures;
}

function main() {
  const failures = assertZeroElectron();
  if (failures.length > 0) {
    console.error("verify:zero-electron failed — Electron remains on the product path:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    "verify:zero-electron ok — Electron packages and opt-in scripts are gone from the product path.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
