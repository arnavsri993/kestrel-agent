import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";

const execFileAsync = promisify(execFile);
const MAX_FRAME = 64 * 1024;
const failure = () => new Error("The private data-transfer worker could not complete. Preserve the generated transfer folder.");
type Exit = { code: number | null; signal: NodeJS.Signals | null };
export class NativeProfileExportWorker {
	private pending: { id: string; resolve: (value: Record<string, any>) => void; reject: (error: Error) => void } | undefined;
	private bytes = Buffer.alloc(0);
	private failed = false;
	private stopped = false;
	private readonly exit: Promise<Exit>;
	private readonly child: ChildProcessWithoutNullStreams;
	private constructor(executable: string, entry: string, home: string) {
		this.child = spawn(executable, [entry, "--protected-host-pipe"], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
		// This channel never carries UI output or logs. Discard stderr without
		// reflecting any source/provider error text back to the calling renderer.
		this.child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
		this.exit = new Promise(resolve => this.child.once("close", (code, signal) => { this.stopped = true; this.reject(); resolve({ code, signal }); }));
		this.child.once("error", () => this.reject());
		this.child.stdin.on("error", () => this.reject());
		this.child.stdout.on("error", () => this.reject());
		this.child.stdout.on("data", (chunk: Buffer) => {
			try {
				if (this.failed) return;
				if (this.bytes.length + chunk.length > MAX_FRAME + 1) throw failure();
				const old = this.bytes; this.bytes = Buffer.concat([old, chunk]); old.fill(0);
				const newline = this.bytes.indexOf(10); if (newline < 0) return;
				if (newline !== this.bytes.length - 1 || !this.pending) throw failure();
				const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.bytes.subarray(0, newline)));
				if (!value || typeof value !== "object" || Array.isArray(value) || value.requestId !== this.pending.id || typeof value.ok !== "boolean") throw failure();
				const pending = this.pending; this.pending = undefined; pending.resolve(value);
				this.bytes.fill(0); this.bytes = Buffer.alloc(0);
			} catch { this.reject(); this.child.kill("SIGTERM"); }
			finally { chunk.fill(0); }
		});
	}
	private reject(): void {
		this.failed = true; this.bytes.fill(0); this.bytes = Buffer.alloc(0);
		const pending = this.pending; this.pending = undefined; pending?.reject(failure());
	}
	static async open(options: { executable: string; entry: string; home: string; signal: AbortSignal }): Promise<NativeProfileExportWorker> {
		if (options.signal.aborted) throw failure();
		const core = dirname(dirname(options.entry)), bundle = dirname(dirname(dirname(core)));
		if (!bundle.endsWith(".app") || core !== join(bundle, "Contents/Resources/agent-core") ||
			options.executable !== join(core, "node/bin/node") || options.entry !== join(core, "service/host-profile-project-transfer.js")) throw failure();
		const paths = [options.executable, options.entry];
		const witnesses = [];
		for (const path of paths) {
			const info = await lstat(path);
			if (await realpath(path) !== path || !info.isFile() || info.nlink !== 1 || ![0, process.getuid!()].includes(info.uid) || (info.mode & 0o022) || (path === options.executable && !(info.mode & 0o111))) throw failure();
			witnesses.push(info);
		}
		const home = await lstat(options.home);
		if (await realpath(options.home) !== options.home || !home.isDirectory() || home.uid !== process.getuid!() || (home.mode & 0o777) !== 0o700) throw failure();
		try { await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { timeout: 20000, signal: options.signal, maxBuffer: 4096 }); }
		catch { throw failure(); }
		for (let index = 0; index < paths.length; index++) {
			const path = paths[index]!, before = witnesses[index]!, after = await lstat(path);
			if (await realpath(path) !== path || ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].some(field => before[field as keyof typeof before] !== after[field as keyof typeof after])) throw failure();
		}
		if (options.signal.aborted) throw failure();
		return new NativeProfileExportWorker(options.executable, options.entry, options.home);
	}
	async request(method: string, values: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, any>> {
		if (this.pending || this.failed || this.stopped || signal.aborted) throw failure();
		const id = randomUUID();
		let frame: Buffer | undefined;
		try {
			frame = Buffer.from(JSON.stringify({ requestId: id, method, ...values }) + "\n");
			if (frame.length > MAX_FRAME) throw failure();
			return await new Promise((resolve, reject) => {
				const finish = (error: Error | undefined, value?: Record<string, any>) => { clearTimeout(timer); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(value!); };
				const abort = () => this.reject();
				const timer = setTimeout(() => this.reject(), 120000);
				this.pending = { id, resolve: value => finish(undefined, value), reject: error => finish(error) };
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) { abort(); return; }
				this.child.stdin.write(frame!, error => { frame?.fill(0); if (error) this.reject(); });
			});
		} finally { frame?.fill(0); delete values.sourceKeyBase64; delete values.destinationKeyBase64; }
	}
	async close(): Promise<{ confirmed: boolean; clean: boolean }> {
		this.reject();
		if (!this.stopped) this.child.stdin.end();
		const wait = async (ms: number) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try { return await Promise.race([this.exit, new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), ms); })]); }
			finally { if (timer) clearTimeout(timer); }
		};
		let outcome = await wait(2000);
		if (!outcome) { this.child.kill("SIGTERM"); outcome = await wait(2000); }
		if (!outcome) { this.child.kill("SIGKILL"); outcome = await wait(3000); }
		return { confirmed: !!outcome, clean: !!outcome && outcome.code === 0 && outcome.signal === null };
	}
}
