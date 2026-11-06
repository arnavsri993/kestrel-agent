import { decodeNodeIpcMessage, encodeNodeIpcMessage } from "./ipc-codec";
import type { CoreParentPort } from "./transport";

export function nodeParentPort(): CoreParentPort {
	if (!process.send) throw new Error("Agent Core requires a parent IPC channel.");
	return {
		on: (_event, listener) => {
			process.on("message", (data) => listener({ data: decodeNodeIpcMessage(data) }));
			// Native-host or relay crashes must not leave an orphan Core writing
			// into a durable profile after its replacement has started.
			process.once("disconnect", () => listener({ data: { type: "shutdown" } }));
		},
		postMessage: (message) => {
			if (!process.connected) return;
			// IPC can close between the connected check and send. Consume that
			// asynchronous error while disconnect initiates orderly shutdown.
			process.send!(encodeNodeIpcMessage(message), undefined, undefined, () => {});
		},
	};
}
