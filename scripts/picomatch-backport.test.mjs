import { describe, expect, it } from "vitest";
import picomatch from "../node_modules/.pnpm/picomatch@4.0.5_patch_hash=10fa83fe269eaf7d53b39a29ddb989be11962f2da5f3728de19341f784d56976/node_modules/picomatch/index.js";

describe("picomatch repeated-extglob ReDoS backport", () => {
  it("literalizes a single-branch nested star pattern before regex execution", () => {
    for (const pattern of ["+(*)", "+(*a)"]) {
      const regex = picomatch.makeRe(pattern);
      expect(regex.source).toContain("\\+");
      expect(regex.test(`${"a".repeat(50)}/`)).toBe(false);
    }
  });

  it("preserves ordinary repeated extglob matching", () => {
    expect(picomatch.isMatch("aaa", "+(a)")).toBe(true);
    expect(picomatch.isMatch("ab", "+(a)")).toBe(false);
  });
});
