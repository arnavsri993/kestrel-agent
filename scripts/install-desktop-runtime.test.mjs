import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// The fake package command records arguments and fails. The real installer
// cannot execute, build an app, access a profile, or replace the canonical app.
describe.skipIf(process.platform === "win32")("desktop installer native engine forwarding", () => {
 let temporary;
 beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "kestrel-install-engine-"));
  await writeFile(join(temporary, "corepack"), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.KESTREL_TEST_PACK_ARGUMENT_RECORD, JSON.stringify(process.argv.slice(2))); process.exit(37);\n", { mode: 0o700 });
 });
 afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
 async function run({ argv = [], runtime = "chromium", engine = "/reviewed/environment-engine" } = {}) {
  const record = join(temporary, `${randomUUID()}.json`);
  const result = spawnSync(process.execPath, [resolve("scripts/install-desktop-runtime.mjs"), ...argv], {
   encoding: "utf8", timeout: 10000,
   env: { ...process.env, PATH: `${temporary}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    KESTREL_DESKTOP_RUNTIME: runtime, KESTREL_NATIVE_VAULT_CEF_RUNTIME: engine,
    KESTREL_TEST_PACK_ARGUMENT_RECORD: record },
  });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  const args = await readFile(record, "utf8").then(JSON.parse).catch(error => { if (error.code !== "ENOENT") throw error; });
  return { result, args };
 }
 it("forwards the environment's selected engine into the package subprocess and stops before install", async () => {
  const { result, args } = await run();
  expect(args).toEqual(["pnpm", "package:mac:native", "--vault-cef-runtime", "/reviewed/environment-engine"]);
  expect(result.status).toBe(37);
 });
 it("preserves the CLI choice over an inherited engine setting", async () => {
  const { result, args } = await run({ runtime: "native", argv: ["--vault-cef-runtime=/reviewed/CLI engine=1"] });
  expect(args).toEqual(["pnpm", "package:mac:native", "--vault-cef-runtime", "/reviewed/CLI engine=1"]);
  expect(result.status).toBe(37);
 });
 it("rejects a missing option value before starting the package command", async () => {
  const { result, args } = await run({ argv: ["--vault-cef-runtime"] });
  expect(args).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toContain("requires a distribution path");
 });
 it("keeps native-only engine settings out of the Electron route", async () => {
  const { result, args } = await run({ runtime: "electron", engine: "" });
  expect(args).toEqual(["pnpm", "install:mac:dev"]); expect(result.status).toBe(37);
 });
 it("rejects an unknown runtime before packaging instead of falling through to Electron", async () => {
  const { result, args } = await run({ runtime: "chromuim" });
  expect(args).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown KESTREL_DESKTOP_RUNTIME");
 });
});
