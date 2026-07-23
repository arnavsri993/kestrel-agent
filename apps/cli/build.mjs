import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: { kestrel: "src/index.ts", "kestrel-acp": "src/acp-entry.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  external: ["better-sqlite3"],
  banner: { js: "#!/usr/bin/env node" }
});

chmodSync("dist/kestrel.mjs", 0o755);
chmodSync("dist/kestrel-acp.mjs", 0o755);
