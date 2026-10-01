import { describe, expect, it } from "vitest";
import { codexDynamicTools, parseCodexDynamicToolCall } from "./codex-tool-bridge";

const tools = [{ name: "workspace.read", description: "Read scoped files", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }];
const call = { threadId: "thread", turnId: "turn", callId: "call", tool: "kestrel_0", arguments: { path: "file.ts" }, namespace: null };

describe("Codex dynamic tool boundary", () => {
	it("projects only the current Kestrel tool catalog into protocol-safe aliases", () => {
		expect(codexDynamicTools(tools)).toEqual([{ type: "function", name: "kestrel_0", description: "workspace.read: Read scoped files", inputSchema: tools[0]!.inputSchema }]);
		expect(parseCodexDynamicToolCall(call, tools, "thread", "turn")).toMatchObject({ name: "workspace.read", arguments: { path: "file.ts" } });
	});

	it.each([
		{ threadId: "another" }, { turnId: "stale" }, { namespace: "native" },
		{ tool: "kestrel_1" }, { tool: "kestrel_00" }, { tool: "shell" },
		{ arguments: [] }, { arguments: { path: "x".repeat(100_001) } },
	])("rejects requests outside the active step: %j", (overrides) => {
		expect(() => parseCodexDynamicToolCall({ ...call, ...overrides }, tools, "thread", "turn")).toThrow();
	});
});
