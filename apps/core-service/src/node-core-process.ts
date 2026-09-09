import { fork, type ChildProcess, type Serializable } from "node:child_process";
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
	return {
		on(event: "message" | "exit", listener: (...args: any[]) => void) {
			if (event === "message") {
				child.on("message", (message) =>
					listener(decodeNodeIpcMessage(message)),
				);
				return;
			}
			child.on("exit", listener as (code: number | null) => void);
		},
		once(event: "message" | "exit", listener: (...args: any[]) => void) {
			if (event === "message") {
				child.once("message", (message) =>
					listener(decodeNodeIpcMessage(message)),
				);
				return;
			}
			child.once("exit", listener as (code: number | null) => void);
		},
		postMessage: (message) => {
			if (!child.send(encodeNodeIpcMessage(message) as Serializable))
				throw new Error("Agent Core child process is not connected.");
		},
		kill: () => child.kill(),
	};
}
