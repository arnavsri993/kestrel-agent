import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macosAppRuntime } from "./macos-app-runtime.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kestrel-runtime-")); roots.push(root); return root;
}
function add(root, path, directory = false) {
  const target = join(root, "Contents", path);
  if (directory) mkdirSync(target, { recursive: true });
  else { mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, "fixture"); }
}
it("recognizes complete Electron and native layouts regardless of shared production identifier", () => {
  const electron = fixture();
  add(electron, "Frameworks/Electron Framework.framework", true);
  add(electron, "Resources/app.asar");
  expect(macosAppRuntime(electron, "com.kestrel.desktop")).toBe("electron");
  const native = fixture();
  add(native, "Frameworks/Chromium Embedded Framework.framework", true);
  add(native, "MacOS/Kestrel Native Bridge");
  add(native, "Resources/native-core-relay.mjs");
  expect(macosAppRuntime(native, "com.kestrel.desktop")).toBe("native");
  expect(macosAppRuntime(native, "com.kestrel.native-chromium-host.dev")).toBe("native");
});
it("fails closed for missing, partial, and mixed layouts", () => {
  const bundle = fixture();
  expect(macosAppRuntime(bundle, "com.kestrel.desktop")).toBe("ambiguous");
  add(bundle, "Frameworks/Electron Framework.framework", true);
  add(bundle, "Resources/app.asar");
  add(bundle, "Frameworks/Chromium Embedded Framework.framework", true);
  expect(macosAppRuntime(bundle, "com.kestrel.desktop")).toBe("ambiguous");
  expect(macosAppRuntime(bundle, "com.kestrel.native-chromium-host.dev")).toBe("ambiguous");
});
