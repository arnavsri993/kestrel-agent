import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BuildIdentitySchema, embeddedBuildIdentity,
  type BuildIdentity, type DesktopBuildProvenance } from "@kestrel/shared-types";

const launchedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function isCanonicalMacExecutable(executablePath: string): boolean {
  return executablePath === "/Applications/Kestrel.app/Contents/MacOS/Kestrel";
}

export function componentBuildState(identities: Array<BuildIdentity | null>): DesktopBuildProvenance["componentState"] {
  const known = identities.filter((identity): identity is BuildIdentity => Boolean(identity));
  if (new Set(known.map(identity => identity.buildId)).size > 1) return "mismatched";
  return known.length === identities.length ? "matching" : "unverified";
}

export function desktopBuildProvenance(input: {
  renderer: BuildIdentity | null; preload: BuildIdentity | null; core: BuildIdentity | null;
}): DesktopBuildProvenance {
  const main = embeddedBuildIdentity();
  let installed: BuildIdentity | null = null;
  if (app.isPackaged) {
    const resources = process.platform === "darwin" ? "/Applications/Kestrel.app/Contents/Resources" : process.resourcesPath;
    try { installed = BuildIdentitySchema.parse(JSON.parse(readFileSync(join(resources, "build-provenance.json"), "utf8"))); }
    catch { /* Older installed bundles have no provenance; never infer it. */ }
  }
  const installationState = !app.isPackaged ? "development" : process.platform === "darwin" && !isCanonicalMacExecutable(process.execPath) ? "packaged-artifact" : !main || !installed ? "unverified" :
    main.buildId === installed.buildId ? "running-installed-build" : "installed-build-changed";
  return { main, ...input, installed, executablePath: process.execPath, launchedAt,
    componentState: componentBuildState([main, input.preload, input.renderer, input.core]), installationState };
}
