import { join } from "node:path";
import { existsSync } from "node:fs";
import { app, utilityProcess } from "electron";
import type { CoreProcess } from "./core-process";
import { coreEnvironment } from "./core-process-environment";
import { nodeCoreProcess } from "./node-core-process";

export interface PackagedAgentCoreSidecar {
	executable: string;
	entryPath: string;
}

/**
 * The production desktop's Agent Core runs in a real Node child process.
 * It must stay outside app.asar: the runtime and its Node-ABI native modules
 * are physical, signed resources and must never be rebuilt for Electron.
 */
export function packagedAgentCoreSidecar(
	resourcesPath: string | undefined = process.resourcesPath,
): PackagedAgentCoreSidecar {
	if (!resourcesPath)
		throw new Error("Packaged Agent Core resources are unavailable.");
	const root = join(resourcesPath, "agent-core");
	const executable = join(root, "node", "bin", "node");
	const entryPath = join(root, "service", "index.js");
	if (!existsSync(executable) || !existsSync(entryPath))
		throw new Error(
			"Packaged standalone Agent Core is missing. Rebuild Kestrel with its Agent Core sidecar.",
		);
	return { executable, entryPath };
}

// The desktop owns process selection; the supervisor itself remains host-independent.
export function desktopCoreProcess(): CoreProcess {
	const env = coreEnvironment();
	if (app.isPackaged) {
		const sidecar = packagedAgentCoreSidecar();
		return nodeCoreProcess({
			executable: sidecar.executable,
			entryPath: sidecar.entryPath,
			env,
		});
	}

	const entryPath = join(__dirname, "utility.js");
	if (process.env.NODE_ENV_ELECTRON_VITE === "development" ||
		process.env.KESTREL_USE_NODE_CORE === "1") {
		return nodeCoreProcess({
			executable: process.env.KESTREL_NODE_EXEC_PATH ?? "",
			entryPath,
			env,
		});
	}
	return utilityProcess.fork(entryPath, [], {
		serviceName: "Kestrel Agent Core",
		env,
	});
}
