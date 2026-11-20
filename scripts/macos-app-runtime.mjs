import { existsSync } from "node:fs";
import { join } from "node:path";

// A shared production bundle identifier cannot distinguish Electron from the
// native host. Treat partial or mixed layouts as ambiguous, never as Electron.
export function macosAppRuntime(bundle, identifier) {
	const has = (...path) => existsSync(join(bundle, "Contents", ...path));
	const electron = has("Frameworks", "Electron Framework.framework") && has("Resources", "app.asar");
	const cef = has("Frameworks", "Chromium Embedded Framework.framework");
	const bridge = has("MacOS", "Kestrel Native Bridge");
	const relay = has("Resources", "native-core-relay.mjs");
	const nativeMarker = cef || bridge || relay || identifier === "com.kestrel.native-chromium-host.dev";
	if (electron && !nativeMarker) return "electron";
	if (!electron && (identifier === "com.kestrel.native-chromium-host.dev" || (cef && bridge && relay))) return "native";
	return "ambiguous";
}
