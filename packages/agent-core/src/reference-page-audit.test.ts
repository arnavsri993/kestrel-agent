import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_CATALOG, PARITY_SOURCE_SNAPSHOT } from "./capability-catalog";

interface AuditedPage {
  product: "openclaw" | "hermes";
  path: string;
  sha: string;
  url: string;
  coverage: "implemented-core-family" | "implemented-extension-contract" | "operational-reference" | "unimplemented-gap";
  capabilityIds: string[];
  note: string;
  gapId?: string;
}

interface ReferenceAudit {
  schemaVersion: number;
  generatedAt: string;
  sources: Record<"openclaw" | "hermes", { repository: string; commit: string; pageCount: number; treeApi: string }>;
  pages: AuditedPage[];
}

function audit(): ReferenceAudit {
  return JSON.parse(readFileSync(resolve(process.cwd(), "docs/reference-page-audit.json"), "utf8")) as ReferenceAudit;
}

describe("page-level OpenClaw and Hermes audit", () => {
  it("pins every Markdown page to an immutable upstream blob with no unmapped pages", () => {
    const value = audit();
    expect(value.schemaVersion).toBe(1);
    expect(value.sources.openclaw).toMatchObject({ repository: "openclaw/openclaw", pageCount: 750 });
    expect(value.sources.hermes).toMatchObject({ repository: "NousResearch/hermes-agent", pageCount: 367 });
    expect(value.pages).toHaveLength(1_117);
    expect(value.sources.openclaw.commit).toBe(PARITY_SOURCE_SNAPSHOT.openclawCommit);
    expect(value.sources.hermes.commit).toBe(PARITY_SOURCE_SNAPSHOT.hermesCommit);
    expect(new Set(value.pages.map((page) => `${page.product}:${page.path}`)).size).toBe(value.pages.length);
    const capabilityIds = new Set(CAPABILITY_CATALOG.map((entry) => entry.id));
    for (const page of value.pages) {
      expect(page.sha, page.path).toMatch(/^[0-9a-f]{40}$/);
      expect(page.url, page.path).toContain(`/blob/${value.sources[page.product].commit}/${page.path}`);
      expect(page.capabilityIds.length, page.path).toBeGreaterThan(0);
      for (const id of page.capabilityIds) expect(capabilityIds.has(id), `${page.path}:${id}`).toBe(true);
      if (page.coverage === "unimplemented-gap") expect(page.gapId, page.path).toBeTruthy();
    }
  });

  it("does not disguise vendor integrations or known gaps as bundled core behavior", () => {
    const pages = audit().pages;
    const integrationPages = pages.filter((page) => page.coverage === "implemented-extension-contract");
    const gapPages = pages.filter((page) => page.coverage === "unimplemented-gap");
    expect(integrationPages).toHaveLength(375);
    expect(integrationPages.every((page) => page.note.includes("does not claim"))).toBe(true);
    expect(gapPages).toHaveLength(0);
  });
});
