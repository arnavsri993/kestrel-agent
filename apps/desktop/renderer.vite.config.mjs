import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

const rendererDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererRoot = resolve(rendererDirectory, "src/renderer");
const reactPlugin = react.default ?? react;

function rejectElectronImports() {
	return {
		name: "kestrel-renderer-no-electron-imports",
		resolveId(source) {
			if (/^electron(?:$|\/|-)/.test(source)) {
				throw new Error(
					`Renderer build cannot import Electron module: ${source}`,
				);
			}
			return null;
		},
	};
}

/** Plain Vite renderer configuration shared by Electron and native Chromium. */
export function createRendererViteConfig({
	base = "./",
	outDir = resolve(rendererDirectory, "out/renderer"),
	nonce = randomBytes(16).toString("base64"),
} = {}) {
	return {
		root: rendererRoot,
		base,
		plugins: [
			reactPlugin(),
			rejectElectronImports(),
			{
				name: "kestrel-renderer-csp-nonce",
				transformIndexHtml(html) {
					return html.replaceAll(
						"__KESTREL_RENDERER_CSP_NONCE__",
						nonce,
					);
				},
			},
		],
		html: { cspNonce: nonce },
		build: {
			emptyOutDir: true,
			rollupOptions: { input: resolve(rendererRoot, "index.html") },
			outDir,
			target: "es2022",
		},
	};
}
