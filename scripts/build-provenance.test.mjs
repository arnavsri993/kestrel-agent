import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sourceProvenance } from "./build-provenance.mjs";

it("keeps desktop and core identity stable during transient config loading while detecting real edits", () => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-provenance-build-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    const config = join(root, "apps/desktop/electron.vite.config.ts");
    writeFileSync(config, "source config"); git("add", "."); git("commit", "-m", "source");
    const before = sourceProvenance(root);
    writeFileSync(join(root, "apps/desktop/electron.vite.config.1790865600000.mjs"), "generated config");
    expect(sourceProvenance(root)).toEqual(before);
    writeFileSync(config, "changed actual source");
    const changed = sourceProvenance(root);
    expect(changed.dirty).toBe(true); expect(changed.buildId).not.toBe(before.buildId);
    writeFileSync(config, "source config");
    writeFileSync(join(root, "apps/desktop/new-source.ts"), "real new input");
    expect(sourceProvenance(root).dirty).toBe(true);
    expect(sourceProvenance(root).buildId).not.toBe(before.buildId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
