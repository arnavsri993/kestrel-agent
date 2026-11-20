import { expect, it } from "vitest";
import { selectNativeCodexCanaryModel, verifyNativeCodexCanaryCompletion } from "./native-provider-canary.mjs";
const available = (id, efforts = ["medium"]) => ({ id, availability: "available", capabilities: { reasoningEfforts: efforts } });
it("uses actual available-model reasoning metadata rather than assuming low is supported", () => {
	expect(selectNativeCodexCanaryModel([available("other"), available("gpt-6-luna", ["medium", "low"])] )).toMatchObject({ model: { id: "gpt-6-luna" }, reasoningEffort: "low" });
	expect(selectNativeCodexCanaryModel([available("medium-only")])).toMatchObject({ reasoningEffort: "medium" });
	expect(() => selectNativeCodexCanaryModel([{ ...available("unavailable"), availability: "unavailable" }])).toThrow();
	expect(() => selectNativeCodexCanaryModel([available("unadvertised", [])])).toThrow();
});
function completion() {
	return { sessionId: "generated-session", marker: "GENERATED_REPLY", prompt: "Generated prompt only", accountId: "native-cli-codex", model: "advertised-model",
		messages: [{ id: "user", sessionId: "generated-session", role: "user", content: "Generated prompt only" }, { id: "assistant", sessionId: "generated-session", role: "assistant", content: "GENERATED_REPLY" }],
		runs: [{ id: "run", sessionId: "generated-session", status: "completed", providerIds: ["native-cli-codex"], model: "advertised-model" }], executions: [] };
}
it("requires a completed selected-route reply with only generated input and no Core-recorded tools", () => {
	expect(verifyNativeCodexCanaryCompletion(completion())).toMatchObject({ runId: "run", coreRecordedToolExecutions: 0 });
});
it.each([
	["model fallback", c => { c.runs[0].model = "other"; }], ["provider fallback", c => { c.runs[0].providerIds = ["other"]; }],
	["unfinished run", c => { c.runs[0].status = "running"; }], ["partial marker", c => { c.messages[1].content += " extra"; }],
	["another session", c => { c.messages[1].sessionId = "other"; }], ["extra user input", c => { c.messages.push({ ...c.messages[0], id: "extra" }); }],
	["tool response", c => { c.messages.push({ sessionId: c.sessionId, role: "tool", content: "tool output" }); }],
	["tool request", c => { c.messages[1].modelToolCalls = [{ id: "call" }]; }], ["tool execution", c => { c.executions.push({ id: "execution" }); }],
])("rejects %s", (_name, mutate) => { const c = completion(); mutate(c); expect(() => verifyNativeCodexCanaryCompletion(c)).toThrow(); });
