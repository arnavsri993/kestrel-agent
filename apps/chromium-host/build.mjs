import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"], outfile: "out/index.js", bundle: true,
  platform: "node", target: "node22", format: "esm",
  external: ["playwright", "better-sqlite3", "sharp"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [{ name: "reject-electron", setup(builder) {
    builder.onResolve({ filter: /^electron(?:$|\/|-)/ }, ({ path }) => ({ errors: [{ text: `Chromium host cannot import ${path}` }] }));
  } }],
});
console.log("Built Chromium host without Electron.");
