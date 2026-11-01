import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ADVISORY, ALLOWED_PATHS, BRACE, EXPIRES, PATCHES, SOURCES, applyAuditPolicy, assessAudit, auditEnvironment, parseAuditResult, verifyManifest, verifySourceHashes } from "./audit-minimatch-policy.mjs";
const now = new Date("2026-11-01T12:00:00Z");
const knownPath = "apps__desktop>electron-builder>app-builder-lib>minimatch";
const report = () => ({
  advisories: { "1244012": { id: 1244012, github_advisory_id: ADVISORY, module_name: "minimatch", severity: "moderate", vulnerable_versions: "<11.0.1", patched_versions: ">=11.0.1", findings: ["10.2.5", "3.1.5", "5.1.9", "9.0.9"].map(version => ({ version, paths: Object.entries(ALLOWED_PATHS).filter(([, value]) => value === version).map(([path]) => path), dev: true, optional: false, bundled: false })) } },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
});
function manifest() {
  const patchedDependencies = Object.fromEntries(Object.keys(PATCHES).map(version => [`minimatch@${version}`, `patches/minimatch@${version}.patch`]));
  const locked = Object.fromEntries(Object.entries(PATCHES).map(([version, hash]) => [`minimatch@${version}`, hash]));
  const snapshots = Object.fromEntries(Object.entries(PATCHES).map(([version, hash]) => [`minimatch@${version}(patch_hash=${hash})`, {}]));
  return [{ overrides: { "brace-expansion": "5.0.12" }, patchedDependencies }, { patchedDependencies: locked, snapshots }, { ...PATCHES }];
}
describe("temporary minimatch audit policy", () => {
  it("accepts only the reviewed dev-only path before expiry", () => {
    expect(assessAudit(report(), now)).toHaveLength(23);
    expect(assessAudit(report(), now)).toContainEqual({ path: knownPath, version: "10.2.5" });
    expect(Object.keys(ALLOWED_PATHS)).toHaveLength(23);
    expect(() => assessAudit(report(), new Date(EXPIRES))).toThrow(/expired/);
    expect(() => assessAudit(report(), new Date("invalid"))).toThrow(/time/);
  });
  it.each([
    ["production", r => { r.advisories["1244012"].findings[0].dev = false; }],
    ["optional", r => { r.advisories["1244012"].findings[0].optional = true; }],
    ["bundled", r => { r.advisories["1244012"].findings[0].bundled = true; }],
    ["new version", r => { r.advisories["1244012"].findings[0].version = "10.2.6"; }],
    ["new dependency path", r => { r.advisories["1244012"].findings[0].paths = [knownPath.replace("app-builder-lib", "other")]; }],
    ["missing flags", r => { delete r.advisories["1244012"].findings[0].bundled; }],
    ["unexpected metadata", r => { r.metadata.vulnerabilities.high = 1; }],
    ["new advisory", r => { r.advisories["99"] = { github_advisory_id: "GHSA-unknown", severity: "high" }; r.metadata.vulnerabilities.high = 1; }],
    ["changed range", r => { r.advisories["1244012"].vulnerable_versions = "<12"; }],
    ["duplicate path", r => { r.advisories["1244012"].findings[0].paths.push(knownPath); }],
    ["missing dependency path", r => { r.advisories["1244012"].findings[0].paths.pop(); }],
  ])("rejects %s", (_, mutate) => { const r = report(); mutate(r); expect(() => assessAudit(r, now)).toThrow(); });
  it("fails closed on audit transport, malformed JSON and exit status inconsistencies", () => {
    expect(parseAuditResult({ status: 1, stdout: JSON.stringify(report()) })).toEqual(report());
    expect(() => parseAuditResult({ status: null, error: new Error("offline") })).toThrow(/offline/);
    expect(() => parseAuditResult({ status: 1, stdout: "not json", stderr: "registry error" })).toThrow(/registry error/);
    expect(() => parseAuditResult({ status: 0, stdout: JSON.stringify(report()) })).toThrow(/inconsistent/);
    expect(() => parseAuditResult({ status: 1, stdout: JSON.stringify({ advisories: {} }) })).toThrow(/inconsistent/);
  });
  it("removes inherited audit ignore, severity and config overrides", () => {
    const isolated = auditEnvironment({ PATH: "/bin", npm_config_ignore: "GHSA-unexpected", npm_config_audit_level: "critical", PNPM_AUDIT_CONFIG: "ignore", NODE_OPTIONS: "--require evil", HOME: "/untrusted" }, "/private/temporary", "/trusted/corepack");
    expect(isolated).toEqual({ PATH: "/bin", HOME: "/private/temporary", XDG_CONFIG_HOME: "/private/temporary", NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null", COREPACK_HOME: "/trusted/corepack", COREPACK_ENABLE_NETWORK: "0" });
    expect(() => auditEnvironment({}, "/private/temporary", "/trusted/corepack")).toThrow();
  });
  it("requires installed evidence even when the audit report has no findings", () => {
    const empty = { advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } };
    let called = false;
    expect(applyAuditPolicy(empty, now, () => { called = true; })).toEqual([]);
    expect(called).toBe(true);
    expect(() => applyAuditPolicy(empty, now, () => { throw new Error("unpatched source"); })).toThrow(/unpatched source/);
  });
  it("rejects changed declarations, patch bytes, lock hashes and unpatched snapshots", () => {
    expect(() => verifyManifest(...manifest())).not.toThrow();
    for (const mutate of [
      ([w]) => { w.overrides["brace-expansion"] = "5.0.11"; },
      ([w]) => { delete w.patchedDependencies["minimatch@3.1.5"]; },
      ([, l]) => { l.patchedDependencies["minimatch@9.0.9"] = "bad"; },
      ([, l]) => { l.snapshots["minimatch@3.1.5"] = {}; },
      ([, l]) => { l.snapshots["minimatch@11.0.1"] = {}; },
      ([w]) => { w.overrides.minimatch = "11.0.1"; },
      ([, , hashes]) => { hashes["10.2.5"] = "bad"; },
    ]) { const args = manifest(); mutate(args); expect(() => verifyManifest(...args)).toThrow(); }
  });
  it("rejects changed installed minimatch or brace expansion source", () => {
    expect(() => verifySourceHashes("9.0.9", { ...SOURCES["9.0.9"] }, { ...BRACE }, "5.0.12")).not.toThrow();
    expect(() => verifySourceHashes("9.0.9", { ...SOURCES["9.0.9"], "dist/esm/index.js": "bad" }, { ...BRACE }, "5.0.12")).toThrow(/minimatch/);
    expect(() => verifySourceHashes("9.0.9", { ...SOURCES["9.0.9"] }, { ...BRACE, "dist/commonjs/index.js": "bad" }, "5.0.12")).toThrow(/brace/);
    expect(() => verifySourceHashes("9.0.9", { ...SOURCES["9.0.9"] }, { ...BRACE }, "5.0.11")).toThrow(/brace/);
    expect(() => verifySourceHashes("11.0.1", {}, { ...BRACE }, "5.0.12")).toThrow(/minimatch/);
  });
  it("rejects entrypoint redirection in each installed minimatch manifest", () => {
    const desktop = createRequire(resolve("apps/desktop/package.json"));
    const dependency = (parent, name) => createRequire(parent.resolve(`${name}/package.json`));
    const builder = dependency(dependency(desktop, "electron-builder"), "app-builder-lib");
    const asar = dependency(builder, "@electron/asar");
    const parents = {
      "3.1.5": dependency(asar, "glob"),
      "5.1.9": dependency(dependency(dependency(builder, "ejs"), "jake"), "filelist"),
      "9.0.9": dependency(builder, "@electron/universal"),
      "10.2.5": builder,
    };
    for (const [version, parent] of Object.entries(parents)) {
      const bytes = readFileSync(parent.resolve("minimatch/package.json"));
      const digest = value => createHash("sha256").update(value).digest("hex");
      expect(digest(bytes)).toBe(SOURCES[version]["package.json"]);
      const original = bytes.toString("utf8");
      const replacements = version === "3.1.5" || version === "5.1.9"
        ? [['"main": "minimatch.js"', '"main": "redirect.cjs"']]
        : [['"default": "./dist/commonjs/index.js"', '"default": "./redirect.cjs"'], ['"default": "./dist/esm/index.js"', '"default": "./redirect.mjs"']];
      for (const [before, after] of replacements) {
        expect(original).toContain(before);
        const changed = original.replace(before, after);
        const hashes = { ...SOURCES[version], "package.json": digest(changed) };
        expect(JSON.parse(changed).version).toBe(version);
        expect(() => verifySourceHashes(version, hashes, { ...BRACE }, "5.0.12")).toThrow(/minimatch/);
      }
    }
  });
});
