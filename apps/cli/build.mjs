import { chmodSync } from "node:fs";
import { build } from "esbuild";

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
	external: ["better-sqlite3", "sharp"],
	banner: {
		js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
	},
});

chmodSync("dist/kestrel.mjs", 0o755);
chmodSync("dist/kestrel-acp.mjs", 0o755);
