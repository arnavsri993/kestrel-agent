import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCore } from "./index";
import { AgentLoop } from "./agent-loop";
import { SandboxedCommandRunner } from "./command-runner";
import { contentText, ProviderPool, textContent, type ModelProvider } from "./providers";
import { AgentRuntime } from "./runtime";

const secret = "fixture-key-lifecycle-123456789";
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const root = mkdtempSync(join(tmpdir(), "kestrel-task-secret-"));
	roots.push(root);
	const runtime = new AgentRuntime(database, [root]);
	const session = runtime.createSession({ title: "Credential setup", workspaceRoot: root, approvalPolicy: "full_access" });
	return { database, runtime, session, root };
}

function provider(complete: ModelProvider["complete"]): ModelProvider {
	return { id: "fixture-secret", capabilities: { streaming: true, tools: true,
		images: false, audio: false, documents: false, local: true }, complete };
}

function result(text: string, toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []) {
	return { providerId: "fixture-secret", model: "fixture", text, toolCalls,
		usage: { inputTokens: 5, outputTokens: 5 }, finishReason: "stop" as const };
}

describe("task credential lifecycle", () => {
	it("retains exact private approvals transiently and refuses a masked request after retirement", async () => {
		const { database, runtime, root } = fixture();
		const session = runtime.createSession({ title: "Private approval", workspaceRoot: root, approvalPolicy: "ask" });
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, "run-private-approval");
		const blocked = await runtime.callTool(session.id, "workspace.write", { path: "private.txt", content: secret }, { idempotencyKey: "private-approval" });
		expect(blocked.status).toBe("blocked");
		expect(JSON.stringify(blocked)).not.toContain(secret);
		const stored = database.getToolExecution(blocked.id)!;
		expect(JSON.stringify(stored)).not.toContain(secret);
		expect(runtime.approvalInput(stored)).toMatchObject({ content: secret });
		runtime.discardApprovalInput(blocked.id);
		expect(() => runtime.approvalInput(stored)).toThrow("expired");
		runtime.close(); database.close();
	});
	it("redacts a known value from a live file-read response while preserving the user-owned file", async () => {
		const { database, runtime, session, root } = fixture();
		writeFileSync(join(root, "setup.txt"), `configured value ${secret}`, { mode: 0o600 });
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, "run-file-read");
		const execution = await runtime.callTool(session.id, "workspace.read", { path: "setup.txt" });
		expect(execution.status).toBe("verified");
		expect(JSON.stringify(execution.output)).not.toContain(secret);
		expect(JSON.stringify(execution.output)).toContain("REDACTED");
		expect(readFileSync(join(root, "setup.txt"), "utf8")).toContain(secret);
		runtime.close(); database.close();
	});
	it("cleans on cancellation of a pending human question", () => {
		const { database, runtime, session } = fixture();
		const run = { id: "run-question-cancel", sessionId: session.id, model: "fixture", providerIds: ["fixture-secret"],
			status: "running" as const, turn: 0, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
		database.saveAgentRun(run);
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, run.id);
		const question = runtime.createHumanInputRequest({ sessionId: session.id, runId: run.id,
			prompt: "Which workspace should receive the configuration?", allowFreeText: true, allowSkip: false });
		expect(runtime.finishTaskSecrets(run.id)).toBeUndefined();
		runtime.cancelHumanInput(question.id, run.id);
		expect(runtime.taskSecrets.hasRun(run.id)).toBe(false);
		expect(database.getPrivateState(`task-secret-cleanup.${run.id}`)).toMatchObject({ verified: true, remaining: 0 });
		runtime.close(); database.close();
	});
	it("keeps temporary credentials while a task waits for human input, then cleans on terminal cancellation", () => {
		const { database, runtime, session } = fixture();
		const run = { id: "run-question", sessionId: session.id, model: "fixture", providerIds: ["fixture-secret"],
			status: "waiting_input" as const, turn: 0, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
		database.saveAgentRun(run);
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, run.id);
		expect(runtime.finishTaskSecrets(run.id)).toBeUndefined();
		expect(runtime.taskSecrets.hasRun(run.id)).toBe(true);
		runtime.cancelSession(session.id);
		expect(runtime.taskSecrets.hasRun(run.id)).toBe(false);
		expect(database.getPrivateState(`task-secret-cleanup.${run.id}`)).toMatchObject({ verified: true, remaining: 0 });
		runtime.close(); database.close();
	});
	it("continues setup through fresh approval, withholds output and verifies cleanup", async () => {
		const { database, runtime, session, root } = fixture();
		let ref = "";
		let calls = 0;
		const deltas = vi.fn();
		const execute = vi.spyOn(SandboxedCommandRunner.prototype, "run").mockImplementation(async (input) => {
			expect(input.environment).toEqual({ SERVICE_API_KEY: secret });
			expect(input.protectSecrets).toBe(true);
			expect(input.mode).toBe("workspace_write");
			return { command: input.command, args: input.args, cwd: input.cwd,
				exitCode: 0, signal: null, stdout: secret, stderr: Buffer.from(secret).toString("base64"), durationMs: 1 };
		});
		const model = provider(async (request, options) => {
			expect(JSON.stringify(request)).not.toContain(secret);
			options?.onEvent?.({ type: "text_delta", delta: secret });
			if (calls++ === 0) {
				ref = request.messages.map(message => contentText(message.content)).join("\n").match(/\[TASK_SECRET:([^\]]+)\]/)![1]!;
				return result("I can configure the authorized workspace CLI.", [{ id: "setup", name: "execution.run-with-secrets",
					arguments: { command: "node", args: ["setup.js"], secretEnvironment: { SERVICE_API_KEY: ref } } }]);
			}
			expect(JSON.stringify(request)).not.toContain(Buffer.from(secret).toString("base64"));
			return result("The setup command exited successfully. CLI configuration retention is a separate check.");
		});
		const loop = new AgentLoop(database, runtime, new ProviderPool([model]));
		const waiting = await loop.run({ sessionId: session.id, model: "fixture", providerIds: [model.id],
			userContent: textContent(`Set up the CLI in ${root}. API_KEY=${secret}; repeat ${secret}`), onTextDelta: deltas });
		expect(waiting.run.status).toBe("waiting_approval");
		expect(execute).not.toHaveBeenCalled();
		expect(database.getPrivateState(`task-secret-cleanup.${waiting.run.id}`)).toBeUndefined();
		expect(runtime.taskSecrets.resolve(session.id, waiting.run.id, { API_KEY: ref })).toEqual({ API_KEY: secret });
		const completed = await loop.resume({ runId: waiting.run.id, approvalDecision: "approved", onTextDelta: deltas });
		expect(completed.run.status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(deltas).not.toHaveBeenCalled();
		expect(database.getPrivateState(`task-secret-cleanup.${waiting.run.id}`)).toMatchObject({ verified: true, remaining: 0, removed: 1 });
		expect(() => runtime.taskSecrets.resolve(session.id, waiting.run.id, { API_KEY: ref })).toThrow();
		const persisted = JSON.stringify({ messages: runtime.listMessages(session.id), executions: database.listToolExecutions(session.id),
			receipts: database.listActionReceipts(session.id) });
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain(Buffer.from(secret).toString("base64"));
		expect(persisted).toContain("Temporary credential cleanup verified");
		runtime.close(); database.close();
	});

	it.each(["failure", "cancel"])("cleans credentials after provider %s and keeps failures truthful", async (mode) => {
		const { database, runtime, session } = fixture();
		const controller = new AbortController();
		const model = provider(async () => {
			if (mode === "cancel") controller.abort(new Error("Cancelled fixture"));
			throw new Error(`fixture failed API_KEY=${secret}`);
		});
		const loop = new AgentLoop(database, runtime, new ProviderPool([model]));
		await expect(loop.run({ sessionId: session.id, model: "fixture", providerIds: [model.id],
			userContent: textContent(`Configure API_KEY=${secret}`), signal: controller.signal })).rejects.toThrow();
		const run = database.listAgentRuns(session.id)[0]!;
		expect(run.status).toBe(mode === "cancel" ? "cancelled" : "failed");
		expect(JSON.stringify(run)).not.toContain(secret);
		expect(database.getPrivateState(`task-secret-cleanup.${run.id}`)).toMatchObject({ verified: true, remaining: 0 });
		expect(runtime.taskSecrets.hasRun(run.id)).toBe(false);
		runtime.close(); database.close();
	});

	it("cleans a cancelled session immediately while its secret command is waiting for approval", async () => {
		const { database, runtime, session } = fixture();
		const execute = vi.spyOn(SandboxedCommandRunner.prototype, "run");
		let ref = "";
		const model = provider(async request => {
			ref = request.messages.map(message => contentText(message.content)).join("\n").match(/\[TASK_SECRET:([^\]]+)\]/)![1]!;
			return result("Approve the temporary credential setup.", [{ id: "setup", name: "execution.run-with-secrets",
				arguments: { command: "node", args: ["setup.js"], secretEnvironment: { SERVICE_API_KEY: ref } } }]);
		});
		const loop = new AgentLoop(database, runtime, new ProviderPool([model]));
		const waiting = await loop.run({ sessionId: session.id, model: "fixture", providerIds: [model.id],
			userContent: textContent(`Set up API_KEY=${secret}`) });
		expect(waiting.run.status).toBe("waiting_approval");
		expect(runtime.taskSecrets.hasRun(waiting.run.id)).toBe(true);
		runtime.cancelSession(session.id);
		expect(database.getAgentRun(waiting.run.id)?.status).toBe("cancelled");
		expect(runtime.taskSecrets.hasRun(waiting.run.id)).toBe(false);
		expect(() => runtime.taskSecrets.resolve(session.id, waiting.run.id, { API_KEY: ref })).toThrow();
		expect(database.getPrivateState(`task-secret-cleanup.${waiting.run.id}`)).toMatchObject({ removed: 1, remaining: 0, verified: true });
		expect(runtime.listMessages(session.id).some(message => message.content.includes("Temporary credential cleanup verified"))).toBe(true);
		await expect(loop.resume({ runId: waiting.run.id, approvalDecision: "approved" })).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
		runtime.close(); database.close();
	});

	it("redacts a known arbitrary-format secret in assistant tool-call arguments before durable storage and provider replay", async () => {
		const { database, runtime, session } = fixture();
		let calls = 0;
		const requests: string[] = [];
		const model = provider(async request => {
			requests.push(JSON.stringify(request));
			if (calls++ === 0) return result("Inspect the setup workspace.", [{ id: "list", name: "workspace.list",
				arguments: { path: ".", content: secret } }]);
			return result("The workspace inspection is complete.");
		});
		const loop = new AgentLoop(database, runtime, new ProviderPool([model]));
		const completed = await loop.run({ sessionId: session.id, model: "fixture", providerIds: [model.id],
			userContent: textContent(`Inspect the setup workspace. API_KEY=${secret}`) });
		expect(completed.run.status).toBe("completed");
		expect(calls).toBe(2);
		expect(requests.join("\n")).not.toContain(secret);
		const assistant = runtime.listMessages(session.id).find(message => message.modelToolCalls?.length);
		expect(assistant?.modelToolCalls?.[0]?.arguments.content).not.toBe(secret);
		expect(JSON.stringify(runtime.listMessages(session.id))).not.toContain(secret);
		runtime.close(); database.close();
	});

	it("redacts legacy assistant tool-call arguments at the provider replay boundary", async () => {
		const { database, runtime, session } = fixture();
		const legacyKey = `sk-proj-${"l".repeat(32)}`;
		// Insert through the database to reproduce history written before ingress protection.
		database.saveRuntimeMessage({ id: "message-legacy-secret", sessionId: session.id, role: "assistant",
			content: "A legacy setup inspection.", createdAt: "2026-09-01T12:00:00Z",
			modelToolCalls: [{ id: "legacy-list", name: "workspace.list", arguments: { path: ".", content: legacyKey } }] });
		database.saveRuntimeMessage({ id: "message-legacy-result", sessionId: session.id, role: "tool",
			content: '{"status":"verified","output":{"files":[]}}', createdAt: "2026-09-01T12:00:01Z",
			providerToolCallId: "legacy-list", toolName: "workspace.list" });
		let replayed: unknown;
		let modelRequest = "";
		const model = provider(async request => {
			replayed = request.messages.flatMap(message => message.toolCalls ?? []).find(candidate => candidate.id === "legacy-list");
			modelRequest = JSON.stringify(request);
			return result("The current setup inspection is complete.");
		});
		const loop = new AgentLoop(database, runtime, new ProviderPool([model]));
		const completed = await loop.run({ sessionId: session.id, model: "fixture", providerIds: [model.id],
			userContent: textContent("Continue the setup inspection.") });
		expect(completed.run.status).toBe("completed");
		expect(replayed).toBeDefined();
		expect(modelRequest).not.toContain(legacyKey);
		// Safe replay does not imply retroactive erasure of old database records.
		expect(JSON.stringify(database.listRuntimeMessages(session.id).find(message => message.id === "message-legacy-secret"))).toContain(legacyKey);
		runtime.close(); database.close();
	});

	it("does not disclose a known credential through split progress from a later readonly command", async () => {
		const { database, runtime, session } = fixture();
		database.saveAgentRun({ id: "run-progress", sessionId: session.id, model: "fixture", providerIds: ["fixture-secret"],
			status: "running", turn: 0, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" });
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, "run-progress");
		const chunks: string[] = [];
		runtime.on("event", event => {
			if (event.type === "tool.progress") chunks.push(String(event.payload.chunk ?? ""));
		});
		vi.spyOn(SandboxedCommandRunner.prototype, "run").mockImplementation(async (input, options) => {
			options.onProgress({ stream: "stdout", chunk: secret.slice(0, 10) });
			options.onProgress({ stream: "stdout", chunk: secret.slice(10) });
			return { command: input.command, args: input.args, cwd: input.cwd,
				exitCode: 0, signal: null, stdout: secret, stderr: "", durationMs: 1 };
		});
		const execution = await runtime.callTool(session.id, "execution.run-readonly", { command: "node", args: ["inspect.js"] },
			{ runId: "run-progress" });
		expect(execution.status).toBe("verified");
		expect(chunks.join("")).not.toContain(secret);
		expect(JSON.stringify(database.listToolExecutions(session.id))).not.toContain(secret);
		runtime.close(); database.close();
	});

	it("withholds encoded readonly output before hooks, journals and the next provider request", async () => {
		const { database, runtime, session } = fixture();
		const encoded = Buffer.from(secret).toString("base64");
		const requests: string[] = [];
		const hookOutputs: string[] = [];
		runtime.registerHook({ id: "fixture-protected-output", event: "post_tool", run: ({ execution }) => {
			hookOutputs.push(JSON.stringify(execution.output));
			return {};
		} });
		vi.spyOn(SandboxedCommandRunner.prototype, "run").mockImplementation(async input => ({
			command: input.command, args: input.args, cwd: input.cwd,
			exitCode: 0, signal: null, stdout: encoded, stderr: encoded, durationMs: 1,
		}));
		let calls = 0;
		const model = provider(async request => {
			requests.push(JSON.stringify(request));
			if (calls++ === 0) return result("Inspect setup status.", [{ id: "inspect", name: "execution.run-readonly",
				arguments: { command: "node", args: ["inspect.js"] } }]);
			return result("The command completed; its output was withheld.");
		});
		const loop = new AgentLoop(database, runtime, new ProviderPool([model]));
		const completed = await loop.run({ sessionId: session.id, model: "fixture", providerIds: [model.id],
			userContent: textContent(`Inspect setup status. API_KEY=${secret}`) });
		expect(completed.run.status).toBe("completed");
		expect(calls).toBe(2);
		const execution = database.listToolExecutions(session.id).find(candidate => candidate.toolName === "execution.run-readonly");
		expect(execution?.output).toMatchObject({ stdout: "", stderr: "", outputWithheld: true });
		expect(hookOutputs).toHaveLength(1);
		const retained = JSON.stringify({ requests, hookOutputs, messages: runtime.listMessages(session.id),
			executions: database.listToolExecutions(session.id), receipts: database.listActionReceipts(session.id) });
		expect(retained).not.toContain(secret);
		expect(retained).not.toContain(encoded);
		runtime.close(); database.close();
	});

	it("rejects binary reads of a credential file while temporary task credentials are active", async () => {
		const { database, runtime, session, root } = fixture();
		writeFileSync(join(root, "credential.bin"), secret, { mode: 0o600 });
		database.saveAgentRun({ id: "run-binary", sessionId: session.id, model: "fixture", providerIds: ["fixture-secret"],
			status: "running", turn: 0, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" });
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, "run-binary");
		const execution = await runtime.callTool(session.id, "workspace.read-binary", { path: "credential.bin" }, { runId: "run-binary" });
		expect(execution.status).toBe("failed");
		expect(execution.error).toMatch(/Binary reads are withheld/);
		expect(execution.output).toBeUndefined();
		const retained = JSON.stringify({ execution, executions: database.listToolExecutions(session.id),
			receipts: database.listActionReceipts(session.id) });
		expect(retained).not.toContain(secret);
		expect(retained).not.toContain(Buffer.from(secret).toString("base64"));
		expect(readFileSync(join(root, "credential.bin"), "utf8")).toBe(secret);
		runtime.close(); database.close();
	});

	it("rejects background startup before creating a process for a temporary credential task", async () => {
		const { database, runtime, session } = fixture();
		database.saveAgentRun({ id: "run-background", sessionId: session.id, model: "fixture", providerIds: ["fixture-secret"],
			status: "running", turn: 0, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" });
		const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
		runtime.taskSecrets.bind(prepared.scopeId!, session.id, "run-background");
		const start = vi.spyOn(SandboxedCommandRunner.prototype, "start");
		const execution = await runtime.callTool(session.id, "execution.start-background", { command: "node", args: ["inspect.js"] },
			{ runId: "run-background", idempotencyKey: "fixture-background" });
		expect(execution.status).toBe("failed");
		expect(execution.error).toMatch(/background processes are unavailable/);
		expect(start).not.toHaveBeenCalled();
		runtime.close(); database.close();
	});

	it.each(["workspace.write", "workspace.patch", "workspace.delete"])(
		"rejects %s before retaining a known credential in undo snapshots", async toolName => {
			const { database, runtime, session, root } = fixture();
			database.saveAgentRun({ id: "run-mutation", sessionId: session.id, model: "fixture", providerIds: ["fixture-secret"],
				status: "running", turn: 0, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" });
			writeFileSync(join(root, "credential.txt"), secret, { mode: 0o600 });
			const prepared = runtime.prepareTaskSecrets(session.id, `API_KEY=${secret}`);
			runtime.taskSecrets.bind(prepared.scopeId!, session.id, "run-mutation");
			const input = toolName === "workspace.write" ? { path: "credential.txt", content: "replacement" }
				: toolName === "workspace.patch" ? { path: "credential.txt", edits: [{ oldText: secret, newText: "replacement" }] }
				: { path: "credential.txt" };
			const options = { runId: "run-mutation", idempotencyKey: `fixture-${toolName}` };
			let execution = await runtime.callTool(session.id, toolName, input, options);
			if (execution.status === "blocked" && execution.output?.approvalRequired === true)
				execution = await runtime.callTool(session.id, toolName, input, { ...options,
					approvalStatus: "approved", approvalGrantExecutionId: execution.id });
			expect(execution.status).toBe("failed");
			expect(readFileSync(join(root, "credential.txt"), "utf8")).toBe(secret);
			expect(database.listWorkspaceMutations(session.id)).toEqual([]);
			expect(JSON.stringify(database.listToolExecutions(session.id))).not.toContain(secret);
			runtime.close(); database.close();
		},
	);

	it("protects the core ingress before routing, working memory and message observers", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		let modelRequest = "";
		const model = provider(async request => { modelRequest = JSON.stringify(request); return result("Ready to continue the authorized setup."); });
		const core = new AgentCore({ database, modelProviders: [model] });
		const session = core.runtime.createSession({ title: `API_KEY=${secret}` });
		const response = await core.handle({ type: "runtime-run-agent", sessionId: session.id, message: `Set up API_KEY=${secret}`,
			model: "fixture", providerIds: [model.id] });
		expect(response.ok).toBe(true);
		expect(modelRequest).not.toContain(secret);
		const retained = JSON.stringify({ session: database.getRuntimeSession(session.id), messages: core.runtime.listMessages(session.id),
			tasks: database.listWorkingTasks({ includeCompleted: true }), memories: database.listMemories(), snapshot: core.snapshot() });
		expect(retained).not.toContain(secret);
		expect(retained).toContain("Temporary credential cleanup verified");
		await core.close();
	});
});
