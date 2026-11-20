import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPackagedVaultFramework, sealPackagedVaultRecord } from "./native-vault-bundle-record.mjs";

describe.skipIf(process.platform !== "darwin")("vault framework record across actual code signing", () => {
 let temporary, app, originalHash;
 const run = (command, args) => execFileSync(command, args, { stdio: "pipe", timeout: 30000 });
 beforeAll(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-vault-signature-")));
  app = join(temporary, "Fixture.app");
  const framework = join(app, "Contents/Frameworks/Chromium Embedded Framework.framework");
  const version = join(framework, "Versions/A");
  for (const path of [join(app, "Contents/MacOS"), join(app, "Contents/Resources"), join(version, "Resources")])
   await mkdir(path, { recursive: true });
  const plist = (identifier, executable, type) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>${type}</string></dict></plist>`;
  await writeFile(join(app, "Contents/Info.plist"), plist("com.kestrel.vault-signature-fixture", "Fixture", "APPL"));
  await writeFile(join(version, "Resources/Info.plist"), plist("com.kestrel.vault-signature-framework-fixture", "Chromium Embedded Framework", "FMWK"));
  await symlink("A", join(framework, "Versions/Current"));
  await symlink("Versions/Current/Chromium Embedded Framework", join(framework, "Chromium Embedded Framework"));
  await symlink("Versions/Current/Resources", join(framework, "Resources"));
  const source = join(temporary, "fixture.c"); await writeFile(source, "int fixture(void) { return 1; } int main(void) { return 0; }\n");
  run("/usr/bin/xcrun", ["clang", source, "-o", join(app, "Contents/MacOS/Fixture")]);
  run("/usr/bin/xcrun", ["clang", "-dynamiclib", source, "-o", join(version, "Chromium Embedded Framework")]);
  originalHash = await hashPackagedVaultFramework(app);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime", app]);
 }, 60000);
 afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
 it("records the final signed framework and reseals the outer app without changing nested code", async () => {
  const signedHash = await hashPackagedVaultFramework(app);
  expect(signedHash).not.toBe(originalHash);
  const record = await sealPackagedVaultRecord({ app, record: { apiVersion: 1, frameworkSha256: originalHash },
   signOuter: () => run("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", app]) });
  expect(record.sourceFrameworkSha256).toBe(originalHash);
  expect(record.frameworkSha256).toBe(signedHash);
  expect(JSON.parse(await readFile(join(app, "Contents/Resources/native-vault-engine.json"), "utf8"))).toEqual(record);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
 });
});
