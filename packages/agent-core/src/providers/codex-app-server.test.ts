import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountModelProviders } from "./account-providers";
import { CodexAppServerProvider } from "./codex-app-server";
import { ModelProviderError, textContent } from "./types";

const roots: string[] = [];
const executeFile = promisify(execFileCallback);

async function fakeAppServer(scenario: string[] | Record<string, unknown> = {}): Promise<{
	executable: string;
	capture: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "kestrel-codex-app-server-test-"));
	roots.push(root);
	const executable = join(root, "codex");
	const capture = `${executable}.capture.jsonl`;
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const capture = process.argv[1] + ".capture.jsonl";
let turn = 0;
const replies = ${JSON.stringify(Array.isArray(scenario) ? scenario : [])};
let tools = [];
const toolScenario = ${JSON.stringify(Array.isArray(scenario) ? {} : scenario)};
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function record(value) {
  const row = { pid: process.pid, value };
  if (value.method === "initialize") {
    row.env = {
      CODEX_HOME: process.env.CODEX_HOME ?? null,
      KESTREL_CODEX_MCP_TOKEN: process.env.KESTREL_CODEX_MCP_TOKEN ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    };
  }
  fs.appendFileSync(capture, JSON.stringify(row) + "\\n");
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" } });
  if (message.method === "initialized") return;
  if (message.method === "account/read") return send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  if (message.method === "account/rateLimits/read") {
    return send({
      id: message.id,
      result: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1900000000 },
          secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1900500000 },
          planType: "plus",
        },
      },
    });
  }
  if (message.method === "model/list") {
    if (message.params && message.params.cursor === "page-2") {
      return send({ id: message.id, result: { data: [{ id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden model", supportedReasoningEfforts: [{ reasoningEffort: "minimal" }], hidden: true }], nextCursor: null } });
    }
    return send({ id: message.id, result: { data: [{ id: "gpt-catalog", model: "gpt-catalog", displayName: "Catalog model", priority: 9, inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "minimal" }, { reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "ultra" }] }, { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence for the most demanding work.", isDefault: true, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
      { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6 Sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }, { reasoningEffort: "ultra" }] },
      { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }] },
    ], nextCursor: "page-2" } });
  }
  if (message.method === "thread/start") { tools = message.params.dynamicTools ?? []; return send({ id: message.id, result: { thread: { id: "thread-1" }, model: toolScenario.effectiveModel ?? message.params.model } }); }
  if (message.method === "turn/interrupt" && toolScenario.rejectInterrupt) return send({ id: message.id, error: { code: -32000, message: "interrupt failed" } });
  if (message.method === "turn/interrupt" || message.method === "thread/archive") return send({ id: message.id, result: {} });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    if (toolScenario.deferStart) return;
    if (toolScenario.earlyToolCall) send({ id: 1000 + turn, method: "item/tool/call", params: { threadId: "thread-1", turnId: toolScenario.turnId ?? turnId, callId: "early-call", tool: "kestrel_0", arguments: {} } });
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (toolScenario.hangTurn) return;
    send({ id: 800 + turn, method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId, itemId: "perm-" + turn, permissions: { network: { enabled: true } } } });
    send({ id: 700 + turn, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId, serverName: "kestrel_browser", mode: "form", message: "confirm" } });
    send({ id: 900 + turn, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId, itemId: "cmd-" + turn, command: "touch forbidden" } });
    return;
  }
  if (typeof message.id === "number" && message.id >= 901 && message.id < 1000) {
    const current = message.id - 900;
    const turnId = "turn-" + current;
    if (tools.length) {
      send({ id: toolScenario.stringToolRequest ? "tool-request-" + current : 1000 + current, method: "item/tool/call", params: { threadId: "thread-1", turnId, callId: "call-" + current, tool: "kestrel_0", arguments: { path: "src/index.ts" }, ...toolScenario } });
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "answer-" + current, delta: replies[current - 1] ?? "Persistent answer " + current } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: current > 1 ? 5 : 0, reasoningOutputTokens: 1 } } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
  }
});
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	return { executable, capture };
}

async function retryableFakeAppServer(): Promise<{ executable: string }> {
	const root = await mkdtemp(
		join(tmpdir(), "kestrel-codex-app-server-retry-test-"),
	);
	roots.push(root);
	const executable = join(root, "codex");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const attemptsPath = process.argv[1] + ".initialize-attempts";
let initialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function attempts() {
  const current = Number(fs.existsSync(attemptsPath) ? fs.readFileSync(attemptsPath, "utf8") : "0") + 1;
  fs.writeFileSync(attemptsPath, String(current));
  return current;
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (attempts() === 1) {
      return send({ id: message.id, error: { code: -32000, message: "fake initialize failed" } });
    }
    initialized = true;
    return send({ id: message.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "account/read" && initialized) {
    return send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  }
});
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	return { executable };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

type CaptureRecord = {
	pid: number;
	env?: {
		CODEX_HOME: string | null;
		KESTREL_CODEX_MCP_TOKEN: string | null;
		OPENAI_API_KEY: string | null;
	};
	value: Record<string, unknown> & {
		params?: Record<string, unknown>;
		result?: Record<string, unknown>;
	};
};

async function readCapture(path: string): Promise<CaptureRecord[]> {
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as CaptureRecord);
}

describe("persistent Codex app-server provider", () => {
 it("uses fresh complete transcripts for consecutive final answers in the same session", async () => {
  const fake = await fakeAppServer(["First verified answer", "Second verified answer"]);
  const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000 });
  provider.attachBrowserMcp({ url: "http://127.0.0.1:4567/mcp", token: "fixture-token" });
  try {
   for (const evidence of ["First evidence", "Second evidence"]) {
    await provider.complete({ model: "gpt-test", tools: [], metadata: { session_id: "same-session", kestrel_final_turn: "1" }, messages: [
     { role: "user", content: textContent("Review this task") },
     { role: "tool", content: textContent(evidence) },
     { role: "system", content: textContent("Final turn: answer from verified evidence only") },
    ] });
   }
   const records = await readCapture(fake.capture);
   const starts = records.filter(row => row.value.method === "thread/start");
   expect(starts).toHaveLength(2);
   expect(starts.every(row => row.value.params?.ephemeral === true)).toBe(true);
   for (const row of starts) expect(row.value.params?.config).toMatchObject({ "features.shell_tool": false });
   expect(starts.every(row => String(row.value.params?.baseInstructions).includes("Do not execute commands, edit files, browse, invoke MCP"))).toBe(true);
   const turns = records.filter(row => row.value.method === "turn/start");
   expect(JSON.stringify(turns[0]!.value.params?.input)).toContain("First evidence");
   expect(JSON.stringify(turns[1]!.value.params?.input)).toContain("Second evidence");
   expect(JSON.stringify(turns[1]!.value.params?.input)).toContain("Final turn: answer from verified evidence only");
   expect(turns.every(row => row.value.params?.outputSchema === undefined)).toBe(true);
  } finally { await provider.close(); }
 });

 it("bridges dynamic requests with fresh authorized context and plain final answers", async () => {
  const fake = await fakeAppServer();
  const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000 });
  const tools = [{ name: "tools.search", description: "Discover tools", inputSchema: { type: "object" } }];
  try {
   const first = await provider.complete({ model: "gpt-catalog", tools, metadata: { session_id: "agent-1" }, messages: [{ role: "user", content: textContent("Get started") }] });
   expect(first.toolCalls).toEqual([{ id: expect.any(String), name: "tools.search", arguments: { path: "src/index.ts" } }]);
   expect(first.finishReason).toBe("tool_calls");
   await provider.complete({ model: "gpt-catalog", tools: [], metadata: { session_id: "agent-1", kestrel_final_turn: "1" }, messages: [
    { role: "user", content: textContent("Get started") },
    { role: "assistant", content: textContent(first.text), toolCalls: first.toolCalls },
    { role: "tool", content: textContent("Verified tool result"), toolCallId: first.toolCalls[0]!.id },
   ] });
   const records = await readCapture(fake.capture);
   const starts = records.filter(row => row.value.method === "thread/start");
   expect(starts).toHaveLength(2);
   expect(starts.every(row => row.value.params?.ephemeral === true)).toBe(true);
   expect(starts[0]!.value.params?.dynamicTools).toMatchObject([{ name: "kestrel_0" }]);
   const turns = records.filter(row => row.value.method === "turn/start");
   expect(turns[0]!.value.params?.outputSchema).toBeUndefined();
   expect(turns[0]!.value.params?.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
   expect(JSON.stringify(turns[1]!.value.params?.input)).toContain("Verified tool result");
   expect(JSON.stringify(turns[1]!.value.params?.input)).toContain(first.toolCalls[0]!.id);
  } finally { await provider.close(); }
 });

	it("discovers the signed-in account's stable app-server model catalog", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			requestTimeoutMs: 10_000,
		});

		await expect(provider.discoverModels()).resolves.toEqual([
			{
				id: "gpt-catalog",
				displayName: "Catalog model",
				catalogPriority: 9,
				availability: "available",
				source: "protocol",
				capabilities: {
					capabilityProvenance: "confirmed",
					streaming: true,
					tools: true,
					images: true,
					audio: false,
					documents: false,
					video: false,
					structuredOutput: false,
					reasoningEfforts: ["minimal", "low", "high", "ultra"],
				},
			},
			{
				id: "gpt-6-astra",
				displayName: "GPT-6-Astra",
				description: "Frontier intelligence for the most demanding work.",
				catalogPriority: 0,
				availability: "available",
				source: "protocol",
				capabilities: {
					capabilityProvenance: "confirmed",
					streaming: true,
					tools: true,
					images: true,
					audio: false,
					documents: false,
					video: false,
					structuredOutput: false,
					reasoningEfforts: ["low", "high"],
				},
			},
			{
				id: "gpt-6-sol",
				displayName: "GPT-6 Sol",
				availability: "available",
				source: "protocol",
				capabilities: {
					capabilityProvenance: "confirmed",
					streaming: true,
					tools: true,
					images: true,
					audio: false,
					documents: false,
					video: false,
					structuredOutput: false,
					reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
				},
			},
			{
				id: "gpt-6-luna",
				displayName: "GPT-6 Luna",
				availability: "available",
				source: "protocol",
				capabilities: {
					capabilityProvenance: "confirmed",
					streaming: true,
					tools: true,
					images: true,
					audio: false,
					documents: false,
					video: false,
					structuredOutput: false,
					reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
				},
			},
		]);
		await provider.close();

		const records = await readCapture(fake.capture);
		const modelListRequests = records.filter(
			(record) => record.value.method === "model/list",
		);
		expect(modelListRequests).toHaveLength(2);
		expect(modelListRequests[0]?.value.params).toMatchObject({
			limit: 100,
			includeHidden: false,
		});
		expect(modelListRequests[1]?.value.params).toMatchObject({
			cursor: "page-2",
		});
	});

	it("retains protocol methods and distinct profile environments on account adapters", async () => {
		const fake = await fakeAppServer();
		const accounts = ["a", "b"].map(suffix => ({ id: `account-${suffix}`, providerId: "codex", adapter: "codex-app-server" as const, displayName: `Profile ${suffix}`, authTransport: "cli_profile" as const, enabled: true, executable: fake.executable, profilePath: `/fake/profile-${suffix}` }));
		const providers = createAccountModelProviders(accounts);
		try {
			for (const endpoint of providers) {
				expect(endpoint).toBeInstanceOf(CodexAppServerProvider);
				expect(endpoint.account?.id).toBe(endpoint.id);
				expect(endpoint.poolId).toBe("codex");
				await endpoint.probe!();
			}
			const starts = (await readCapture(fake.capture)).filter(row => row.value.method === "initialize");
			expect(starts.map(row => row.env?.CODEX_HOME)).toEqual(["/fake/profile-a", "/fake/profile-b"]);
			expect(new Set(starts.map(row => row.pid)).size).toBe(2);
		} finally { await Promise.all(providers.map(provider => provider.close!())); }
	});

	it("uses dynamicTools and yields execution to Kestrel with exact model and thinking", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000, turnTimeoutMs: 2_000 });
		try {
			const result = await provider.complete({
				model: "gpt-catalog", reasoningEffort: "high",
				metadata: { session_id: "persistent-agent", workspace_root: "/authorized/project" },
				messages: [{ role: "user", content: textContent("Inspect the scoped source.") }],
				tools: [{ name: "filesystem.read", description: "Read scoped source", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }],
			});
			expect(result).toMatchObject({ model: "gpt-catalog", text: "", finishReason: "tool_calls", toolCalls: [{ name: "filesystem.read", arguments: { path: "src/index.ts" } }] });
			const records = await readCapture(fake.capture);
			const thread = records.find(row => row.value.method === "thread/start")!.value.params!;
			expect(thread).toMatchObject({ model: "gpt-catalog", ephemeral: true, allowProviderModelFallback: false, sandbox: "read-only", approvalPolicy: "never", runtimeWorkspaceRoots: [], environments: [], dynamicTools: [{ type: "function", name: "kestrel_0", inputSchema: { required: ["path"] } }], config: { "features.shell_tool": false, "features.apps": false, web_search: "disabled", mcp_servers: {} } });
			expect(thread.cwd).not.toBe("/authorized/project");
			expect(records.find(row => row.value.method === "initialize")!.value.params).toMatchObject({ capabilities: { experimentalApi: true } });
			expect(records.find(row => row.value.method === "turn/start")!.value.params).toMatchObject({ model: "gpt-catalog", effort: "high", sandboxPolicy: { type: "readOnly", networkAccess: false } });
			expect(records.some(row => row.value.method === "turn/interrupt")).toBe(true);
			expect(records.find(row => row.value.id === 1001)!.value.result).toMatchObject({ success: false, contentItems: [{ type: "inputText", text: expect.stringContaining("no action was executed") }] });
		} finally { await provider.close(); }
	});

	it.each([{ tool: "shell" }, { tool: "kestrel_9" }, { turnId: "other-turn" }, { namespace: "other" }, { arguments: [] }])("rejects out-of-scope dynamic requests: %j", async (scenario) => {
		const fake = await fakeAppServer(scenario);
		const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000, turnTimeoutMs: 2_000 });
		try {
			await expect(provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Inspect") }], tools: [{ name: "filesystem.read", description: "Read", inputSchema: { type: "object" } }] })).rejects.toThrow("invalid or out-of-scope dynamic tool request");
		} finally { await provider.close(); }
	});

	it("preserves string server RPC IDs when yielding a dynamic tool request", async () => {
		const fake = await fakeAppServer({ stringToolRequest: true });
		const provider = new CodexAppServerProvider({ executable: fake.executable, turnTimeoutMs: 2_000 });
		try {
			const result = await provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] });
			expect(result.toolCalls).toHaveLength(1);
			expect((await readCapture(fake.capture)).find(row => row.value.id === "tool-request-1")?.value.result).toMatchObject({ success: false });
		} finally { await provider.close(); }
	});

	it("interrupts a timed-out vendor turn before archiving the tool step", async () => {
		const fake = await fakeAppServer({ hangTurn: true });
		const provider = new CodexAppServerProvider({ executable: fake.executable, turnTimeoutMs: 100 });
		try {
			await expect(provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] })).rejects.toThrow("turn timed out");
			await expect.poll(async () => (await readCapture(fake.capture)).some(row => row.value.method === "thread/archive")).toBe(true);
			const methods = (await readCapture(fake.capture)).map(row => row.value.method);
			expect(methods.indexOf("turn/interrupt")).toBeGreaterThan(methods.indexOf("turn/start"));
			expect(methods.indexOf("thread/archive")).toBeGreaterThan(methods.indexOf("turn/interrupt"));
		} finally { await provider.close(); }
	});

	it.each(["cancel", "timeout"])("resets an unidentified vendor turn after %s before accepting another request", async (failure) => {
		const fake = await fakeAppServer({ deferStart: true });
		const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000, turnTimeoutMs: failure === "timeout" ? 100 : 2_000 });
		const controller = new AbortController();
		try {
			const completion = provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] }, { signal: controller.signal });
			const rejection = expect(completion).rejects.toThrow(failure === "timeout" ? "turn timed out" : "cancelled");
			await expect.poll(async () => (await readCapture(fake.capture)).some(row => row.value.method === "turn/start")).toBe(true);
			if (failure === "cancel") controller.abort(new Error("cancelled"));
			await rejection;
			const originalPid = (await readCapture(fake.capture))[0]!.pid;
			expect(() => process.kill(originalPid, 0)).toThrow();
			await provider.probe();
			const initializations = (await readCapture(fake.capture)).filter(row => row.value.method === "initialize");
			expect(initializations).toHaveLength(2);
			expect(initializations[1]!.pid).not.toBe(originalPid);
		} finally { await provider.close(); }
	});

	it("closes the transport when a timed-out turn cannot acknowledge interruption", async () => {
		const fake = await fakeAppServer({ hangTurn: true, rejectInterrupt: true });
		const provider = new CodexAppServerProvider({ executable: fake.executable, turnTimeoutMs: 100 });
		try {
			await expect(provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] })).rejects.toThrow("turn timed out");
			const records = await readCapture(fake.capture);
			expect(records.some(row => row.value.method === "turn/interrupt")).toBe(true);
			expect(() => process.kill(records[0]!.pid, 0)).toThrow();
		} finally { await provider.close(); }
	});

	it("returns no tool requests and closes the transport when handoff interruption fails", async () => {
		const fake = await fakeAppServer({ rejectInterrupt: true });
		const provider = new CodexAppServerProvider({ executable: fake.executable, turnTimeoutMs: 2_000 });
		try {
			await expect(provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] })).rejects.toThrow("No tool requests were accepted");
			const records = await readCapture(fake.capture);
			expect(records.filter(row => row.value.method === "turn/interrupt")).toHaveLength(1);
			expect(() => process.kill(records[0]!.pid, 0)).toThrow();
		} finally { await provider.close(); }
	});

	it.each([false, true])("validates early dynamic requests against turn/start before handoff (stale: %s)", async (stale) => {
		const fake = await fakeAppServer({ earlyToolCall: true, ...(stale ? { turnId: "stale-turn" } : {}) });
		const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000, turnTimeoutMs: 2_000 });
		try {
			const result = provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] });
			if (stale) await expect(result).rejects.toThrow("out-of-scope");
			else expect((await result).toolCalls).toHaveLength(1);
		} finally { await provider.close(); }
	});

	it("rejects a provider-substituted model before starting a turn", async () => {
		const fake = await fakeAppServer({ effectiveModel: "substitute" });
		const provider = new CodexAppServerProvider({ executable: fake.executable });
		try {
			await expect(provider.complete({ model: "gpt-catalog", messages: [{ role: "user", content: textContent("Read") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] })).rejects.toThrow("substituted a different model");
			expect((await readCapture(fake.capture)).some(row => row.value.method === "turn/start")).toBe(false);
		} finally { await provider.close(); }
	});

	it.each([{ model: "not-entitled", reasoningEffort: "high" as const }, { model: "gpt-catalog", reasoningEffort: "max" as const }])("never substitutes an unadvertised account model or effort: %j", async (selection) => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({ executable: fake.executable, requestTimeoutMs: 10_000 });
		try {
			await expect(provider.complete({ ...selection, messages: [{ role: "user", content: textContent("Inspect") }], tools: [{ name: "filesystem.read", description: "Read", inputSchema: { type: "object" } }] })).rejects.toThrow(/selected Codex account/);
			expect((await readCapture(fake.capture)).some(row => row.value.method === "thread/start")).toBe(false);
		} finally { await provider.close(); }
	});

	it("restarts after initialization failure instead of reusing an uninitialized process", async () => {
		const fake = await retryableFakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
			},
			requestTimeoutMs: 2_000,
		});

		await expect(provider.probe()).rejects.toThrow("fake initialize failed");
		await expect(provider.probe()).resolves.toBeUndefined();
		await provider.close();
	});

	it("initializes once, preserves a durable thread, streams turns, and declines vendor-side execution", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				OPENAI_API_KEY: "must-not-leak",
			},
			// Vitest starts many fake providers in parallel; allow the child Node
			// process to start without weakening the provider's production default.
			requestTimeoutMs: 10_000,
			turnTimeoutMs: 2_000,
		});
		await provider.probe();
		const write = (
			provider as unknown as { write(message: Record<string, unknown>): void }
		).write.bind(provider);
		expect(() =>
			write({
				method: "turn/start",
				params: { prompt: "x".repeat(8 * 1024 * 1024) },
			}),
		).toThrow("outbound message exceeded the safety limit");
		const deltas: string[] = [];
		const first = await provider.complete(
			{
				model: "gpt-6-sol",
				reasoningEffort: "ultra",
				metadata: { session_id: "session-1", workspace_root: process.cwd() },
				messages: [
					{ role: "system", content: textContent("Private system context") },
					{
						role: "user",
						content: [
							...textContent("First prompt"),
							{
								type: "image",
								data: "aW1hZ2U=",
								mediaType: "image/png",
								source: "base64",
							},
						],
					},
				],
			},
			{
				onEvent: (event) => {
					if (event.type === "text_delta") deltas.push(event.delta);
				},
			},
		);
		const second = await provider.complete({
			model: "gpt-6-luna",
			reasoningEffort: "max",
			metadata: { session_id: "session-1", workspace_root: process.cwd() },
			messages: [
				{ role: "system", content: textContent("Private system context") },
				{ role: "user", content: textContent("First prompt") },
				{ role: "assistant", content: textContent("Persistent answer 1") },
				{ role: "user", content: textContent("Second prompt") },
			],
		});
		await provider.close();

		expect(first).toMatchObject({
			responseId: "turn-1",
			text: "Persistent answer 1",
			usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 1 },
		});
		expect(second).toMatchObject({
			responseId: "turn-2",
			text: "Persistent answer 2",
			usage: { cachedInputTokens: 5 },
		});
		expect(deltas.join("")).toBe("Persistent answer 1");

		const records = await readCapture(fake.capture);
		expect(
			records.find((record) => record.value.method === "initialize")?.env,
		).toMatchObject({
			CODEX_HOME: null,
			KESTREL_CODEX_MCP_TOKEN: null,
			OPENAI_API_KEY: null,
		});
		expect(
			(
				records.find((record) => record.value.method === "thread/start")?.value
					.params as { baseInstructions?: string }
			).baseInstructions,
		).toContain("invoke MCP");
		expect(new Set(records.map((record) => record.pid))).toHaveLength(1);
		expect(
			records.filter((record) => record.value.method === "initialize"),
		).toHaveLength(1);
		expect(
			records.filter((record) => record.value.method === "thread/start"),
		).toHaveLength(1);
		const turns = records.filter(
			(record) => record.value.method === "turn/start",
		);
		expect(turns).toHaveLength(2);
		expect(turns.map((turn) => turn.value.params)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ model: "gpt-6-sol", effort: "ultra" }),
			expect.objectContaining({ model: "gpt-6-luna", effort: "max" }),
		]),
	);
		expect(
			(turns[0]!.value.params!.input as Array<{ text: string }>)[0]!.text,
		).toContain("Private system context");
		expect(turns[0]!.value.params!.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					url: "data:image/png;base64,aW1hZ2U=",
				}),
			]),
		);
		expect(
			(turns[1]!.value.params!.input as Array<{ text: string }>)[0]!.text,
		).toBe("Second prompt");
		expect(
			records.filter(
				(record) =>
					record.value.result && record.value.result.decision === "decline",
			),
		).toHaveLength(2);
		expect(
			records.some((record) =>
				JSON.stringify(record.value).includes("must-not-leak"),
			),
		).toBe(false);
	});

	it("rejects remote image URLs before starting a Codex turn", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			requestTimeoutMs: 10_000,
		});
		await expect(
			provider.complete({
				model: "gpt-test",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								data: "https://example.com/not-forwarded.png",
								mediaType: "image/png",
								source: "url",
							},
						],
					},
				],
			}),
		).rejects.toThrow("remote image URLs");
		await provider.close();

		const records = await readCapture(fake.capture);
		expect(
			records.filter((record) => record.value.method === "turn/start"),
		).toHaveLength(0);
	});

	if (process.platform === "darwin")
		it("converts HEIC images locally before starting a Codex turn", async () => {
			const fake = await fakeAppServer();
			const root = await mkdtemp(join(tmpdir(), "kestrel-codex-heic-test-"));
			roots.push(root);
			const png = join(root, "fixture.png");
			const heic = join(root, "fixture.heic");
			await sharp({
				create: {
					width: 2,
					height: 2,
					channels: 3,
					background: { r: 10, g: 20, b: 30 },
				},
			})
				.png()
				.toFile(png);
			await executeFile("/usr/bin/sips", [
				"-s",
				"format",
				"heic",
				png,
				"--out",
				heic,
			]);
			const provider = new CodexAppServerProvider({
				executable: fake.executable,
				requestTimeoutMs: 10_000,
			});
			await provider.complete({
				model: "gpt-test",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								data: (await readFile(heic)).toString("base64"),
								mediaType: "image/heic",
								source: "base64",
							},
						],
					},
				],
			});
			await provider.close();

			const turn = (await readCapture(fake.capture)).find(
				(record) => record.value.method === "turn/start",
			)?.value.params as { input?: Array<{ type?: string; url?: string }> };
			expect(turn.input).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "image",
						url: expect.stringMatching(/^data:image\/jpeg;base64,/),
					}),
				]),
			);
		});

	it("attaches a loopback browser MCP through overlay CODEX_HOME", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				OPENAI_API_KEY: "must-not-leak",
			},
			requestTimeoutMs: 10_000,
			turnTimeoutMs: 2_000,
		});
		expect(() =>
			provider.attachBrowserMcp({
				url: "https://example.com/mcp",
				token: "tok",
			}),
		).toThrow("loopback HTTP URL");
		provider.attachBrowserMcp({
			url: "http://127.0.0.1:9/mcp",
			token: "tok",
		});
		await provider.probe();
		await provider.complete({
			model: "gpt-test",
			metadata: { session_id: "session-browser", workspace_root: process.cwd() },
			messages: [{ role: "user", content: textContent("Use the browser") }],
		});

		const records = await readCapture(fake.capture);
		const initialize = records.find(
			(record) => record.value.method === "initialize",
		);
		expect(initialize?.env?.CODEX_HOME).toMatch(/kestrel-codex-app-server/);
		expect(initialize?.env?.KESTREL_CODEX_MCP_TOKEN).toBe("tok");
		expect(initialize?.env?.OPENAI_API_KEY).toBeNull();
		const overlayConfig = await readFile(
			join(initialize!.env!.CODEX_HOME!, "config.toml"),
			"utf8",
		);
		expect(overlayConfig).toContain("[mcp_servers.kestrel_browser]");
		expect(overlayConfig).toContain('url = "http://127.0.0.1:9/mcp"');
		expect(overlayConfig).toContain(
			'bearer_token_env_var = "KESTREL_CODEX_MCP_TOKEN"',
		);
		const instructions = (
			records.find((record) => record.value.method === "thread/start")?.value
				.params as { baseInstructions?: string }
		).baseInstructions;
		expect(instructions).toContain("kestrel_browser");
		expect(instructions).not.toContain("invoke MCP");
		const turn = records.find((record) => record.value.method === "turn/start")
			?.value.params as {
			sandboxPolicy?: { type?: string; networkAccess?: boolean };
		};
		expect(turn.sandboxPolicy).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
		expect(
			records.filter(
				(record) =>
					record.value.result && record.value.result.decision === "decline",
			),
		).toHaveLength(1);
		expect(
			records.some(
				(record) =>
					record.value.result &&
					JSON.stringify(record.value.result.permissions) === "{}",
			),
		).toBe(true);
		expect(
			records.some(
				(record) =>
					record.value.result &&
					record.value.result.action === "decline" &&
					record.value.result.content === null,
			),
		).toBe(true);
		await provider.close();
	});

	it("reads Codex rate-limit windows without inventing meters", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({
			executable: fake.executable,
		});
		const snapshot = await provider.readRateLimits();
		expect(snapshot).toMatchObject({
			ordinaryUsageAllowed: true,
			plan: "plus",
			rateLimitReached: false,
			primary: {
				usedPercent: 55,
				windowDurationMins: 300,
			},
			secondary: {
				usedPercent: 12,
				windowDurationMins: 10_080,
			},
		});
		expect(snapshot.primary?.resetsAt).toMatch(/^\d{4}-/);
		const records = (await readFile(fake.capture, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { value: { method?: string; params?: Record<string, unknown> } });
		expect(
			records.some(
				(record) =>
					record.value.method === "account/rateLimits/read" &&
					record.value.params?.excludeResetCreditDetails === true,
			),
		).toBe(true);
		await provider.close();
	});

	it("does not attach a cached quota reset to an unrelated model error", async () => {
		const fake = await fakeAppServer();
		const provider = new CodexAppServerProvider({ executable: fake.executable });
		try {
			await provider.readRateLimits();
			await provider.discoverModels();
			let failure: unknown;
			try {
				await provider.complete({
					model: "gpt-catalog",
					reasoningEffort: "xhigh",
					messages: [{ role: "user", content: textContent("hi") }],
					tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }],
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ModelProviderError);
			expect(failure).toMatchObject({ status: undefined, retryAfterMs: undefined });
		} finally {
			await provider.close();
		}
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"normalizes malformed request and turn timeouts: %s",
		async (timeoutMs) => {
			const fake = await fakeAppServer();
			const provider = new CodexAppServerProvider({
				executable: fake.executable,
				requestTimeoutMs: timeoutMs,
				turnTimeoutMs: timeoutMs,
			});
			try {
				await provider.probe();
				await expect(
					provider.complete({
						model: "gpt-test",
						messages: [{ role: "user", content: textContent("First prompt") }],
					}),
				).resolves.toMatchObject({
					providerId: "codex-subscription",
					text: "Persistent answer 1",
				});
			} finally {
				await provider.close();
			}
		},
	);
});
