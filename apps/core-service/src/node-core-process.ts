import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { EventEmitter } from "node:events";
import type { CoreProcess } from "./core-process";
import { decodeNodeIpcMessage, encodeNodeIpcMessage } from "./ipc-codec";

export function nodeCoreProcess(options: {
	executable: string;
	entryPath: string;
	env: NodeJS.ProcessEnv;
}): CoreProcess {
	const nodeExecutable = options.executable;
	if (!nodeExecutable)
		throw new Error(
			"The Node executable was not provided for Agent Core.",
		);
	const child: ChildProcess = fork(options.entryPath, [], {
		execPath: nodeExecutable,
		execArgv: [],
		env: options.env,
		serialization: "json",
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	const events = new EventEmitter();
	let failed = false;
	let closed = false;
	const fail = () => {
		if (failed || closed) return;
		failed = true;
		// A broken transport leaves execution uncertain. Terminate the child and
		// let the supervisor reject in-flight work without replaying it. Wait for
		// close before recovery so two cores cannot own the same database.
		child.kill("SIGKILL");
	};
	child.on("error", fail);
	child.on("close", (code) => {
		if (closed) return;
		closed = true;
		events.emit("exit", code);
	});
	child.on("message", (message) => {
		if (!failed && !closed) events.emit("message", decodeNodeIpcMessage(message));
	});
	return {
		on: (event, listener) => events.on(event, listener),
		once: (event, listener) => events.once(event, listener),
		postMessage: (message) => {
			if (failed || closed || !child.connected)
				throw new Error("Agent Core child process is not connected.");
			// false means backpressure as well as disconnection. The callback is
			// authoritative for send failure; a queued request must not be retried.
			child.send(encodeNodeIpcMessage(message) as Serializable, (error) => {
				if (error) fail();
			});
		},
		kill: () => child.kill(),
	};
}
