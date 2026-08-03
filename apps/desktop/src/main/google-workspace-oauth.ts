import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialBroker } from "./credential-broker";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_PROBE_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_WORKSPACE_SECRET_ID = "google-workspace-oauth";
const REQUESTED_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events"
] as const;

interface GoogleWorkspaceOAuthRecord {
  version: 1;
  clientId: string;
  refreshToken: string;
  email: string;
  scopes: string[];
  connectedAt: string;
}

export interface GoogleWorkspaceOAuthStatus {
  connected: boolean;
  email?: string;
  scopes: string[];
  connectedAt?: string;
  clientIdSuffix?: string;
}

interface GoogleWorkspaceOAuthManagerOptions {
  broker: CredentialBroker;
  openExternal(url: string): Promise<unknown>;
  fetcher?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

function boundedJson(bytes: Uint8Array, limit: number, label: string): Record<string, unknown> {
  if (bytes.byteLength > limit) throw new Error(`${label} response exceeds ${Math.round(limit / 1024)} KB.`);
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned an invalid JSON response.`);
  }
}

function validClientId(clientId: string): boolean {
  return /^[0-9]+-[A-Za-z0-9_-]{20,200}\.apps\.googleusercontent\.com$/.test(clientId);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export class GoogleWorkspaceOAuthManager {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleWorkspaceOAuthManagerOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = Math.max(30_000, Math.min(10 * 60_000, options.timeoutMs ?? 5 * 60_000));
  }

  async status(): Promise<GoogleWorkspaceOAuthStatus> {
    const record = await this.readRecord();
    if (!record) return { connected: false, scopes: [] };
    return {
      connected: true,
      email: record.email,
      scopes: [...record.scopes],
      connectedAt: record.connectedAt,
      clientIdSuffix: record.clientId.slice(-24)
    };
  }

  async connect(rawClientId: string, signal?: AbortSignal): Promise<GoogleWorkspaceOAuthStatus> {
    const clientId = rawClientId.trim();
    if (!validClientId(clientId)) throw new Error("Enter a Google OAuth client ID created for a Desktop app.");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Google sign-in was cancelled.");

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    let settleCallback: ((result: { code?: string; error?: string }) => void) | undefined;
    const callback = new Promise<{ code?: string; error?: string }>((resolve) => { settleCallback = resolve; });
    let settled = false;
    const settle = (result: { code?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      settleCallback?.(result);
    };
    const server = createServer((request, response) => {
      if (!isLoopback(request.socket.remoteAddress) || request.method !== "GET" || !request.url) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Forbidden");
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url, "http://127.0.0.1");
      } catch {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Invalid OAuth callback. Return to Kestrel and try again.");
        return;
      }
      if (url.pathname !== "/oauth/google/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Invalid OAuth callback. Return to Kestrel and try again.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      response.writeHead(error || !code ? 400 : 200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
      });
      response.end(error || !code
        ? "<!doctype html><title>Kestrel sign-in cancelled</title><p>Google sign-in was not completed. You can close this window and return to Kestrel.</p>"
        : "<!doctype html><title>Kestrel connected</title><p>Google Workspace is connected. You can close this window and return to Kestrel.</p>");
      settle(error ? { error } : code ? { code } : { error: "missing_code" });
    });

    const port = await listen(server);
    const redirectUri = `http://127.0.0.1:${port}/oauth/google/callback`;
    const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorization.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: REQUESTED_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    }).toString();

    let timeout: NodeJS.Timeout | undefined;
    const abort = () => settle({ error: "cancelled" });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      timeout = setTimeout(() => settle({ error: "timeout" }), this.timeoutMs);
      timeout.unref();
      await this.options.openExternal(authorization.toString());
      const result = await callback;
      if (!result.code) {
        if (result.error === "cancelled") throw signal?.reason instanceof Error ? signal.reason : new Error("Google sign-in was cancelled.");
        if (result.error === "timeout") throw new Error("Google sign-in timed out. Try again when you can finish the browser consent flow.");
        throw new Error(`Google sign-in did not complete (${result.error ?? "unknown_error"}).`);
      }
      const token = await this.exchangeCode({ clientId, code: result.code, codeVerifier, redirectUri });
      const grantedScopes = String(token.scope ?? "").split(/\s+/).filter(Boolean);
      for (const scope of REQUESTED_SCOPES) {
        if (!grantedScopes.includes(scope)) throw new Error(`Google did not grant the required ${scope} scope.`);
      }
      const accessToken = typeof token.access_token === "string" ? token.access_token : "";
      const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : "";
      if (accessToken.length < 20 || refreshToken.length < 20) throw new Error("Google did not return usable access and refresh tokens.");
      const email = await this.verifyIdentityAndCalendar(accessToken);
      const record: GoogleWorkspaceOAuthRecord = {
        version: 1,
        clientId,
        refreshToken,
        email,
        scopes: grantedScopes.sort(),
        connectedAt: this.now().toISOString()
      };
      await this.options.broker.setOpaqueSecret(GOOGLE_WORKSPACE_SECRET_ID, JSON.stringify(record));
      return this.status();
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await close(server);
    }
  }

  async disconnect(): Promise<GoogleWorkspaceOAuthStatus> {
    const record = await this.readRecord();
    if (record) {
      try {
        await this.fetcher(GOOGLE_REVOCATION_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: record.refreshToken })
        });
      } finally {
        await this.options.broker.removeOpaqueSecret(GOOGLE_WORKSPACE_SECRET_ID);
      }
    }
    return { connected: false, scopes: [] };
  }

  private async exchangeCode(input: { clientId: string; code: string; codeVerifier: string; redirectUri: string }): Promise<Record<string, unknown>> {
    const response = await this.fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code"
      })
    });
    const body = boundedJson(new Uint8Array(await response.arrayBuffer()), 64_000, "Google token exchange");
    if (!response.ok) throw new Error(`Google token exchange failed (${String(body.error ?? response.status).slice(0, 200)}).`);
    return body;
  }

  private async verifyIdentityAndCalendar(accessToken: string): Promise<string> {
    const headers = { accept: "application/json", authorization: `Bearer ${accessToken}` };
    const identityResponse = await this.fetcher(GOOGLE_USERINFO_ENDPOINT, { redirect: "error", headers });
    const identity = boundedJson(new Uint8Array(await identityResponse.arrayBuffer()), 64_000, "Google identity verification");
    if (!identityResponse.ok || typeof identity.email !== "string" || !identity.email.includes("@")) throw new Error("Google identity verification failed.");
    const calendarUrl = new URL(GOOGLE_CALENDAR_PROBE_ENDPOINT);
    calendarUrl.search = new URLSearchParams({ maxResults: "1", singleEvents: "true", timeMin: this.now().toISOString() }).toString();
    const calendarResponse = await this.fetcher(calendarUrl, { redirect: "error", headers });
    const calendar = boundedJson(new Uint8Array(await calendarResponse.arrayBuffer()), 256_000, "Google Calendar verification");
    if (!calendarResponse.ok || !Array.isArray(calendar.items)) throw new Error("Google Calendar verification failed.");
    return identity.email;
  }

  private async readRecord(): Promise<GoogleWorkspaceOAuthRecord | undefined> {
    const raw = await this.options.broker.getOpaqueSecret(GOOGLE_WORKSPACE_SECRET_ID);
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as Partial<GoogleWorkspaceOAuthRecord>;
      if (record.version !== 1 || !record.clientId || !record.refreshToken || !record.email || !Array.isArray(record.scopes) || !record.connectedAt) throw new Error();
      return record as GoogleWorkspaceOAuthRecord;
    } catch {
      throw new Error("Stored Google Workspace authorization is invalid. Disconnect it and sign in again.");
    }
  }
}

export const GOOGLE_WORKSPACE_OAUTH_ENVIRONMENT_KEY = "KESTREL_GOOGLE_WORKSPACE_OAUTH";
export const GOOGLE_WORKSPACE_OAUTH_SECRET_ID = GOOGLE_WORKSPACE_SECRET_ID;
