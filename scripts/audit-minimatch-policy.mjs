// Temporary, exact backport policy for GHSA-g3hv-75wg-m249.
// Upstream v11.0.1 fix: https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8
export const ADVISORY = "GHSA-g3hv-75wg-m249";
export const EXPIRES = "2026-12-01T00:00:00.000Z";
export const PATCHES = Object.freeze({
  "3.1.5": "705181d6ce27255ac9b9769d779e324711acf7c08b1514e9db7d03a986de7465",
  "5.1.9": "91207d50d68c402b0870e4bcf6e701c5ed32f7ce911083c5a474d2d9054b8d1d",
  "9.0.9": "a0c33db4af776735520d1384a1b8ac08d416e1acc831758c26229ef13d592ff6",
  "10.2.5": "64ec7340d0f1276aaaa0ac54d3f77dbe3cebee2fc76a545a4b958f5850083279",
});
export const SOURCES = Object.freeze({
  "3.1.5": { "package.json": "eefa1c89527d52bbb2e8b053fe8ecf3e3ced399bdba82cf27e0e92edfd833938", "minimatch.js": "53a5a37ca8a8be0339b406570843c49a5ce9238c92d77b55247bad6a38cc458b" },
  "5.1.9": { "package.json": "dc1b9424c2ec4c845ba05e7402f7d22807f4ac85d31725892fd3dcafaa08f800", "minimatch.js": "1ecfc91de11294ef8c32afaa13cb1a0d0840cb36563ad033caeeb4fc781bfa50" },
  "9.0.9": { "package.json": "07347ae64d38f4cc1be3ffcc83322ec40d4609f5f3e9dc027ae91a4617239ac2", "dist/commonjs/index.js": "d2bd4e4e096f9dff676b95ead6c3b18a257f560e45262a48248073b8aae5c019", "dist/esm/index.js": "9b9fc973ee4b1669fbd60a8067492958ac9eff8b3a554f387ba8ec93fca0d778" },
  "10.2.5": { "package.json": "4b3a08a7ad20dead8bbe4b4fe97a2746bded7c51d218ef3034eb4e330ad31f08", "dist/commonjs/index.js": "7e835c0a30f7b4f29f4ad8cf8c3e92b97ab23ed854a7a777f240d6bdf3d19231", "dist/esm/index.js": "37ba4ff4010cda499e890975983b78ebd5f2be2dd8506d938472de4af8e9ed25" },
});
export const BRACE = Object.freeze({
  "package.json": "8af7dc0916002266f3b01459ef691d9f834d8ecdb0e021263280a50b913d85fa",
  "dist/commonjs/index.js": "e0ede97c712339a70bae2c96c675b1ffd30052bdf57f37f5a97b5945c40a9ae6",
  "dist/esm/index.js": "eea9a18920e1cde68f0068c36c040541ad6e93b0bb89eaab38c8ab49925b90a8",
});
const desktop = "apps__desktop>electron-builder>";
const parents = ["app-builder-lib>", "dmg-builder>app-builder-lib>"];
const tails = {
  "3.1.5": ["@electron/asar>glob>", "@electron/asar>", "@electron/universal>@electron/asar>glob>", "@electron/universal>@electron/asar>", "@electron/universal>dir-compare>", "electron-builder-squirrel-windows>electron-winstaller>@electron/asar>glob>", "electron-builder-squirrel-windows>electron-winstaller>@electron/asar>", "electron-builder-squirrel-windows>electron-winstaller>temp>rimraf>glob>"],
  "5.1.9": ["ejs>jake>filelist>"],
  "9.0.9": ["@electron/universal>"],
  "10.2.5": [""],
};
export const ALLOWED_PATHS = Object.freeze(Object.fromEntries([
  ...Object.entries(tails).flatMap(([version, paths]) => parents.flatMap(parent => paths.map(path => [`${desktop}${parent}${path}minimatch`, version]))),
  ["apps__website>serve>serve-handler>minimatch", "3.1.5"],
]));
// Do not inherit npm/pnpm configuration, registry overrides, ignore lists or
// NODE_OPTIONS from the caller. The lockfile-only workspace has no config.
export function auditEnvironment(environment, temporary, corepackHome) {
  if (!environment.PATH || !temporary || !corepackHome) throw new Error("Cannot isolate audit environment.");
  return { PATH: environment.PATH, HOME: temporary, XDG_CONFIG_HOME: temporary,
    NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null", COREPACK_HOME: corepackHome, COREPACK_ENABLE_NETWORK: "0" };
}
function fail(message) { throw new Error(message); }

export function parseAuditResult(result) {
  if (result.error || ![0, 1].includes(result.status) || result.signal) fail(`pnpm audit could not complete: ${result.error?.message || `exit ${result.status}, signal ${result.signal}`} ${result.stderr || ""}`);
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail(`pnpm audit did not return valid JSON: ${result.stderr || String(result.stdout).slice(0, 500)}`); }
  if (!report?.advisories || typeof report.advisories !== "object" || Array.isArray(report.advisories)) fail("Invalid audit report.");
  if ((result.status === 0) !== (Object.keys(report.advisories).length === 0)) fail("pnpm audit exit status is inconsistent with its report.");
  return report;
}

// Audit findings must be exactly the reviewed advisory, metadata and paths;
// every unknown or inconsistent report is a failure.
export function assessAudit(report, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("Invalid audit time.");
  if (now >= new Date(EXPIRES)) fail(`Backport exception expired ${EXPIRES}.`);
  if (!report || typeof report !== "object" || !report.advisories || typeof report.advisories !== "object" || Array.isArray(report.advisories)) fail("Invalid audit report.");
  const findings = Object.entries(report.advisories);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const accepted = [];
  for (const [key, advisory] of findings) {
    if (!advisory || !Object.hasOwn(counts, advisory.severity)) fail("Audit severity is missing or unrecognized.");
    counts[advisory.severity]++;
    if (key !== "1244012" || advisory.id !== 1244012 || advisory.github_advisory_id !== ADVISORY || advisory.module_name !== "minimatch" || advisory.severity !== "moderate" || advisory.vulnerable_versions !== "<11.0.1" || advisory.patched_versions !== ">=11.0.1") fail(`Unapproved audit finding: ${advisory.github_advisory_id || key}.`);
    if (!Array.isArray(advisory.findings) || !advisory.findings.length) fail("Advisory has no findings.");
    const seenPaths = new Set();
    for (const finding of advisory.findings) {
      if (!finding || !Object.hasOwn(PATCHES, finding.version) || finding.dev !== true || finding.optional !== false || finding.bundled !== false || !Array.isArray(finding.paths) || !finding.paths.length) fail("Unapproved version or audit dependency flags.");
      for (const path of finding.paths) {
        if (typeof path !== "string" || ALLOWED_PATHS[path] !== finding.version || seenPaths.has(path)) fail(`Unapproved or duplicate dependency path: ${path}.`);
        seenPaths.add(path);
        accepted.push({ path, version: finding.version });
      }
    }
    if (seenPaths.size !== Object.keys(ALLOWED_PATHS).length) fail("Audit dependency paths are incomplete or changed; re-review the dependency graph.");
  }
  const actual = report.metadata?.vulnerabilities;
  if (!actual || Object.keys(actual).length !== Object.keys(counts).length || Object.entries(counts).some(([key, count]) => actual[key] !== count)) fail("Audit vulnerability counts are inconsistent.");
  return accepted;
}

// Evidence is mandatory even when the scanner returns no advisories.
export function applyAuditPolicy(report, now, verifyEvidence) {
  const accepted = assessAudit(report, now);
  verifyEvidence();
  return accepted;
}

export function verifyManifest(workspace, lock, patchHashes) {
  if (workspace?.overrides?.["brace-expansion"] !== "5.0.12") fail("Expected brace-expansion 5.0.12 override.");
  if (Object.keys(workspace?.overrides || {}).some(key => key === "minimatch" || key.startsWith("minimatch@"))) fail("Unexpected minimatch override.");
  const declared = workspace?.patchedDependencies;
  const locked = lock?.patchedDependencies;
  if (!declared || !locked || Object.keys(declared).filter(key => key.startsWith("minimatch@")).length !== 4 || Object.keys(locked).filter(key => key.startsWith("minimatch@")).length !== 4) fail("Minimatch patch declaration or lock is incomplete.");
  const snapshots = Object.keys(lock.snapshots || {}).filter(key => key.startsWith("minimatch@"));
  if (snapshots.length !== 4) fail("Unexpected minimatch version or snapshot in lockfile.");
  for (const [version, expected] of Object.entries(PATCHES)) {
    const name = `minimatch@${version}`;
    if (declared[name] !== `patches/${name}.patch` || locked[name] !== expected || patchHashes[version] !== expected || !lock.snapshots?.[`${name}(patch_hash=${expected})`] || lock.snapshots?.[name]) fail(`Patch, lock, or snapshot mismatch for ${name}.`);
  }
}
export function verifySourceHashes(version, sourceHashes, braceHashes, braceVersion) {
  const expected = SOURCES[version];
  if (!expected || Object.keys(sourceHashes).length !== Object.keys(expected).length || Object.entries(expected).some(([file, hash]) => sourceHashes[file] !== hash)) fail(`Installed minimatch ${version} source does not match reviewed backport.`);
  if (braceVersion !== "5.0.12" || Object.keys(braceHashes).length !== Object.keys(BRACE).length || Object.entries(BRACE).some(([file, hash]) => braceHashes[file] !== hash)) fail(`Installed brace-expansion for minimatch ${version} does not match 5.0.12.`);
}
