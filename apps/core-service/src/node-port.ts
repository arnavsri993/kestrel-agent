import { decodeNodeIpcMessage, encodeNodeIpcMessage } from "./ipc-codec";
import type { CoreParentPort } from "./transport";

export function nodeParentPort(): CoreParentPort {
	if (!process.send) throw new Error("Agent Core requires a parent IPC channel.");
	return {
		on: (_event, listener) => process.on("message", (data) => listener({ data: decodeNodeIpcMessage(data) })),
		postMessage: (message) => { process.send!(encodeNodeIpcMessage(message)); },
	};
}
