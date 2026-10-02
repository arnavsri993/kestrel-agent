import { describe, expect, it } from "vitest";
import { codexToolOutputSchema, parseCodexToolResponse } from "./codex-tool-bridge";
const tools = [{ name: "tools.search", description: "Discover tools", inputSchema: { type: "object" } }];
const envelope = (name = "tools.search", argumentsJson = "{}") => JSON.stringify({ text: "", toolCalls: [{ name, argumentsJson }] });
describe("Codex Kestrel tool bridge", () => {
 it("restricts the output schema to the current tool catalog", () => {
  expect(JSON.stringify(codexToolOutputSchema(tools))).toContain('"enum":["tools.search"]');
 });
 it("accepts plain final answers and gives requests unique IDs", () => {
  expect(parseCodexToolResponse('{"text":"Done","toolCalls":[]}', tools)).toEqual({ text: "Done", toolCalls: [] });
  expect(parseCodexToolResponse(envelope(), tools).toolCalls[0]!.id).not.toBe(parseCodexToolResponse(envelope(), tools).toolCalls[0]!.id);
 });
 it.each(["not JSON", '```json\n{"text":"","toolCalls":[]}\n```', '{"text":"","toolCalls":[],"extra":true}', JSON.stringify({text:"",toolCalls:Array(17).fill({name:"tools.search",argumentsJson:"{}"})})])("rejects invalid envelopes without partial execution", raw => {
  expect(() => parseCodexToolResponse(raw, tools)).toThrow("invalid Kestrel tool response");
 });
 it("rejects tools outside the current catalog", () => {
  expect(() => parseCodexToolResponse(envelope("shell.execute"), tools)).toThrow("outside");
 });
 it.each(["[]", "null", "42", '"string"', "{"])("rejects non-object or malformed arguments", raw => {
  expect(() => parseCodexToolResponse(envelope("tools.search", raw), tools)).toThrow();
 });
});
