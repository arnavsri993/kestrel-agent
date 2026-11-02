import { HostProfileTransferWorkerState } from "./host-profile-transfer-worker-state.js";

// Standalone bundled Node entry point. No argv/env keys, network listener,
// model/tool registration, Electron dependency or automatic source discovery.
if (!process.argv.includes("--protected-host-pipe") || process.stdin.isTTY || process.stdout.isTTY) {
	process.stderr.write("Core transfer requires its protected native host pipes.\n");
	process.exit(1);
}
const MAX_FRAME = 64 * 1024;
const worker = new HostProfileTransferWorkerState();
let pending = Buffer.alloc(0), stopped = false, waitingForDrain = false;
const timer = setInterval(() => worker.expire(), 1_000); timer.unref();
function stop(): void {
	if (stopped) return; stopped = true;
	worker.close(); pending.fill(0); pending = Buffer.alloc(0); clearInterval(timer);
}
function invalidFrame(): void {
	stop(); process.exitCode = 1;
	emit(JSON.stringify({ requestId: null, ok: false, error: { code: "INVALID_FRAME", message: "The protected Core transfer frame is invalid.", published: false } }));
	process.stdin.destroy();
}
function emit(response: string): void {
	if (!process.stdout.write(response + "\n") && !waitingForDrain) {
		waitingForDrain = true; process.stdin.pause();
		process.stdout.once("drain", () => { waitingForDrain = false; if (!stopped) process.stdin.resume(); });
	}
}
process.stdin.on("data", (chunk: Buffer) => {
	try {
	if (stopped) return;
	let offset = 0;
	while (offset < chunk.length) {
		const newline = chunk.indexOf(10, offset), end = newline === -1 ? chunk.length : newline;
		const part = chunk.subarray(offset, end);
		if (pending.length + part.length > MAX_FRAME) { invalidFrame(); return; }
		const previous = pending; pending = Buffer.concat([pending, part]); previous.fill(0);
		if (newline === -1) break;
		try {
			const request: unknown = JSON.parse(pending.toString("utf8"));
			const response = JSON.stringify(worker.handle(request));
			if (Buffer.byteLength(response, "utf8") > MAX_FRAME) { invalidFrame(); return; }
			emit(response);
		} catch { invalidFrame(); return; }
		pending.fill(0); pending = Buffer.alloc(0); offset = newline + 1;
	}
	} finally { chunk.fill(0); }
});
process.stdin.on("end", () => { if (pending.length) invalidFrame(); else stop(); });
process.stdin.on("error", stop);
process.stdout.on("error", () => { stop(); process.stdin.destroy(); });
process.once("SIGTERM", () => { stop(); process.stdin.destroy(); });
process.once("SIGINT", () => { stop(); process.stdin.destroy(); });
process.once("exit", stop);
