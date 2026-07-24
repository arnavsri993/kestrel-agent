import { describe, expect, it } from "vitest";
import { remoteWebAsset } from "./remote-web";

describe("remoteWebAsset", () => {
  it("returns the asset for a valid route", () => {
    const asset = remoteWebAsset("/");
    expect(asset).toBeDefined();
    expect(asset?.contentType).toBe("text/html; charset=utf-8");
    expect(typeof asset?.body).toBe("string");
    expect(asset?.cacheControl).toBe("no-store");
  });

  it("returns the asset for an icon route", () => {
    const asset = remoteWebAsset("/app/icon.svg");
    expect(asset).toBeDefined();
    expect(asset?.contentType).toBe("image/svg+xml; charset=utf-8");
    expect(typeof asset?.body).toBe("string");
    expect(asset?.cacheControl).toBe("public, max-age=86400");
  });

  it("returns undefined for an invalid route", () => {
    const asset = remoteWebAsset("/invalid/route");
    expect(asset).toBeUndefined();
  });
});
