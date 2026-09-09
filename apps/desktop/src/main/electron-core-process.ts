import { join } from "node:path";
import { utilityProcess } from "electron";
import type { CoreProcess } from "./core-process";
import { coreEnvironment } from "./core-process-environment";
import { nodeCoreProcess } from "./node-core-process";

// The current desktop owns host selection; the supervisor is host-independent.
export function desktopCoreProcess(): CoreProcess {
	const entryPath = join(__dirname, "utility.js");
	const env = coreEnvironment();
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
