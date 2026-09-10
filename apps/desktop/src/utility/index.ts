import { startCoreService } from "@kestrel/core-service/service";
import { nodeParentPort } from "@kestrel/core-service/node-port";
import type { CoreParentPort } from "@kestrel/core-service/transport";

// Electron transport exists only in the desktop adapter. Development still
// launches this entry with Node; both hosts use the same service implementation.
const port = (process as typeof process & { parentPort?: CoreParentPort }).parentPort;
startCoreService(port ?? nodeParentPort());
