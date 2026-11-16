import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Exercise the actual shutdown routine without a browser, app bundle or profile.
test("broker reports Core shutdown failure only after the child exits", async () => {
	const source = readFileSync(new URL("../resources/native-ui-broker.mjs", import.meta.url), "utf8");
	const shutdown = source.slice(source.indexOf("async function shutdown("), source.indexOf('\nprocess.stdout.on("error"'));
	for (const [childCode, signal, requestedCode, expectedCode] of [[0, null, 0, 0], [1, null, 0, 1], [null, "SIGKILL", 0, 1], [0, null, 7, 7]]) {
		const core = new EventEmitter();
		core.exitCode = null; core.signalCode = null;
		core.stdin = { destroyed: false, end() {} };
		core.kill = () => true;
		let result, cleanup = 0;
		const stop = runInNewContext(`(${shutdown})`, {
			core, stopping: false, shuttingDown: false,
			automationRelay: { close() {} }, nativeComputerRelay: { close() {} }, dialogRelay: { close() {} },
			sockets: new Set(), server: { close() {} },
			setTimeout: () => 1, clearTimeout() {},
			rm: async () => { cleanup++; }, socketDirectory: "/fixture", extensionRoot: "/fixture", configName: "config",
			join: (...parts) => parts.join("/"), key: { fill() {} },
			process: { exit(code) { result = code; } },
		});
		const pending = stop(requestedCode);
		assert.equal(result, undefined);
		assert.equal(cleanup, 0);
		core.exitCode = childCode; core.signalCode = signal; core.emit("exit", childCode, signal);
		await pending;
		assert.equal(result, expectedCode);
		assert.equal(cleanup, 2);
	}
});
