import { describe, expect, it } from "vitest";
import { parseFormAction, safeFormTarget } from "./browser-target-policy";

describe("Chromium inspected form authority", () => {
  it("accepts bounded actions only against inspected refs", () => {
    expect(parseFormAction({ type: "type", target: "e42", text: "Draft" })).toEqual({ type: "type", target: "e42", text: "Draft" });
    for (const action of [
      { type: "click", target: "#save" }, { type: "type", target: "e1", text: "x".repeat(20_001) },
      { type: "click", target: "e1", script: "anything" }, { type: "key", target: "e1", key: "Enter" },
    ]) expect(() => parseFormAction(action)).toThrow();
  });
  it("excludes credentials, payments and unsupported input types", () => {
    const target = { tag: "INPUT", inputType: "text", autocomplete: "", name: "Draft title" };
    expect(safeFormTarget(target)).toBe(true);
    for (const patch of [
      { inputType: "password" }, { inputType: "file" }, { inputType: "hidden" },
      { autocomplete: "one-time-code" }, { autocomplete: "cc-number" },
      { name: "API key" }, { name: "Verification code" }, { name: "Social Security number" },
    ]) expect(safeFormTarget({ ...target, ...patch })).toBe(false);
  });
});
