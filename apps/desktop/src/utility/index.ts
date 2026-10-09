import { startCoreService } from "@kestrel/core-service/service";
import { nodeParentPort } from "@kestrel/core-service/node-port";

// Desktop Agent Core always runs under a real Node child process. The entry
// is built by electron-vite for packaging convenience, but the runtime is Node
// IPC — never Electron's utilityProcess parentPort.
startCoreService(nodeParentPort());
