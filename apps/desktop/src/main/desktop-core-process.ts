import { join } from "node:path";
import { existsSync } from "node:fs";
import { app } from "electron";
import type { CoreProcess } from "./core-process";
import { coreEnvironment } from "./core-process-environment";
import { isPackagedKestrelRuntime } from "./default-browser";
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

/**
 * Desktop owns process selection; the supervisor remains host-independent.
 * Agent Core never runs inside Electron's utilityProcess — only a real Node
 * child (packaged sidecar or the development Node executable).
 */
export function desktopCoreProcess(): CoreProcess {
	const env = coreEnvironment();
	// The macOS branded Electron wrapper reports app.isPackaged=true even for
	// electron-vite development. Only the real production package uses the
	// Agent Core sidecar under Resources/.
	if (isPackagedKestrelRuntime(app.isPackaged)) {
		const sidecar = packagedAgentCoreSidecar();
		return nodeCoreProcess({
			executable: sidecar.executable,
			entryPath: sidecar.entryPath,
			env,
		});
	}

	const nodeExecutable = process.env.KESTREL_NODE_EXEC_PATH?.trim();
	if (!nodeExecutable) {
		throw new Error(
			"Agent Core requires a real Node.js executable. Launch Kestrel through the development launcher or set KESTREL_NODE_EXEC_PATH.",
		);
	}
	return nodeCoreProcess({
		executable: nodeExecutable,
		entryPath: join(__dirname, "utility.js"),
		env,
	});
}
