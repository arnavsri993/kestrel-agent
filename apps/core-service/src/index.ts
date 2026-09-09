import { startCoreService } from "./service";
import { nodeParentPort } from "./node-port";

startCoreService(nodeParentPort());
