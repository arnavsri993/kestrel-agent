import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import {
	createRendererCspNonce,
	rendererCspNoncePlugin,
} from "./vite-plugins/renderer-csp-nonce";

const workspacePackages = [
	"@kestrel/agent-core",
	"@kestrel/database",
	"@kestrel/encryption",
	"@kestrel/policy-engine",
	"@kestrel/shared-types",
];

const databaseMigrationsDirectory = resolve(
	__dirname,
	"../../packages/database/migrations",
);

function emitDatabaseMigrations(): Plugin {
	return {
		name: "kestrel-database-migrations",
		apply: "build",
		generateBundle() {
			for (const filename of readdirSync(databaseMigrationsDirectory)
				.filter((candidate) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(candidate))
				.sort()) {
				this.emitFile({
					type: "asset",
					fileName: `migrations/${filename}`,
					source: readFileSync(
						join(databaseMigrationsDirectory, filename),
						"utf8",
					),
				});
			}
		},
	};
}

// electron-vite injects this after the last `import` match. Bundled remote-web
// HTML/JS strings can match that regex and leave a mid-chunk import that esbuild
// rejects. Putting the identical Node 20.11+ shim in the banner skips injection.
const electronViteCjsShim = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;

const rendererCspNonce = createRendererCspNonce();

export default defineConfig({
	main: {
		plugins: [
			emitDatabaseMigrations(),
			externalizeDepsPlugin({ exclude: [...workspacePackages, "zod"] }),
		],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
					utility: resolve(__dirname, "src/utility/index.ts"),
				},
				output: {
					banner: electronViteCjsShim,
				},
			},
		},
	},
	preload: {
		plugins: [
			externalizeDepsPlugin({ exclude: [...workspacePackages, "zod"] }),
		],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/preload/index.ts"),
					userBrowser: resolve(__dirname, "src/preload/user-browser.ts"),
				},
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, "src/renderer"),
		plugins: [react(), rendererCspNoncePlugin(rendererCspNonce)],
		html: {
			// Per dev-server start / production build. Static in packaged file:// output;
			// still blocks naive inline script injection without the matching nonce attribute.
			cspNonce: rendererCspNonce,
		},
	},
});
