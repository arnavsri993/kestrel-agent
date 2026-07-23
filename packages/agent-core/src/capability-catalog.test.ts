import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_CATALOG, PARITY_SOURCE_SNAPSHOT, capabilitySummary } from "./capability-catalog";

describe("parity capability catalog", () => {
  it("uses stable unique IDs and evidence for every non-planned claim", () => {
    const ids = CAPABILITY_CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CAPABILITY_CATALOG).toHaveLength(55);
    for (const item of CAPABILITY_CATALOG) {
      if (item.status !== "planned") expect(item.evidence.length, item.id).toBeGreaterThan(0);
      if (item.status !== "implemented") expect(item.gap, item.id).toBeTruthy();
    }
  });

  it("keeps all four official source families and renders every catalog ID in the parity document", () => {
    expect(Object.keys(PARITY_SOURCE_SNAPSHOT).sort()).toEqual(["checkedAt", "claude-code", "codex", "hermes", "openclaw"]);
    const document = readFileSync(resolve(process.cwd(), "docs/parity-matrix.md"), "utf8");
    for (const item of CAPABILITY_CATALOG) expect(document, item.id).toContain(`\`${item.id}\``);
  });

  it("keeps every evidence path real and the documented summary synchronized", () => {
    const root = process.cwd();
    for (const item of CAPABILITY_CATALOG) {
      for (const evidence of item.evidence) expect(existsSync(resolve(root, evidence)), `${item.id}: ${evidence}`).toBe(true);
    }
    const summary = capabilitySummary();
    const document = readFileSync(resolve(root, "docs/parity-matrix.md"), "utf8");
    expect(document).toContain(`${CAPABILITY_CATALOG.length} capability families — ${summary.implemented} implemented, ${summary.partial} partial, ${summary.planned} planned`);
  });

  it("reports an honest status summary", () => {
    const summary = capabilitySummary();
    expect(summary.implemented + summary.partial + summary.planned).toBe(CAPABILITY_CATALOG.length);
    expect(summary).toEqual({ implemented: 55, partial: 0, planned: 0 });
    for (const item of CAPABILITY_CATALOG) {
      expect(item.status, item.id).toBe("implemented");
      expect(item.gap, item.id).toBeUndefined();
    }
  });
});
