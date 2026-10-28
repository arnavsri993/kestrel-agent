import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const viteRequire = createRequire(require.resolve("vite"));
const { build } = viteRequire("esbuild");
export async function buildNativeUi({ renderer, resources }) {
	await cp(renderer, join(resources, "kestrel-ui"), { recursive: true });
	await cp(join(root, "apps/native-chromium-host/resources/kestrel-ui"), join(resources, "kestrel-ui"), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
	await cp(join(root, "apps/native-chromium-host/resources/native-ui-broker.mjs"), join(resources, "native-ui-broker.mjs"));
	await build({ entryPoints: [join(root, "apps/native-chromium-host/resources/kestrel-ui/background.mjs")],
		outfile: join(resources, "kestrel-ui/background.mjs"), bundle: true, platform: "browser", format: "esm", target: "chrome152",
		logLevel: "warning" });
	await build({ stdin: { contents: 'export {RendererRequestSchema, CoreRequestSchema, UserBrowserStateSchema} from "./packages/shared-types/src/contracts.ts";', resolveDir: root },
		outfile: join(resources, "native-ui-contracts.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
}
