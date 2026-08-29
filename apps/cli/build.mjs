import { chmodSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = dirname(fileURLToPath(import.meta.url));

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
cpSync(
	join(packageRoot, "../../packages/database/migrations"),
	join(packageRoot, "dist/migrations"),
	{ recursive: true },
);
