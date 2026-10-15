import { describe, expect, it } from "vitest";
import {
  assertCiPackagesChromiumFirst,
  assertDesktopPackageProductBuild,
  assertPackageProductPath,
  assertRuntimeDefaultsToChromium,
  verifyChromiumProductPath,
} from "./verify-chromium-product-path.mjs";

describe("verify:chromium-product-path", () => {
  it("accepts chromium runtime defaults", () => {
    expect(
      assertRuntimeDefaultsToChromium(
        'const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "chromium").toLowerCase();',
        "scripts/dev-desktop-runtime.mjs",
      ),
    ).toEqual([]);
  });

  it("rejects electron runtime defaults", () => {
    expect(
      assertRuntimeDefaultsToChromium(
        'const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "electron").toLowerCase();',
        "scripts/dev-desktop-runtime.mjs",
      ),
    ).toEqual([
      'scripts/dev-desktop-runtime.mjs must default with KESTREL_DESKTOP_RUNTIME ?? "chromium"',
      "scripts/dev-desktop-runtime.mjs must not default KESTREL_DESKTOP_RUNTIME to electron",
    ]);
  });

  it("requires default scripts and Electron opt-in aliases", () => {
    const failures = assertPackageProductPath({
      scripts: {
        "dev:desktop:electron":
          "KESTREL_DESKTOP_RUNTIME=electron node scripts/dev-desktop-runtime.mjs",
      },
    });
    expect(failures.some((line) => line.includes("scripts.dev "))).toBe(true);
    expect(
      failures.some((line) => line.includes("package:mac:dev:electron")),
    ).toBe(true);
  });

  it("rejects meetup verify still packaging Electron by default", () => {
    const failures = assertPackageProductPath({
      scripts: {
        dev: "node scripts/dev-desktop-runtime.mjs",
        "dev:desktop": "node scripts/dev-desktop-runtime.mjs",
        "package:mac:dev": "node scripts/package-desktop-runtime.mjs",
        "install:mac:dev": "node scripts/install-desktop-runtime.mjs",
        "dev:desktop:electron":
          "KESTREL_DESKTOP_RUNTIME=electron node scripts/dev-desktop-runtime.mjs",
        "package:mac:dev:electron": "pnpm --filter @kestrel/desktop package:mac:dev",
        "install:mac:dev:electron": "pnpm package:mac:dev:electron && node x",
        "verify:meetup":
          "node scripts/verify-meetup-preflight.mjs && pnpm package:mac:dev:electron",
      },
    });
    expect(
      failures.some((line) => line.includes("verify:meetup must package")),
    ).toBe(true);
  });

  it("requires desktop product build to be renderer-only", () => {
    expect(
      assertDesktopPackageProductBuild({
        scripts: {
          build: "pnpm build:renderer",
          "build:electron": "electron-vite build && node verify.mjs",
        },
      }),
    ).toEqual([]);
    expect(
      assertDesktopPackageProductBuild({
        scripts: { build: "electron-vite build" },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("requires Chromium packaged CI before Electron legacy", () => {
    expect(
      assertCiPackagesChromiumFirst(`
      - run: corepack pnpm test:native-desktop-shell
      - name: Package native Chromium product path and run packaged native smokes
        run: |
          corepack pnpm package:mac:dev
          corepack pnpm test:packaged-native:arm64
          corepack pnpm test:packaged-native-desktop-shell:arm64
      - name: Legacy Electron Playwright suite (opt-in path until retire:electron)
        run: corepack pnpm test:desktop-smoke:electron
      `),
    ).toEqual([]);
  });

  it("passes against the live repository product path", () => {
    expect(verifyChromiumProductPath()).toEqual([]);
  });
});
