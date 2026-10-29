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
	await cp(join(root, "apps/native-chromium-host/resources/native-desktop-core.mjs"), join(resources, "native-desktop-core.mjs"));
	await cp(join(root, "apps/native-chromium-host/resources/native-core-configuration.mjs"), join(resources, "native-core-configuration.mjs"));
	await cp(join(root, "apps/native-chromium-host/resources/native-browser-relay.mjs"), join(resources, "native-browser-relay.mjs"));
	await cp(join(root, "apps/native-chromium-host/resources/native-automation-relay.mjs"), join(resources, "native-automation-relay.mjs"));
	await cp(join(root, "apps/native-chromium-host/resources/native-dialog-relay.mjs"), join(resources, "native-dialog-relay.mjs"));
	await build({ entryPoints: [join(root, "apps/native-chromium-host/resources/kestrel-ui/background.mjs")],
		outfile: join(resources, "kestrel-ui/background.mjs"), bundle: true, platform: "browser", format: "esm", target: "chrome152",
		logLevel: "warning" });
	await build({ stdin: { contents: 'export {RendererRequestSchema, CoreRequestSchema, UserBrowserStateSchema} from "./packages/shared-types/src/contracts.ts"; export {BrowserBackendWireRequestSchema, isUserBrowserBackendWireRequest} from "./apps/core-service/src/browser-backend-wire.ts"; export {nativeRequestTimeoutMs} from "./packages/shared-types/src/request-timeouts.ts"; export {NATIVE_PROVIDER_REQUEST_TYPES} from "./apps/desktop/src/main/native-provider-requests.ts"; export {NATIVE_WORKSPACE_REQUEST_TYPES} from "./apps/desktop/src/main/native-workspace-host.ts";', resolveDir: root },
		outfile: join(resources, "native-ui-contracts.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
	await build({ stdin: { contents: 'export {CoreSupervisor} from "./apps/core-service/src/core-supervisor.ts"; export {nodeCoreProcess} from "./apps/core-service/src/node-core-process.ts"; export {CoreRequestSchema,RendererRequestSchema} from "./packages/shared-types/src/contracts.ts"; export {CredentialBroker,PlaintextSecretProtection} from "./apps/desktop/src/main/credential-broker.ts"; export {ProviderAccountStore} from "./apps/desktop/src/main/provider-account-store.ts"; export {ChatGptOAuthManager} from "./apps/desktop/src/main/chatgpt-oauth.ts"; export {NativeProviderHost} from "./apps/desktop/src/main/native-provider-host.ts"; export {NativeWorkspaceHost} from "./apps/desktop/src/main/native-workspace-host.ts"; export {NATIVE_PROVIDER_REQUEST_TYPES} from "./apps/desktop/src/main/native-provider-requests.ts"; export {NATIVE_WORKSPACE_REQUEST_TYPES} from "./apps/desktop/src/main/native-workspace-host.ts";', resolveDir: root },
		outfile: join(resources, "agent-core/service/native-desktop-runtime.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", external: ["better-sqlite3", "sharp"], logLevel: "warning",
		banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
		plugins: [{ name: "reject-electron", setup(builder) { builder.onResolve({ filter: /^electron(?:$|\/|-)/ }, ({ path }) => ({ errors: [{ text: `Native desktop Core cannot import ${path}` }] })); } }],
	});
}
