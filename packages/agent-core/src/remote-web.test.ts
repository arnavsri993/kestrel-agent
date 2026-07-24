import { describe, expect, it } from "vitest";
import { remoteWebAsset } from "./remote-web";

describe("remoteWebAsset", () => {
  it("should return the asset for known paths", () => {
    const rootAsset = remoteWebAsset("/");
    expect(rootAsset).toBeDefined();
    expect(rootAsset?.contentType).toBe("text/html; charset=utf-8");
    expect(rootAsset?.cacheControl).toBe("no-store");

    const cssAsset = remoteWebAsset("/app/app.css");
    expect(cssAsset).toBeDefined();
    expect(cssAsset?.contentType).toBe("text/css; charset=utf-8");
    expect(cssAsset?.cacheControl).toBe("public, max-age=3600");

    const jsAsset = remoteWebAsset("/app/app.js");
    expect(jsAsset).toBeDefined();
    expect(jsAsset?.contentType).toBe("text/javascript; charset=utf-8");
    expect(jsAsset?.cacheControl).toBe("no-store");
  });

  it("should return the asset for all known standard paths", () => {
    const knownPaths = [
      "/",
      "/app/",
      "/app/app.css",
      "/app/app.js",
      "/app/manifest.webmanifest",
      "/app/sw.js",
      "/app/icon.svg",
    ];

    for (const path of knownPaths) {
      expect(remoteWebAsset(path)).toBeDefined();
    }
  });

  it("should return undefined for unknown paths", () => {
    expect(remoteWebAsset("/invalid-path")).toBeUndefined();
    expect(remoteWebAsset("/app/unknown.js")).toBeUndefined();
    expect(remoteWebAsset("")).toBeUndefined();
  });
});
