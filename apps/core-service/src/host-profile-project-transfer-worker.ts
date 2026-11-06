import { NativeProfileProjectTransfer } from "./native-profile-project-transfer.js";

// Private host-owned stdin/stdout only. Keys never travel in argv or env.
if (!process.argv.includes("--protected-host-pipe") || process.stdin.isTTY || process.stdout.isTTY) {
	process.stderr.write("Project transfer requires its protected native host pipes.\n");
	process.exit(1);
}
const MAX_FRAME = 64 * 1024, MAX_QUEUE = 4;
const worker = new NativeProfileProjectTransfer();
const decoder = new TextDecoder("utf-8", { fatal: true });
let pending = Buffer.alloc(0), queue: Buffer[] = [], stopped = false, running = false, draining = false;
let finishDrain: (() => void) | undefined;
const timer = setInterval(() => { void worker.expire().catch(() => { stop(); process.stdin.destroy(); }); }, 1_000);
timer.unref();
function stop(): void {
	if (stopped) return;
	stopped = true; clearInterval(timer);
	void worker.close().catch(() => {});
	pending.fill(0); pending = Buffer.alloc(0);
	for (const frame of queue) frame.fill(0);
	queue = []; finishDrain?.(); finishDrain = undefined;
}
function failFrame(): void {
	if (stopped) return;
	try { process.stdout.write('{"requestId":null,"ok":false,"error":{"code":"INVALID_FRAME","message":"The protected project transfer frame is invalid.","published":false}}\n'); } catch { /* transport already failed */ }
	process.exitCode = 1; stop(); process.stdin.destroy();
}
async function write(response: string): Promise<void> {
	if (stopped) return;
	if (process.stdout.write(response + "\n")) return;
	draining = true; process.stdin.pause();
	await new Promise<void>(resolve => {
		const finish = () => { process.stdout.off("drain", finish); finishDrain = undefined; resolve(); };
		finishDrain = finish; process.stdout.once("drain", finish);
	});
	draining = false;
}
async function processQueue(): Promise<void> {
	if (running || stopped) return;
	running = true;
	try {
		while (!stopped && queue.length) {
			const frame = queue.shift()!;
			let request: unknown;
			try { request = JSON.parse(decoder.decode(frame)); }
			catch { frame.fill(0); failFrame(); return; }
			frame.fill(0);
			const response = JSON.stringify(await worker.handle(request));
			if (stopped) return;
			if (Buffer.byteLength(response, "utf8") > MAX_FRAME) { failFrame(); return; }
			await write(response);
			if (!stopped && !draining && queue.length + 1 < MAX_QUEUE) process.stdin.resume();
		}
	} catch {
		if (!stopped) failFrame();
	} finally { running = false; }
}
process.stdin.on("data", (chunk: Buffer) => {
	try {
		if (stopped) return;
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
			const part = chunk.subarray(offset, end);
			if (pending.length + part.length > MAX_FRAME) { failFrame(); return; }
			const previous = pending; pending = Buffer.concat([pending, part]); previous.fill(0);
			if (newline < 0) break;
			if (queue.length + (running ? 1 : 0) >= MAX_QUEUE) { failFrame(); return; }
			queue.push(pending); pending = Buffer.alloc(0); offset = newline + 1;
		}
		if (queue.length + (running ? 1 : 0) >= MAX_QUEUE) process.stdin.pause();
		void processQueue();
	} finally { chunk.fill(0); }
});
process.stdin.on("end", () => { if (pending.length) failFrame(); else stop(); });
process.stdin.on("error", () => { stop(); process.stdin.destroy(); });
process.stdout.on("error", () => { stop(); process.stdin.destroy(); });
process.once("SIGTERM", () => { stop(); process.stdin.destroy(); });
process.once("SIGINT", () => { stop(); process.stdin.destroy(); });
process.once("exit", stop);
