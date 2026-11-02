import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export type TransferCrashPoint = "before-link" | "after-link" | "after-unlink" | "after-journal" | "hold-before-link";

// Test-only preload, never shipped in Kestrel. It instruments only one
// caller-created fixture destination and can kill only its own Node process.
// No production crash flag, argv/env key, approval bypass or real profile.
export async function writeCoreTransferCrashPreload(file: string, destination: string, point: TransferCrashPoint): Promise<void> {
	const configuration = JSON.stringify({ destination, point });
	await writeFile(file, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const configuration=${configuration};
const link=fs.linkSync,unlink=fs.unlinkSync,open=fs.openSync,sync=fs.fsyncSync;
let publishedSource,journalFd;
function crash(){process.kill(process.pid,'SIGKILL');}
fs.openSync=function(path,...args){const fd=open.call(fs,path,...args);if(path===configuration.destination+'.kestrel-transfer-journal')journalFd=fd;return fd;};
fs.fsyncSync=function(fd){sync.call(fs,fd);if(configuration.point==='after-journal'&&fd===journalFd)crash();};
fs.linkSync=function(source,destination){
 if(destination===configuration.destination){
  if(configuration.point==='hold-before-link'){fs.writeSync(3,'fixture-ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
  if(configuration.point==='before-link')crash();
  link.call(fs,source,destination);publishedSource=source;
  if(configuration.point==='after-link')crash();
 }else link.call(fs,source,destination);
};
fs.unlinkSync=function(path){unlink.call(fs,path);if(path===publishedSource&&configuration.point==='after-unlink')crash();};
syncBuiltinESMExports();
`, { mode: 0o600, flag: "wx" });
}

export function launchCoreTransferFixture(options: { executable: string; entry: string; home: string; preload?: string }) {
	const child = spawn(options.executable, [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), options.entry, "--protected-host-pipe"], {
		env: { HOME: options.home, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, stdio: ["pipe", "pipe", "pipe", "pipe"],
	});
	let output = "", errors = "", readyOutput = "";
	const messages: Array<Record<string, unknown>> = [], pending = new Map<string, (value: Record<string, unknown>) => void>();
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("error", () => reject(new Error("Generated Core transfer worker could not start.")));
	});
	child.stdin!.on("error", () => {});
	child.stdout!.on("data", bytes => { output += bytes; }); child.stderr!.on("data", bytes => { errors += bytes; });
	const readyStream = child.stdio[3];
	readyStream?.on("data", bytes => { readyOutput += bytes; });
	createInterface({ input: child.stdout! }).on("line", line => {
		let value: Record<string, unknown>; try { value = JSON.parse(line); } catch { return; }
		messages.push(value);
		if (typeof value.requestId === "string") { pending.get(value.requestId)?.(value); pending.delete(value.requestId); }
	});
	function send(method: string, values: Record<string, unknown> = {}): { response: Promise<Record<string, unknown>>; settled: Promise<Record<string, unknown> | { exited: true }> } {
		const requestId = randomUUID();
		const response = new Promise<Record<string, unknown>>(resolve => pending.set(requestId, resolve));
		child.stdin!.write(JSON.stringify({ requestId, method, ...values }) + "\n");
		return { response, settled: Promise.race([response, exited.then(() => ({ exited: true as const }))]) };
	}
	async function request(method: string, values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const result = await Promise.race([send(method, values).settled, delay(30_000, undefined, { ref: false }).then(() => { throw new Error("Generated protected transfer request timed out."); })]);
		if ("exited" in result) throw new Error("Generated protected transfer worker stopped before responding.");
		return result;
	}
	async function ready(): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) { if (readyOutput.includes("fixture-ready")) return; if (child.exitCode !== null || child.signalCode !== null) break; await delay(20); }
		throw new Error("Generated crash fixture did not reach its boundary.");
	}
	async function stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		if (child.exitCode === null && child.signalCode === null) child.stdin!.end();
		return Promise.race([exited, delay(10_000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); throw new Error("Generated transfer fixture did not stop."); })]);
	}
	return { child, exited, request, send, ready, stop, messages, output: () => output, errors: () => errors };
}
