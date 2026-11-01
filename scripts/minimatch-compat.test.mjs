import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const dependency = (parent, name) => createRequire(parent.resolve(`${name}/package.json`));
const builder = dependency(dependency(desktopRequire, "electron-builder"), "app-builder-lib");
const asar = dependency(builder, "@electron/asar");
const glob = dependency(asar, "glob");
const filelist = dependency(dependency(dependency(builder, "ejs"), "jake"), "filelist");
const universal = dependency(builder, "@electron/universal");
const consumers = { "3.1.5": glob, "5.1.9": filelist, "9.0.9": universal, "10.2.5": builder };
function minimatchFile(version, format) {
  const manifest = consumers[version].resolve("minimatch/package.json");
  expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe(version);
  expect(manifest).toContain("_patch_hash=");
  return join(dirname(manifest), version.startsWith("3.") || version.startsWith("5.") ? "minimatch.js" : `dist/${format}/index.js`);
}
async function load(version, format) {
  const file = minimatchFile(version, format);
  return format === "esm" ? import(pathToFileURL(file).href) : desktopRequire(file);
}
const entries = [
  ["3.1.5", "commonjs"], ["5.1.9", "commonjs"],
  ["9.0.9", "commonjs"], ["9.0.9", "esm"],
  ["10.2.5", "commonjs"], ["10.2.5", "esm"],
];

describe("patched minimatch and brace expansion compatibility", () => {
  it.each(entries)("matches braces and normal globs on %s %s", async (version, format) => {
    const module = await load(version, format);
    const Minimatch = module.Minimatch;
    const cases = [
      ["a.js", "*.js", {}, true], ["a.js", "!*.js", {}, false],
      ["a.txt", "!*.js", {}, true], [".secret", "*", {}, false],
      [".secret", "*", { dot: true }, true], ["dir/a.js", "**/*.js", {}, true],
      ["a.ts", "*.{js,ts}", {}, true], ["item3", "item{1..4}", {}, true],
      ["ad", "a{b,{c,d}}", {}, true], ["a{b,c}.js", String.raw`a\{b,c\}.js`, {}, true],
      ["a{b,c}", "a{b,c}", { nobrace: true }, true], ["a{b,c", "a{b,c", {}, true],
    ];
    for (const [file, pattern, options, expected] of cases)
      expect(new Minimatch(pattern, options).match(file), `${version} ${pattern}`).toBe(expected);
    expect(new Minimatch("foo/bar.txt").match("foo", true)).toBe(true);
    if (version.startsWith("10.")) expect(module.braceExpand("item{1..100}", { braceExpandMax: 16 })).toHaveLength(16);
    if (version.startsWith("9.") || version.startsWith("10.")) {
      const optimized = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
      expect(optimized.match("../a/b/../c/d")).toBe(true);
      expect(optimized.match("x/a/b/y/c/d")).toBe(true);
    }
    if (version.startsWith("3.") || version.startsWith("5.")) {
      expect(typeof module).toBe("function");
      const pattern = new Minimatch("**/*.js");
      expect(Array.isArray(pattern.set)).toBe(true);
      expect(Array.isArray(pattern.globSet)).toBe(true);
      expect(pattern.options).toBeTruthy();
      expect(module.GLOBSTAR).toBeTruthy();
      expect(Minimatch.prototype.firstPhasePreProcess).toBeUndefined();
      expect(Minimatch.prototype.secondPhasePreProcess).toBeUndefined();
      expect(new Minimatch(Array(18).fill("**/../a/b").join("/"), { optimizationLevel: 2 }).set).toHaveLength(1);
    }
  });
  it.each(entries.filter(([version]) => version.startsWith("9.") || version.startsWith("10.")))("bounds optimizer growth on %s %s", (version, format) => {
    const file = minimatchFile(version, format);
    const code = `import {createRequire} from 'node:module';
      const m = process.env.FORMAT === 'esm' ? await import(process.env.MODULE_URL) : createRequire(import.meta.url)(process.env.MODULE_PATH);
      const mm = new m.Minimatch(Array(18).fill('**/../a/b').join('/'), {optimizationLevel:2, braceExpandMax:64});
      const large = Array.from({length:1001}, (_, i) => ['x' + i]);
      if (mm.set.length !== 64 || mm.secondPhasePreProcess(large).length !== 1001) throw new Error('optimizer limits failed');
      const defaultBudget = new m.Minimatch(Array(11).fill('**/../a/b').join('/'), {optimizationLevel:2});
      if (defaultBudget.set.length <= 1000 || defaultBudget.set.length > 100000 ||
          !defaultBudget.match(Array(11).fill('x/a/b').join('/'))) throw new Error('default optimizer budget or matching failed');`;
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", code], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, FORMAT: format, MODULE_PATH: file, MODULE_URL: pathToFileURL(file).href },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it("runs glob 7 brace traversal with the installed legacy minimatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-minimatch-glob-")); temporary.push(dir);
    mkdirSync(join(dir, "nested"));
    for (const name of ["a.js", "b.ts", "c.txt"]) writeFileSync(join(dir, "nested", name), "fixture");
    expect(asar.resolve("minimatch/package.json")).toBe(glob.resolve("minimatch/package.json"));
    expect(asar("glob").sync("**/*.{js,ts}", { cwd: dir }).sort()).toEqual(["nested/a.js", "nested/b.ts"]);
  });
  it("packs, unpacks and extracts ASAR files using brace patterns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-minimatch-asar-")); temporary.push(dir);
    const source = join(dir, "source"), archive = join(dir, "app.asar"), output = join(dir, "extracted");
    mkdirSync(source);
    writeFileSync(join(source, "app.js"), "application");
    writeFileSync(join(source, "addon.node"), "native addon");
    writeFileSync(join(source, "library.dylib"), "native library");
    const asarPackage = builder("@electron/asar");
    await asarPackage.createPackageWithOptions(source, archive, { unpack: "*.{node,dylib}" });
    expect(readFileSync(join(`${archive}.unpacked`, "addon.node"), "utf8")).toBe("native addon");
    expect(readFileSync(join(`${archive}.unpacked`, "library.dylib"), "utf8")).toBe("native library");
    asarPackage.extractAll(archive, output);
    expect(readFileSync(join(output, "app.js"), "utf8")).toBe("application");
    expect(readFileSync(join(output, "addon.node"), "utf8")).toBe("native addon");
  });
});
