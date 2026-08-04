import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import { environmentGoogleWorkspaceClient, installGoogleWorkspaceTools } from "./google-workspace";

const authorization = JSON.stringify({
  version: 1,
  clientId: "1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com",
  refreshToken: "refresh-token-value-that-is-long-enough",
  email: "person@example.test",
  scopes: [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events"
  ],
  connectedAt: "2026-07-23T07:00:00.000Z"
});

describe("Google Workspace runtime connector", () => {
  it("refreshes in memory, sends Gmail, and read-back verifies idempotent Calendar events", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: string }> = [];
    let event: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") ?? "", method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
      if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "runtime-access-token-that-is-long-enough", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
      if (url.includes("gmail.googleapis.com")) return new Response(JSON.stringify({ id: "gmail-message-1" }), { status: 200 });
      if (url.includes("/calendar/v3/calendars/primary/events/")) {
        if (!event) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
        return new Response(JSON.stringify(event), { status: 200 });
      }
      if (url.includes("/calendar/v3/calendars/primary/events") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        event = { ...body, status: "confirmed", htmlLink: "https://calendar.google.test/event" };
        return new Response(JSON.stringify(event), { status: 200 });
      }
      if (url.includes("/calendar/v3/calendars/primary/events")) return new Response(JSON.stringify({ items: [{ id: "existing-1", summary: "Existing", start: { dateTime: "2026-07-24T14:00:00.000Z" }, end: { dateTime: "2026-07-24T15:00:00.000Z" }, status: "confirmed" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    };
    const client = environmentGoogleWorkspaceClient({ KESTREL_GOOGLE_WORKSPACE_OAUTH: authorization }, fetcher, () => new Date("2026-07-23T07:30:00.000Z"));
    expect(client?.email).toBe("person@example.test");
    const gmail = await client!.gmailAdapter.send({ conversationId: "teacher@example.test", text: "Hello", idempotencyKey: "gmail-operation-1", signal: new AbortController().signal });
    expect(gmail.externalId).toBe("gmail-message-1");

    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Google Workspace" });
    installGoogleWorkspaceTools(runtime, client!, session.id);
    const listed = await runtime.callTool(session.id, "google.calendar.list-events", { timeMin: "2026-07-23T00:00:00.000Z", maxResults: 10 });
    expect(listed.output).toMatchObject({ calendar: "primary", items: [{ id: "existing-1", title: "Existing" }] });
    const malformedCount = await client!.listEvents({ timeMin: "2026-07-23T00:00:00.000Z", maxResults: Number.NaN, signal: new AbortController().signal });
    expect(malformedCount).toMatchObject({ items: [{ id: "existing-1" }] });
    expect(new URL(requests.at(-1)!.url).searchParams.get("maxResults")).toBe("20");
    const fractionalCount = await client!.listEvents({ timeMin: "2026-07-23T00:00:00.000Z", maxResults: 1.9, signal: new AbortController().signal });
    expect(fractionalCount).toMatchObject({ items: [{ id: "existing-1" }] });
    expect(new URL(requests.at(-1)!.url).searchParams.get("maxResults")).toBe("1");
    const createInput = { operationId: "calendar-operation-1", title: "Project review", startsAt: "2026-07-24T16:00:00.000Z", endsAt: "2026-07-24T17:00:00.000Z" };
    expect((await runtime.callTool(session.id, "google.calendar.create-event", createInput, { idempotencyKey: "calendar-operation-1" })).status).toBe("blocked");
    const created = await runtime.callTool(session.id, "google.calendar.create-event", createInput, { approvalStatus: "approved", idempotencyKey: "calendar-operation-1" });
    expect(created).toMatchObject({ status: "verified", output: { status: "confirmed", repeated: false, verified: true }, verification: { method: "google-calendar-read-back" } });
    expect((await runtime.callTool(session.id, "google.calendar.create-event", createInput, { approvalStatus: "approved", idempotencyKey: "calendar-operation-1" })).id).toBe(created.id);
    expect(requests.filter((request) => request.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/calendar/v3/calendars/primary/events"))).toHaveLength(1);
    expect(requests.filter((request) => request.authorization).every((request) => request.authorization === "Bearer runtime-access-token-that-is-long-enough")).toBe(true);
    database.close();
  });

  it("rejects records without the exact narrow grants", () => {
    const missingScope = JSON.stringify({ ...JSON.parse(authorization), scopes: ["openid", "email"] });
    expect(() => environmentGoogleWorkspaceClient({ KESTREL_GOOGLE_WORKSPACE_OAUTH: missingScope })).toThrow("missing");
  });

  it("bounds ignored not-found Workspace bodies before treating them as absent", async () => {
    let cancelled = false;
    const reader = {
      read: async () => ({
        done: false,
        value: { byteLength: 256_001 } as Uint8Array,
      }),
      cancel: async () => {
        cancelled = true;
      },
      releaseLock: () => undefined,
    };
    const fetcher: typeof fetch = async (input) => {
      if (String(input) === "https://oauth2.googleapis.com/token")
        return new Response(
          JSON.stringify({
            access_token: "runtime-access-token-that-is-long-enough",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers({ "content-type": "application/json" }),
        body: { getReader: () => reader },
      } as unknown as Response;
    };
    const client = environmentGoogleWorkspaceClient(
      { KESTREL_GOOGLE_WORKSPACE_OAUTH: authorization },
      fetcher,
    );

    await expect(
      client!.createEvent({
        operationId: "calendar-overlimit-404",
        title: "Project review",
        startsAt: "2026-07-24T16:00:00.000Z",
        endsAt: "2026-07-24T17:00:00.000Z",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Google Workspace response exceeds its size limit.");
    expect(cancelled).toBe(true);
  });
});
