import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { sourceProvenance } from "../../scripts/build-provenance.mjs";
const buildIdentity = sourceProvenance();

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "out/index.js",
  bundle: true,
  define: { __KESTREL_BUILD_IDENTITY__: JSON.stringify(buildIdentity) },
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3", "sharp"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [{
    name: "reject-electron",
    setup(builder) {
      builder.onResolve({ filter: /^electron(?:$|\/|-)/ }, ({ path }) => ({
        errors: [{ text: `Standalone Agent Core cannot import ${path}` }],
      }));
    },
  }],
  metafile: true,
});
if (Object.keys(result.metafile.inputs).some((path) => /node_modules\/electron(?:\/|-)/.test(path))) {
  throw new Error("Standalone Agent Core must not include Electron.");
}
await mkdir("out/migrations", { recursive: true });
await cp("../../packages/database/migrations", "out/migrations", { recursive: true });
await writeFile("out/metafile.json", JSON.stringify(result.metafile, null, 2));
await writeFile("out/build-provenance.json", JSON.stringify(buildIdentity));
console.log("Built standalone Node Agent Core without Electron.");
