import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const workspacePackages = [
	"@kestrel/agent-core",
	"@kestrel/database",
	"@kestrel/encryption",
	"@kestrel/policy-engine",
	"@kestrel/shared-types",
];

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

export default defineConfig({
	main: {
		plugins: [
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
				input: resolve(__dirname, "src/preload/index.ts"),
				output: { format: "cjs", entryFileNames: "index.cjs" },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, "src/renderer"),
		plugins: [react()],
	},
});
