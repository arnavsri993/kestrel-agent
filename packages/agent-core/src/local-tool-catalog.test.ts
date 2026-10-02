import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "./agent-loop";
import { localToolCatalog } from "./local-tool-catalog";
import { UNEXECUTED_LOCAL_PLAN_ERROR } from "./agent-run-completion";
import { AgentRuntime } from "./runtime";
import { ProviderPool, textContent, type ModelMessage, type ModelProvider, type ModelTool } from "./providers";

const tools: ModelTool[] = ["tools.search", "browser.open-tab", ...Array.from({ length: 30 }, (_, index) => `fixture.read-${index}`)].map(name => ({ name, description: name, inputSchema: { type: "object" } }));
const discovery = (status: string, active: unknown[]): ModelMessage => ({ role: "tool", toolName: "tools.search", content: textContent(JSON.stringify({ status, output: { active } })) });

describe("local progressive tool catalog", () => {
	it.each(["continue", "plan-only", "repeated-plan", "final-turn", "nonlocal"])("bounds an unfinished local execution plan: %s", async mode => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const runtime = new AgentRuntime(database);
			const session = runtime.createSession({ title: "Local plan continuation" });
			let executed = 0;
			for (const name of tools.slice(1).map(tool => tool.name)) {
				runtime.registerExternalTool({ descriptor: { name, title: name, description: "Read a fixture", category: "web", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "mcp", tags: [] }, inputSchema: { type: "object" }, execute: async () => { executed++; return { observed: "fixture-result" }; } });
				runtime.allowTool(session.id, name);
			}
			let calls = 0;
			const provider: ModelProvider = {
				id: "plan-fixture", capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local: mode !== "nonlocal" },
				complete: async request => {
					calls++;
					if (calls === 2) {
						const context = request.messages.map(message => message.content).flat().filter(part => part.type === "text").map(part => part.text).join("\n");
						expect(context).toContain("Only call a tool if the user asked you to perform that work");
						expect(request.tools?.map(tool => tool.name)).toEqual(["tools.search", "browser.open-tab"]);
					}
					return { providerId: "plan-fixture", model: request.model, text: mode === "plan-only" && calls === 2 ? "Here is the requested plan. No execution was requested." : calls === 3 ? "Fixture page read." : "Plan: read the fixture page.\nLet's execute:", toolCalls: mode === "continue" && calls === 2 ? [{ id: "read", name: "browser.open-tab", arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: calls === 2 && mode === "continue" ? "tool_calls" : "stop" };
				},
			};
			const scope = tools.map(tool => tool.name);
			const result = await new AgentLoop(database, runtime, new ProviderPool([provider])).run({ sessionId: session.id, model: "fixture", providerIds: [provider.id], allowedTools: scope, maximumTurns: mode === "final-turn" ? 1 : 4, userContent: textContent(mode === "plan-only" ? "Give me a plan only. Do not execute it." : "Read the fixture page once.") });
			expect(result.run.toolScope).toEqual(scope);
			expect(calls).toBe(mode === "continue" ? 3 : ["repeated-plan", "plan-only"].includes(mode) ? 2 : 1);
			expect(executed).toBe(mode === "continue" ? 1 : 0);
			if (["repeated-plan", "final-turn"].includes(mode)) {
				expect(result.run).toMatchObject({ status: "failed", error: UNEXECUTED_LOCAL_PLAN_ERROR });
				expect(result.assistantMessage?.content).toBe(UNEXECUTED_LOCAL_PLAN_ERROR);
			} else expect(result.run.status).toBe("completed");
		} finally { database.close(); }
	});
	it("keeps scoped catalogs intact and requires authorized discovery", () => {
		expect(localToolCatalog(tools.slice(0, 10), [])).toBeUndefined();
		expect(localToolCatalog(tools.filter(tool => tool.name !== "tools.search"), [])).toBeUndefined();
		expect(localToolCatalog(tools, [])?.map(tool => tool.name)).toEqual(["tools.search", "browser.open-tab"]);
	});
	it("keeps authorized protected execution immediately available for opaque task credentials", () => {
		const protectedExecution = { name: "execution.run-with-secrets", description: "Protected execution", inputSchema: { type: "object" } };
		expect(localToolCatalog([...tools, protectedExecution], [])).toContain(protectedExecution);
		expect(localToolCatalog(tools, [])?.map(tool => tool.name)).not.toContain(protectedExecution.name);
	});
	it("includes an authorized visible browser action without granting an absent action", () => {
		const action = { name: "browser.visible-act", description: "Visible browser action", inputSchema: { type: "object" } };
		expect(localToolCatalog([...tools, action], [])).toContain(action);
		expect(localToolCatalog(tools, [])?.map(tool => tool.name)).not.toContain(action.name);
	});
	it("loads a bounded batch from verified search, using only authorized definitions", () => {
		const results = [{ name: "denied.tool", inputSchema: { malicious: true } }, ...tools.slice(2).map(tool => ({ name: tool.name, inputSchema: { untrusted: true } }))];
		const loaded = localToolCatalog(tools, [discovery("verified", results)])!;
		expect(loaded).toHaveLength(10);
		expect(loaded).not.toContainEqual(expect.objectContaining({ name: "denied.tool" }));
		expect(loaded.every(tool => tools.includes(tool))).toBe(true);
		expect(localToolCatalog(tools, [discovery("failed", results)])).toHaveLength(2);
		expect(localToolCatalog(tools, [{ role: "tool", toolName: "browser.visible-snapshot", content: discovery("verified", results).content }])).toHaveLength(2);
	});
	it("restores previously used definitions and ignores malformed discovery", () => {
		const used: ModelMessage = { role: "assistant", content: [], toolCalls: [{ id: "used", name: "fixture.read-29", arguments: {} }, { id: "denied", name: "denied.tool", arguments: {} }] };
		const loaded = localToolCatalog(tools, [used, { role: "tool", toolName: "tools.search", content: textContent("{broken") }])!;
		expect(loaded.map(tool => tool.name)).toEqual(["tools.search", "browser.open-tab", "fixture.read-29"]);
	});
	it.each([true, false])("discovers an approved action without widening the run ceiling; local=%s", async local => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const runtime = new AgentRuntime(database);
			const session = runtime.createSession({ title: "Progressive approval fixture" });
			const target = "fixture.read-29";
			let executed = 0;
			for (const name of [...tools.slice(2).map(tool => tool.name), `${target}-denied`]) {
				runtime.registerExternalTool({ descriptor: { name, title: name, description: "Fixture catalog action", category: "web", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "mcp", tags: [] }, inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { executed++; return { observed: "fixture-result" }; } });
				runtime.allowTool(session.id, name);
			}
			const allowedTools = ["tools.search", ...tools.slice(2).map(tool => tool.name)];
			let calls = 0;
			const provider: ModelProvider = {
				id: "catalog-fixture", capabilities: { streaming: false, tools: true, images: false, audio: false, documents: false, local },
				complete: async request => {
					calls++;
					const names = request.tools?.map(tool => tool.name) ?? [];
					expect(names).not.toContain(`${target}-denied`);
					if (calls === 1) expect(names.includes(target)).toBe(!local);
					else expect(names).toContain(target);
					return { providerId: "catalog-fixture", model: request.model, text: calls === 3 ? "Approved fixture action completed." : "", toolCalls: calls === 1 ? [{ id: "search", name: "tools.search", arguments: { query: target } }] : calls === 2 ? [{ id: "action", name: target, arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: calls === 3 ? "stop" : "tool_calls" };
				},
			};
			const loop = new AgentLoop(database, runtime, new ProviderPool([provider]));
			const waiting = await loop.run({ sessionId: session.id, model: "fixture", providerIds: [provider.id], allowedTools, userContent: textContent("Use the permitted fixture action.") });
			expect(waiting.run.status).toBe("waiting_approval");
			expect(waiting.run.toolScope).toEqual(allowedTools);
			expect(executed).toBe(0);
			const completed = await loop.resume({ runId: waiting.run.id, approvalDecision: "approved" });
			expect(completed.run.status).toBe("completed");
			expect(completed.run.toolScope).toEqual(allowedTools);
			expect(executed).toBe(1);
		} finally { database.close(); }
	});
});
