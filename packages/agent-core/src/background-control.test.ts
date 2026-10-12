import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { expect, it } from "vitest";
import { AgentCore } from "./index";
import { teacherApproval } from "./fixtures";
import type { ModelProvider } from "./providers";
import { AgentRuntime } from "./runtime";
import { AgentLoop } from "./agent-loop";
import { ProviderPool } from "./providers";
import { TaskOrchestrator } from "./orchestration";

it("keeps background pause through incidental state changes and a core restart, then resumes the same job", async () => {
	const root = mkdtempSync(join(tmpdir(), "kestrel-background-control-"));
	const path = join(root, "state.sqlite");
	const key = createEncryptionKey();
	let calls = 0;
	const provider: ModelProvider = {
		id: "pause-fixture",
		capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: true },
		complete: async request => {
			calls++;
			return { providerId: "pause-fixture", model: request.model, text: "Verified fixture outcome.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
		},
	};
	let database = new KestrelDatabase(path, key);
	const create = () => new AgentCore({ database, modelProviders: [provider], seedDevelopmentFixtures: false });
	let core = create();
	try {
		const parent = core.runtime.createSession({ title: "Paused scheduled work", kind: "agent", allowedTools: [] });
		const job = core.orchestrator.schedule({ sessionId: parent.id, title: "One bounded task", prompt: "Return a text outcome.", model: "fixture", providerIds: [provider.id], schedule: { kind: "once", nextRunAt: "2026-01-01T00:00:00.000Z" } });
		expect(core.setPaused(true).agentState).toBe("paused");
		database.saveApproval(teacherApproval);
		expect(core.reject(teacherApproval.id).agentState).toBe("paused");
		expect(await core.orchestrator.runDue()).toEqual([]);
		expect(calls).toBe(0);
		await core.close();
		database = new KestrelDatabase(path, key);
		core = create();
		expect(core.isPaused).toBe(true);
		expect(core.snapshot().agentState).toBe("paused");
		expect(await core.orchestrator.runDue()).toEqual([]);
		expect(core.orchestrator.listJobs()).toMatchObject([{ id: job.id, status: "pending" }]);
		expect(core.setPaused(false).agentState).toBe("idle");
		expect(await core.orchestrator.runDue()).toMatchObject([{ id: job.id, status: "completed" }]);
		expect(calls).toBe(1);
	} finally {
		await core.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("preserves a legacy paused profile until the user explicitly resumes", async () => {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	database.setState("agentState", "paused");
	const core = new AgentCore({ database, seedDevelopmentFixtures: false });
	try {
		expect(database.getState("agent.pauseRequested")).toBe(true);
		expect(core.isPaused).toBe(true);
		expect(core.setPaused(false).agentState).toBe("idle");
		expect(database.getState("agent.pauseRequested")).toBe(false);
	} finally { await core.close(); }
});

it("claims one job across real scheduler processes and propagates a peer's cancellation", async () => {
	const root = mkdtempSync(join(tmpdir(), "kestrel-scheduler-processes-"));
	const path = join(root, "state.sqlite");
	const key = createEncryptionKey();
	const database = new KestrelDatabase(path, key);
	const runtime = new AgentRuntime(database, [root]);
	const provider: ModelProvider = { id: "fixture", capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: true }, complete: async () => { throw new Error("Parent must never dispatch."); } };
	const pool = new ProviderPool([provider]);
	const orchestrator = new TaskOrchestrator(database, runtime, new AgentLoop(database, runtime, pool));
	const parent = runtime.createSession({ title: "Cross-process fixture", kind: "agent", workspaceRoot: root, allowedTools: [] });
	const job = orchestrator.schedule({ sessionId: parent.id, title: "One owned task", prompt: "Wait for stop.", model: "fixture", providerIds: [provider.id], schedule: { kind: "once", nextRunAt: "2026-01-01T00:00:00.000Z" } });
	const script = join(root, "scheduler.mjs");
	writeFileSync(script, `
import { KestrelDatabase } from ${JSON.stringify(fileURLToPath(new URL("../../database/src/index.ts", import.meta.url)))};
import { AgentRuntime, AgentLoop, ProviderPool, TaskOrchestrator } from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))};
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const [path,key,root,jobId,mode]=process.argv.slice(2);
const database=new KestrelDatabase(path,Buffer.from(key,'hex'));
const runtime=new AgentRuntime(database,[root]);
const provider={id:'fixture',capabilities:{streaming:false,tools:true,images:false,audio:false,documents:false,local:true},complete:async (_request,options)=>{
 appendFileSync(join(root,'calls.log'),'called\\n');
 process.stdout.write('STARTED\\n');
 await new Promise((_resolve,reject)=>{const signal=options?.signal; const stop=()=>reject(signal?.reason); if(signal?.aborted)stop(); else signal?.addEventListener('abort',stop,{once:true});});
 throw new Error('Stopped fixture');
}};
const pool=new ProviderPool([provider]);
const orchestrator=new TaskOrchestrator(database,runtime,new AgentLoop(database,runtime,pool));
const keepAlive=setInterval(()=>{},1000);
try {
 const jobs=await orchestrator.runDue();
 if(mode==='peer'){
  const before=orchestrator.listJobs().find(job=>job.id===jobId)?.status;
  orchestrator.cancelJob(jobId);
  console.log(JSON.stringify({mode,jobs,before}));
 }else console.log(JSON.stringify({mode,jobs}));
}finally{clearInterval(keepAlive);await pool.close();runtime.close();database.close();}
`);
	const children: ChildProcess[] = [];
	let started!: () => void;
	const began = new Promise<void>(resolve => { started = resolve; });
	const launch = (mode: string) => {
		const child = spawn(process.execPath, ["--import", "tsx", script, path, key.toString("hex"), root, job.id, mode], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
		children.push(child);
		let stdout = "";
		let stderr = "";
		child.stdout!.on("data", data => { stdout += String(data); if (stdout.includes("STARTED")) started(); });
		child.stderr!.on("data", data => { stderr += String(data); });
		return new Promise<string>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`Fixture scheduler exited ${code}: ${stderr}`)));
		});
	};
	try {
		const running = launch("worker");
		void running.catch(() => {});
		await Promise.race([began, running.then(() => { throw new Error("Worker exited before dispatch."); })]);
		const peer = JSON.parse((await launch("peer")).trim());
		expect(peer).toMatchObject({ mode: "peer", jobs: [], before: "running" });
		const worker = JSON.parse((await running).trim().split("\n").at(-1)!);
		expect(worker.jobs).toMatchObject([{ id: job.id, status: "cancelled" }]);
		expect(readFileSync(join(root, "calls.log"), "utf8").trim().split("\n")).toHaveLength(1);
		const cancelled = orchestrator.listJobs()[0]!;
		expect(database.getAgentRun(cancelled.lastRunId!)?.status).toBe("cancelled");
		expect(runtime.getSession(parent.id).status).not.toBe("cancelled");
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
		await pool.close(); runtime.close(); database.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);
