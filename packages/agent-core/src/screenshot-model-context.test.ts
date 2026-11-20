import { randomUUID } from "node:crypto";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { AgentRun, RuntimeToolExecution } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "./agent-loop";
import { AgentRuntime } from "./runtime";
import { ProviderPool, contentText, textContent, type ModelMessage, type ModelProvider } from "./providers";
import { modelVisibleToolResult } from "./tool-result-guardrails";
import { screenshotImage, screenshotModelContext, screenshotRouteDigest } from "./screenshot-model-context";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=";
const timestamp = "2026-11-01T12:00:00.000Z";
const now = Date.parse(timestamp);
const run = { id: "run-fixture", sessionId: "session-fixture", model: "vision-fixture", providerIds: ["local-vision"] } as AgentRun;
function execution(): RuntimeToolExecution {
	return { id: "tool-screen", sessionId: run.sessionId, toolName: "computer.screenshot", status: "verified", riskLevel: "low", input: {},
		output: { width: 1, height: 1, pngBase64: png, trust: "untrusted_desktop", captureId: randomUUID(), capturedAt: timestamp },
		idempotencyKey: `${run.id}:call-screen`, startedAt: timestamp, completedAt: timestamp };
}
function fixture() {
	const captured = execution();
	const messages: ModelMessage[] = [{ role: "tool", toolCallId: "call-screen", toolName: captured.toolName, content: textContent(modelVisibleToolResult(captured)) }];
	const observation = { version: 1 as const, executionId: captured.id, providerId: "local-vision", model: "vision-fixture", routeSha256: screenshotRouteDigest(run) };
	const input = { run, messages, observation, getExecution: () => captured, supportsImages: () => true, now };
	return { captured, messages, observation, input };
}

describe("screenshot model context", () => {
	it("keeps capture metadata in text and sends pixels as an untrusted image to the requesting model", () => {
		const { captured, input } = fixture();
		const text = modelVisibleToolResult(captured);
		expect(text).not.toContain(png);
		expect(JSON.parse(text).output.captureId).toBe(captured.output?.captureId);
		const context = screenshotModelContext(input);
		expect(context.pinnedProvider).toEqual({ id: "local-vision", model: "vision-fixture" });
		expect(context.messages.at(-1)?.content).toContainEqual({ type: "image", source: "base64", mediaType: "image/png", data: png });
		expect(contentText(context.messages.at(-2)!.content)).toContain("untrusted tool observation");
		expect(input.messages).toHaveLength(1);
	});

	it("does not replay frames into another run, session, compacted context, or model route", () => {
		const { captured, input } = fixture();
		for (const changed of [
			{ ...input, run: { ...run, id: "run-next" } },
			{ ...input, run: { ...run, sessionId: "session-other" } },
			{ ...input, messages: [] },
			{ ...input, run: { ...run, providerIds: ["other-model"] } },
		]) expect(screenshotModelContext(changed).messages.flatMap(message => message.content).some(part => part.type === "image")).toBe(false);
		expect(captured.output?.pngBase64).toBe(png);
	});

	it("requires fresh validated pixels and a vision-capable route without discarding the capture ID", () => {
		const { captured, input } = fixture();
		expect(() => screenshotModelContext({ ...input, supportsImages: () => false })).toThrow(/vision-capable/);
		expect(screenshotModelContext({ ...input, now: now + 30_001 }).pinnedProvider).toBeUndefined();
		captured.output!.width = 2;
		expect(screenshotImage(captured)).toBeUndefined();
		expect(() => screenshotModelContext(input)).toThrow(/validated/);
		captured.output!.width = 1;
		captured.output!.pngBase64 = "data:image/png;base64," + png;
		expect(screenshotImage(captured)).toBeUndefined();
	});

	it("delivers real image content on the next agent turn and keeps it out of conversation text", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const runtime = new AgentRuntime(database);
			const session = runtime.createSession({ title: "Screenshot image handoff" });
			runtime.registerExternalTool({ descriptor: { name: "computer.screenshot", title: "Screenshot fixture", description: "Generated pixel fixture", category: "browser", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "builtin", tags: [] }, inputSchema: { type: "object" }, execute: async () => ({ width: 1, height: 1, pngBase64: png, trust: "untrusted_desktop", captureId: randomUUID(), capturedAt: new Date().toISOString() }) });
			runtime.allowTool(session.id, "computer.screenshot");
			let calls = 0;
			const provider: ModelProvider = {
				id: "local-vision", capabilities: { streaming: false, tools: true, images: true, audio: false, documents: false, local: true },
				complete: async request => {
					calls++;
					if (calls === 2) {
						expect(request.messages.flatMap(message => message.content).filter(part => part.type === "image")).toEqual([{ type: "image", source: "base64", mediaType: "image/png", data: png }]);
						const receipt = request.messages.find(message => message.role === "tool");
						expect(JSON.parse(contentText(receipt!.content)).output.captureId).toMatch(/^[a-f0-9-]{36}$/);
					}
					return { providerId: "local-vision", model: request.model, text: calls === 1 ? "" : "Observed the generated image.", toolCalls: calls === 1 ? [{ id: "call-screen", name: "computer.screenshot", arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: calls === 1 ? "tool_calls" : "stop" };
				},
			};
			const completed = await new AgentLoop(database, runtime, new ProviderPool([provider])).run({ sessionId: session.id, model: "vision-fixture", providerIds: [provider.id], userContent: textContent("Inspect the generated screenshot."), maximumTurns: 3 });
			expect(completed.run.status).toBe("completed");
			expect(calls).toBe(2);
			expect(runtime.listMessages(session.id).every(message => !message.content.includes(png))).toBe(true);
			expect(database.listToolExecutions(session.id)[0]?.output?.pngBase64).toBe(png);
		} finally { database.close(); }
	});

	it("does not fail over a screenshot to another provider during automatic routing", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const runtime = new AgentRuntime(database);
			const session = runtime.createSession({ title: "Screenshot recipient boundary" });
			runtime.registerExternalTool({ descriptor: { name: "computer.screenshot", title: "Screenshot fixture", description: "Generated pixel fixture", category: "browser", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "builtin", tags: [] }, inputSchema: { type: "object" }, execute: async () => ({ width: 1, height: 1, pngBase64: png, trust: "untrusted_desktop", capturedAt: new Date().toISOString() }) });
			runtime.allowTool(session.id, "computer.screenshot");
			let sourceCalls = 0, otherCalls = 0;
			const capabilities = { streaming: false, tools: true, images: true, audio: false, documents: false, local: true };
			const source: ModelProvider = { id: "a-source", capabilities, complete: async request => {
				sourceCalls++;
				if (sourceCalls > 1) throw new Error("Synthetic original route unavailable.");
				return { providerId: "a-source", model: request.model, text: "", toolCalls: [{ id: "call-screen", name: "computer.screenshot", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
			} };
			const other: ModelProvider = { id: "z-other", capabilities, complete: async request => {
				otherCalls++;
				return { providerId: "z-other", model: request.model, text: "Unexpected fallback.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
			} };
			await expect(new AgentLoop(database, runtime, new ProviderPool([source, other])).run({ sessionId: session.id, model: "vision-fixture", providerIds: ["auto"], userContent: textContent("Inspect the generated screenshot."), maximumTurns: 3 })).rejects.toThrow(/All eligible model providers failed/);
			expect(database.listAgentRuns(session.id).at(-1)?.status).toBe("failed");
			expect(sourceCalls).toBeGreaterThanOrEqual(2);
			expect(otherCalls).toBe(0);
		} finally { database.close(); }
	});

	it("rehydrates the same run's image after an approval pause without placing pixels in history", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const runtime = new AgentRuntime(database);
			const session = runtime.createSession({ title: "Screenshot approval resume", approvalPolicy: "ask" });
			for (const [name, readOnly] of [["computer.screenshot", true], ["test.approved-action", false]] as const) {
				runtime.registerExternalTool({ descriptor: { name, title: "Generated fixture", description: "Generated fixture only", category: "browser", riskLevel: readOnly ? "read_only" : "sensitive", readOnly, requiresWorkspace: false, source: "builtin", tags: [] }, inputSchema: { type: "object" }, execute: async () => readOnly ? { width: 1, height: 1, pngBase64: png, trust: "untrusted_desktop", capturedAt: new Date().toISOString() } : { performed: true } });
				runtime.allowTool(session.id, name);
			}
			let calls = 0;
			const provider: ModelProvider = { id: "resume-vision", capabilities: { streaming: false, tools: true, images: true, audio: false, documents: false, local: true }, complete: async request => {
				calls++;
				if (calls > 1) expect(request.messages.flatMap(message => message.content).filter(part => part.type === "image")).toHaveLength(1);
				return { providerId: "resume-vision", model: request.model, text: calls > 2 ? "Verified fixture completion." : "", toolCalls: calls === 1 ? [{ id: "call-screen", name: "computer.screenshot", arguments: {} }] : calls === 2 ? [{ id: "call-action", name: "test.approved-action", arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: calls > 2 ? "stop" : "tool_calls" };
			} };
			const loop = new AgentLoop(database, runtime, new ProviderPool([provider]));
			const pending = await loop.run({ sessionId: session.id, model: "vision-fixture", providerIds: [provider.id], userContent: textContent("Inspect a generated image, then perform the approved fixture action."), maximumTurns: 4 });
			expect(pending.run.status).toBe("waiting_approval");
			const resumed = await loop.resume({ runId: pending.run.id, approvalDecision: "approved" });
			expect(resumed.run.status).toBe("completed");
			expect(calls).toBe(3);
			expect(runtime.listMessages(session.id).every(message => !message.content.includes(png))).toBe(true);
		} finally { database.close(); }
	});

	it.each([false, true])("requires the agent to observe its input result (post-capture=%s)", async postCapture => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const runtime = new AgentRuntime(database);
			const session = runtime.createSession({ title: "Desktop result verification" });
			let captureCount = 0;
			for (const name of ["computer.screenshot", "computer.act"]) {
				runtime.registerExternalTool({ descriptor: { name, title: "Generated fixture", description: "In-memory fixture only", category: "browser", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "builtin", tags: [] }, inputSchema: { type: "object" }, execute: async () => name === "computer.act" ? { performed: true } : { width: 1, height: 1, pngBase64: png, trust: "untrusted_desktop", captureId: `fixture-${++captureCount}`, capturedAt: new Date().toISOString() } });
				runtime.allowTool(session.id, name);
			}
			let calls = 0;
			const provider: ModelProvider = { id: "local-vision", capabilities: { streaming: false, tools: true, images: true, audio: false, documents: false, local: true }, complete: async request => {
				calls++;
				const toolName = calls === 1 ? "computer.screenshot" : calls === 2 ? "computer.act" : postCapture && calls === 3 ? "computer.screenshot" : undefined;
				return { providerId: "local-vision", model: request.model, text: toolName ? "" : "The task is complete.", toolCalls: toolName ? [{ id: `call-${calls}`, name: toolName, arguments: toolName === "computer.act" ? { action: { type: "click", captureId: "fixture-1" } } : {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: toolName ? "tool_calls" : "stop" };
			} };
			const result = await new AgentLoop(database, runtime, new ProviderPool([provider])).run({ sessionId: session.id, model: "vision-fixture", providerIds: [provider.id], userContent: textContent("Exercise the in-memory desktop fixture."), maximumTurns: 5 });
			expect(result.run.status).toBe(postCapture ? "completed" : "failed");
			if (!postCapture) expect(result.run.error).toContain("checking the result of its desktop input");
			expect(captureCount).toBe(postCapture ? 2 : 1);
		} finally { database.close(); }
	});
});
