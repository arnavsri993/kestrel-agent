import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { KestrelDatabase } from "@kestrel/database";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [], children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolveExit => child.once("exit", resolveExit)); } }
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function launch(guard = true, preload?: string) {
	const child = spawn(process.execPath, ["--import", "tsx", ...(preload ? ["--import", preload] : []), resolve("apps/core-service/src/host-profile-project-transfer-worker.ts"), ...(guard ? ["--protected-host-pipe"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
	children.push(child); child.stdin.on("error", () => {});
	const lines: string[] = [], waits: ((line: string) => void)[] = [];
	createInterface({ input: child.stdout }).on("line", line => { const wait = waits.shift(); if (wait) wait(line); else lines.push(line); });
	const next = () => new Promise<any>((done, reject) => {
		const timeout = setTimeout(() => reject(new Error("worker response timed out")), 10_000);
		const finish = (line: string) => { clearTimeout(timeout); done(JSON.parse(line)); };
		if (lines.length) finish(lines.shift()!); else waits.push(finish);
	});
	const exited = new Promise<number | null>(done => child.once("exit", done));
	return { child, next, exited, lines };
}
it("requires the protected pipe flag", async () => {
	const p = launch(false); p.child.stdin.end(); expect(await p.exited).toBe(1);
});
it("processes a generated encrypted profile plan and cancellation over the pipe", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-project-pipe-"))); roots.push(root);
	const source = join(root, "source"), destination = join(root, "destination");
	for (const path of [source, destination]) { await mkdir(path, { mode: 0o700 }); await mkdir(join(path, "database"), { mode: 0o700 }); }
	await writeFile(join(root, ".generated-fixture"), "generated\n", { mode: 0o600 });
	const key = randomBytes(32), db = new KestrelDatabase(join(source, "database/kestrel.sqlite"), key);
	const at = "2026-11-06T14:00:00.000Z";
	db.saveRuntimeSession({ id: "generated-session", title: "Generated", privacyMode: "private", allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at }); db.saveRuntimeMessage({ id: "generated-message", sessionId: "generated-session", role: "user", content: "Generated fixture", createdAt: at }); db.close();
	const p = launch(), id = randomUUID();
	p.child.stdin.write(JSON.stringify({ requestId: id, method: "plan-profile", sourceProfileRoot: source, destinationCoreRoot: destination, handoffId: randomUUID(), sourceKeyBase64: key.toString("base64") }) + "\n");
	const plan = await p.next(); expect(plan).toMatchObject({ requestId: id, ok: true });
	const cancelId = randomUUID(), invalidId = randomUUID();
	p.child.stdin.write(JSON.stringify({ requestId: cancelId, method: "cancel-profile", planId: plan.planId }) + "\n" + JSON.stringify({ requestId: invalidId, method: "cancel-profile", planId: plan.planId }) + "\n");
	expect(await p.next()).toMatchObject({ requestId: cancelId, ok: true, cancelled: true });
	expect(await p.next()).toMatchObject({ requestId: invalidId, ok: false });
	p.child.stdin.end(); expect(await p.exited).toBe(0); key.fill(0);
});
it.each(["{bad json}\n", "x".repeat(65537) + "\n", "unfinished"])("rejects malformed, oversized, and truncated input", async input => {
	const p = launch(); p.child.stdin.end(input); const response = await p.next();
	expect(response).toMatchObject({ requestId: null, ok: false, error: { code: "INVALID_FRAME" } }); expect(JSON.stringify(response)).not.toContain(input.slice(0, 20)); expect(await p.exited).toBe(1);
});
it("rejects a burst exceeding the bounded queue", async () => {
	const p = launch();
	p.child.stdin.write(Array.from({ length: 5 }, () => JSON.stringify({ requestId: randomUUID(), method: "cancel-profile" }) + "\n").join(""));
	expect(await p.next()).toMatchObject({ requestId: null, ok: false, error: { code: "INVALID_FRAME" } });
	expect(await p.exited).toBe(1);
});
it("assembles a fragmented frame", async () => {
	const p = launch(), id = randomUUID(), data = JSON.stringify({ requestId: id, method: "cancel-profile" });
	p.child.stdin.write(data.slice(0, 10)); p.child.stdin.write(data.slice(10) + "\n");
	expect(await p.next()).toMatchObject({ requestId: id, ok: false }); p.child.stdin.end(); expect(await p.exited).toBe(0);
});
it("closes on EOF without replying to queued requests", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-project-eof-"))); roots.push(root);
	const source = join(root, "source"), destination = join(root, "destination"), preload = join(root, "wait-for-eof.mjs");
	for (const path of [source, destination]) await mkdir(path, { mode: 0o700 });
	// Hold the first asynchronous path probe until EOF. A synchronous invalid
	// request can legitimately reply before EOF arrives; that is not this case.
	await writeFile(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.promises.lstat;
fs.promises.lstat=async function(path,...args){
 if(path===${JSON.stringify(join(destination, "pending-project-handoff.json"))} && !process.stdin.readableEnded)
  await new Promise(resolve=>process.stdin.once('end',resolve));
 return original.call(this,path,...args);
}; syncBuiltinESMExports();`, { mode: 0o600 });
	const p = launch(true, preload); p.child.stdin.end(JSON.stringify({ requestId: randomUUID(), method: "plan-profile", sourceProfileRoot: source, destinationCoreRoot: destination, handoffId: randomUUID(), sourceKeyBase64: randomBytes(32).toString("base64") }) + "\n" + JSON.stringify({ requestId: randomUUID(), method: "cancel-profile" }) + "\n");
	expect(await p.exited).toBe(0); expect(p.lines).toEqual([]);
});
