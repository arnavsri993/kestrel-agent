import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "./credential-broker";
import { GoogleWorkspaceOAuthManager } from "./google-workspace-oauth";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workstrand-google-oauth-"));
  roots.push(root);
  const protection = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString()
  };
  return { root, broker: new CredentialBroker(root, protection) };
}

describe("Google Workspace desktop OAuth", () => {
  it("uses loopback PKCE, verifies narrow grants, and stores only an encrypted refresh record", async () => {
    const { root, broker } = fixture();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let authorizationUrl = "";
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({
        access_token: "access-token-value-that-is-long-enough",
        refresh_token: "refresh-token-value-that-is-long-enough",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events"
      }), { status: 200 });
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") return new Response(JSON.stringify({ email: "person@example.test" }), { status: 200 });
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
      return fetch(input, init);
    };
    const manager = new GoogleWorkspaceOAuthManager({
      broker,
      fetcher,
      now: () => new Date("2026-07-23T07:00:00.000Z"),
      openExternal: async (url) => {
        authorizationUrl = url;
        const authorization = new URL(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "one-time-code");
        await fetch(callback);
      }
    });
    const status = await manager.connect("1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com");
    expect(status).toMatchObject({ connected: true, email: "person@example.test", connectedAt: "2026-07-23T07:00:00.000Z" });
    const authorization = new URL(authorizationUrl);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/google\/callback$/);
    const tokenBody = String(requests.find((request) => request.url.endsWith("/token"))?.init?.body);
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).not.toContain("client_secret");
    const stored = await broker.getOpaqueSecret("google-workspace-oauth");
    expect(stored).toContain("refresh-token-value");
    expect(stored).not.toContain("access-token-value");
    expect(readFileSync(join(root, "secure", "credentials", "opaque-google-workspace-oauth.bin"), "utf8")).not.toContain("refresh-token-value");
    expect(await manager.disconnect()).toEqual({ connected: false, scopes: [] });
    expect(await broker.getOpaqueSecret("google-workspace-oauth")).toBeUndefined();
  });

  it("rejects non-desktop client IDs and incomplete grants", async () => {
    const { broker } = fixture();
    const manager = new GoogleWorkspaceOAuthManager({ broker, openExternal: async () => {} });
    await expect(manager.connect("not-a-desktop-client")).rejects.toThrow("Desktop app");
  });
});
