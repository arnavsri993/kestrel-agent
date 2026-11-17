import { join } from "node:path";

const nativeInstaller = root => join(root, "scripts", "install-native-chromium-macos.mjs");

export function desktopRuntimeInstallPlan({
	root,
	argv = [],
	env = process.env,
	nodeExecutable = process.execPath,
}) {
	const runtime = (env.KESTREL_DESKTOP_RUNTIME ?? "electron").toLowerCase();

	if (runtime === "chromium" || runtime === "native") {
		if (env.KESTREL_INSTALL_NATIVE_CANONICAL !== "1") {
			throw new Error("Native canonical install requires KESTREL_INSTALL_NATIVE_CANONICAL=1 after retirement acceptance. No app was changed.");
		}
		if (argv.length > 1 || argv[0]?.startsWith("-")) {
			throw new Error("Native install accepts one existing candidate .app path. Build options belong on package:mac:native.");
		}

		return {
			command: nodeExecutable,
			args: [nativeInstaller(root), ...argv],
		};
	}

	if (runtime !== "electron") {
		throw new Error(`Unknown KESTREL_DESKTOP_RUNTIME=${runtime}. Use electron or chromium.`);
	}

	return {
		command: "corepack",
		args: ["pnpm", "install:mac:dev"],
	};
}
