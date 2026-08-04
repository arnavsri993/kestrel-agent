import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustedProxyConfiguration } from "./trusted-proxy-config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("trusted proxy configuration", () => {
  it.each(["not json", "null", "[]"])("normalizes malformed JSON roots: %s", (contents) => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-trusted-proxy-"));
    roots.push(root);
    const path = join(root, "proxy.json");
    writeFileSync(path, contents, { mode: 0o600 });

    expect(() => trustedProxyConfiguration(path)).toThrow("Trusted proxy configuration is invalid.");
  });

  it("loads a valid owner-only configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-trusted-proxy-valid-"));
    roots.push(root);
    const path = join(root, "proxy.json");
    writeFileSync(path, JSON.stringify({ trustedSources: ["127.0.0.1"], requiredHeaders: [], allowUsers: [], maximumScopes: ["read"], userHeader: "x-auth-user", allowLoopback: true }), { mode: 0o600 });

    expect(trustedProxyConfiguration(path)).toMatchObject({ trustedSources: ["127.0.0.1"], allowLoopback: true });
  });
});
