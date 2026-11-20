import { describe, expect, it } from "vitest";
// @ts-expect-error Runtime module is shipped unchanged under bundled Node.
import { nativeProjectHandoffArgument } from "./native-project-handoff-argument.mjs";
const id = "abcdef12-1234-4234-8234-123456789012";
describe("native project handoff argument", () => {
  it("accepts only a single owner supplied canonical identity", () => {
    expect(nativeProjectHandoffArgument(["node", "entry", "--profile-root", "/fixture"])).toBeUndefined();
    expect(nativeProjectHandoffArgument(["node", "entry", "--project-handoff-id", id])).toBe(id);
    for (const tail of [[], ["--profile-root"], [id.toUpperCase()], ["12345678-1234-1234-8234-123456789012"], [id, "--project-handoff-id", id]])
      expect(() => nativeProjectHandoffArgument(["node", "entry", "--project-handoff-id", ...tail])).toThrow("selection is invalid");
  });
});
