import { createHash } from "node:crypto";
import type { AgentRuntime } from "./runtime";
import { NativeChannelAdapter } from "./channels";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events"
] as const;

function boundedCalendarResultCount(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.trunc(value)))
    : 20;
}

interface StoredGoogleWorkspaceAuthorization {
  version: 1;
  clientId: string;
  refreshToken: string;
  email: string;
  scopes: string[];
  connectedAt: string;
}

function parseRecord(raw: string): StoredGoogleWorkspaceAuthorization {
  if (raw.length > 100_000) throw new Error("Google Workspace authorization record is too large.");
  let record: Partial<StoredGoogleWorkspaceAuthorization>;
  try { record = JSON.parse(raw) as Partial<StoredGoogleWorkspaceAuthorization>; }
  catch { throw new Error("Google Workspace authorization record is invalid."); }
  if (record.version !== 1 || typeof record.clientId !== "string" || typeof record.refreshToken !== "string" || typeof record.email !== "string" || !Array.isArray(record.scopes) || typeof record.connectedAt !== "string") throw new Error("Google Workspace authorization record is invalid.");
  if (!/^[0-9]+-[A-Za-z0-9_-]{20,200}\.apps\.googleusercontent\.com$/.test(record.clientId) || record.refreshToken.length < 20 || record.refreshToken.length > 20_000) throw new Error("Google Workspace authorization record is invalid.");
  for (const scope of REQUIRED_SCOPES) if (!record.scopes.includes(scope)) throw new Error(`Google Workspace authorization is missing ${scope}.`);
  return record as StoredGoogleWorkspaceAuthorization;
}

async function responseJson(response: Response, limit = 256_000): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error("Google Workspace response exceeds its size limit.");
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Google Workspace returned invalid JSON.");
  }
}

export class GoogleWorkspaceClient {
  readonly email: string;
  readonly gmailAdapter: NativeChannelAdapter;
  private accessToken: { value: string; expiresAt: number } | undefined;
  private refreshInFlight: Promise<string> | undefined;

  constructor(private readonly record: StoredGoogleWorkspaceAuthorization, private readonly fetcher: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {
    this.email = record.email;
    this.gmailAdapter = new NativeChannelAdapter({ id: "google-workspace-gmail", kind: "gmail", tokenProvider: () => this.token(), fetcher, now });
  }

  async listEvents(input: { timeMin: string; timeMax?: string; maxResults: number; signal: AbortSignal }): Promise<Record<string, unknown>> {
    const maxResults = boundedCalendarResultCount(input.maxResults);
    const url = new URL(CALENDAR_EVENTS_ENDPOINT);
    url.search = new URLSearchParams({
      timeMin: new Date(input.timeMin).toISOString(),
      ...(input.timeMax ? { timeMax: new Date(input.timeMax).toISOString() } : {}),
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime"
    }).toString();
    const body = await this.authorizedJson(url, { signal: input.signal });
    const items = Array.isArray(body.items) ? body.items.slice(0, maxResults).map((raw) => {
      const event = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const start = event.start && typeof event.start === "object" ? event.start as Record<string, unknown> : {};
      const end = event.end && typeof event.end === "object" ? event.end as Record<string, unknown> : {};
      const attendees = Array.isArray(event.attendees)
        ? event.attendees.slice(0, 500).flatMap((rawAttendee) => {
            if (!rawAttendee || typeof rawAttendee !== "object") return [];
            const attendee = rawAttendee as Record<string, unknown>;
            const email =
              typeof attendee.email === "string"
                ? attendee.email.slice(0, 500)
                : undefined;
            const name =
              typeof attendee.displayName === "string"
                ? attendee.displayName.slice(0, 300)
                : undefined;
            if (!email && !name) return [];
            return [{
              ...(email ? { email } : {}),
              ...(name ? { name } : {}),
              ...(typeof attendee.responseStatus === "string"
                ? { responseStatus: attendee.responseStatus.slice(0, 100) }
                : {}),
              organizer: attendee.organizer === true,
            }];
          })
        : [];
      const conference = event.conferenceData && typeof event.conferenceData === "object"
        ? event.conferenceData as Record<string, unknown>
        : {};
      const entryPoints = Array.isArray(conference.entryPoints)
        ? conference.entryPoints
        : [];
      const videoEntry = entryPoints.find((entry) =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            (entry as Record<string, unknown>).entryPointType === "video",
        ),
      ) as Record<string, unknown> | undefined;
      return {
        id: String(event.id ?? "").slice(0, 1_024),
        title: String(event.summary ?? "(untitled)").slice(0, 2_000),
        start: String(start.dateTime ?? start.date ?? "").slice(0, 100),
        end: String(end.dateTime ?? end.date ?? "").slice(0, 100),
        allDay: Boolean(start.date && !start.dateTime),
        timeZone: String(start.timeZone ?? end.timeZone ?? "").slice(0, 200),
        status: String(event.status ?? "").slice(0, 100),
        description:
          typeof event.description === "string"
            ? event.description.slice(0, 20_000)
            : undefined,
        location:
          typeof event.location === "string"
            ? event.location.slice(0, 2_000)
            : undefined,
        meetingUrl:
          typeof event.hangoutLink === "string"
            ? event.hangoutLink.slice(0, 4_000)
            : typeof videoEntry?.uri === "string"
              ? videoEntry.uri.slice(0, 4_000)
              : undefined,
        attendees,
        recurrenceRule: Array.isArray(event.recurrence)
          ? event.recurrence.map(String).join("\n").slice(0, 4_000)
          : undefined
      };
    }) : [];
    return { calendar: "primary", items };
  }

  async createEvent(input: { operationId: string; title: string; startsAt: string; endsAt: string; description?: string; location?: string; signal: AbortSignal }): Promise<Record<string, unknown>> {
    const eventId = createHash("sha256").update(`workstrand-google-calendar\0${input.operationId}`).digest("hex").slice(0, 32);
    const eventUrl = `${CALENDAR_EVENTS_ENDPOINT}/${eventId}`;
    const existing = await this.authorizedJson(new URL(eventUrl), { signal: input.signal, allowNotFound: true });
    if (existing.id === eventId) return this.eventResult(existing, true);
    const created = await this.authorizedJson(new URL(CALENDAR_EVENTS_ENDPOINT), {
      method: "POST",
      signal: input.signal,
      body: {
        id: eventId,
        summary: input.title,
        start: { dateTime: new Date(input.startsAt).toISOString() },
        end: { dateTime: new Date(input.endsAt).toISOString() },
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {})
      }
    });
    if (created.id !== eventId) throw new Error("Google Calendar returned an unexpected event ID.");
    const verified = await this.authorizedJson(new URL(eventUrl), { signal: input.signal });
    if (verified.id !== eventId) throw new Error("Google Calendar event could not be read back.");
    return this.eventResult(verified, false);
  }

  private eventResult(event: Record<string, unknown>, repeated: boolean): Record<string, unknown> {
    return {
      eventId: String(event.id ?? ""),
      htmlLink: typeof event.htmlLink === "string" ? event.htmlLink.slice(0, 2_000) : undefined,
      status: String(event.status ?? ""),
      repeated,
      verified: true
    };
  }

  private async token(): Promise<string> {
    const now = this.now().getTime();
    if (this.accessToken && this.accessToken.expiresAt > now + 60_000) return this.accessToken.value;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshToken().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  private async refreshToken(): Promise<string> {
    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.record.clientId, refresh_token: this.record.refreshToken, grant_type: "refresh_token" })
    });
    const body = await responseJson(response, 64_000);
    if (!response.ok) throw new Error(`Google Workspace token refresh failed (${String(body.error ?? response.status).slice(0, 200)}). Reconnect in Settings.`);
    const value = typeof body.access_token === "string" ? body.access_token : "";
    const expiresIn = Number(body.expires_in);
    if (value.length < 20 || value.length > 20_000 || !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86_400) throw new Error("Google Workspace token refresh returned an invalid token.");
    this.accessToken = { value, expiresAt: this.now().getTime() + expiresIn * 1_000 };
    return value;
  }

  private async authorizedJson(url: URL, input: { method?: "POST"; body?: Record<string, unknown>; signal: AbortSignal; allowNotFound?: boolean }): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, {
      method: input.method ?? "GET",
      redirect: "error",
      signal: input.signal,
      headers: { accept: "application/json", authorization: `Bearer ${await this.token()}`, ...(input.body ? { "content-type": "application/json" } : {}) },
      ...(input.body ? { body: JSON.stringify(input.body) } : {})
    });
    if (input.allowNotFound && response.status === 404) {
      await response.arrayBuffer();
      return {};
    }
    const body = await responseJson(response);
    if (!response.ok) throw new Error(`Google Workspace request failed (${response.status}: ${String(body.error ?? response.statusText).slice(0, 500)}).`);
    return body;
  }
}

export function environmentGoogleWorkspaceClient(environment: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()): GoogleWorkspaceClient | undefined {
  const raw = environment.KESTREL_GOOGLE_WORKSPACE_OAUTH;
  return raw ? new GoogleWorkspaceClient(parseRecord(raw), fetcher, now) : undefined;
}

export function installGoogleWorkspaceTools(runtime: AgentRuntime, client: GoogleWorkspaceClient, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: { name: "google.calendar.list-events", title: "List Google Calendar events", description: "Read a bounded time range from the connected primary Google Calendar.", category: "connector", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "connector", tags: ["google", "calendar", "events", "schedule"] },
    inputSchema: { type: "object", properties: { timeMin: { type: "string", format: "date-time" }, timeMax: { type: "string", format: "date-time" }, maxResults: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, required: ["timeMin"] },
    execute: ({ signal }, input) => client.listEvents({ timeMin: String(input.timeMin), ...(input.timeMax ? { timeMax: String(input.timeMax) } : {}), maxResults: Number(input.maxResults ?? 20), signal })
  });
  runtime.registerExternalTool({
    descriptor: { name: "google.calendar.create-event", title: "Create Google Calendar event", description: "Create one deterministic event in the connected primary calendar and read it back after explicit approval.", category: "connector", riskLevel: "external", readOnly: false, requiresWorkspace: false, source: "connector", tags: ["google", "calendar", "event", "create"] },
    inputSchema: { type: "object", properties: { operationId: { type: "string", minLength: 8, maxLength: 200 }, title: { type: "string", minLength: 1, maxLength: 2_000 }, startsAt: { type: "string", format: "date-time" }, endsAt: { type: "string", format: "date-time" }, description: { type: "string", maxLength: 10_000 }, location: { type: "string", maxLength: 2_000 } }, required: ["operationId", "title", "startsAt", "endsAt"] },
    execute: ({ signal }, input) => client.createEvent({ operationId: String(input.operationId), title: String(input.title), startsAt: String(input.startsAt), endsAt: String(input.endsAt), ...(input.description ? { description: String(input.description) } : {}), ...(input.location ? { location: String(input.location) } : {}), signal }),
    verify: (_context, _input, output) => ({ method: "google-calendar-read-back", evidence: { eventId: output.eventId, verified: output.verified, repeated: output.repeated } })
  });
  runtime.allowTool(sessionId, "google.calendar.list-events");
  runtime.allowTool(sessionId, "google.calendar.create-event");
}
