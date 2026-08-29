import { createHash } from "node:crypto";
import { NativeChannelAdapter } from "./channels";
import type { AgentRuntime } from "./runtime";
import {
	GMAIL_READONLY_SCOPE,
	type CommunicationCodeMatch,
	extractLoginCodes,
} from "@kestrel/shared-types";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_EVENTS_ENDPOINT =
	"https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CALENDAR_AVAILABILITY_PAGE_SIZE = 250;
const MAX_CALENDAR_AVAILABILITY_EVENTS = 1_000;
const MAX_CALENDAR_AVAILABILITY_PAGES = Math.ceil(
	MAX_CALENDAR_AVAILABILITY_EVENTS / CALENDAR_AVAILABILITY_PAGE_SIZE,
);
const MAX_CALENDAR_AVAILABILITY_SLOTS = 20;
const MAX_CALENDAR_AVAILABILITY_SPAN_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_CALENDAR_SLOT_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_CALENDAR_CONFLICTS_PER_SLOT = 20;
const GMAIL_MESSAGES_ENDPOINT =
	"https://gmail.googleapis.com/gmail/v1/users/me/messages";
const REQUIRED_SCOPES = [
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/calendar.events",
] as const;

function boundedCalendarResultCount(value: number): number {
	return Number.isFinite(value)
		? Math.max(1, Math.min(100, Math.trunc(value)))
		: 20;
}

interface CalendarAvailabilitySlot {
	label?: string;
	startsAt: string;
	endsAt: string;
}

interface NormalizedCalendarAvailabilitySlot extends CalendarAvailabilitySlot {
	startMs: number;
	endMs: number;
}

type CalendarBusyInterval =
	| {
			allDay: false;
			startMs: number;
			endMs: number;
	  }
	| {
			allDay: true;
			startDate: string;
			endDate: string;
	  };

function parseExplicitCalendarInstant(value: string, label: string): number {
	if (
		value.length > 100 ||
		!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
	)
		throw new Error(`${label} must be an ISO date-time with an explicit offset.`);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
	return parsed;
}

function normalizeAvailabilitySlots(
	slots: CalendarAvailabilitySlot[],
): NormalizedCalendarAvailabilitySlot[] {
	if (
		!Array.isArray(slots) ||
		slots.length < 1 ||
		slots.length > MAX_CALENDAR_AVAILABILITY_SLOTS
	)
		throw new Error(
			`Google Calendar availability requires 1 to ${MAX_CALENDAR_AVAILABILITY_SLOTS} candidate slots.`,
		);
	const normalized = slots.map((slot, index) => {
		if (!slot || typeof slot !== "object")
			throw new Error(`Calendar availability slot ${index + 1} is invalid.`);
		if (
			(slot.label !== undefined && typeof slot.label !== "string") ||
			typeof slot.startsAt !== "string" ||
			typeof slot.endsAt !== "string"
		)
			throw new Error(`Calendar availability slot ${index + 1} is invalid.`);
		const label = slot.label?.trim();
		if (label && label.length > 200)
			throw new Error(
				`Calendar availability slot ${index + 1} label is too long.`,
			);
		const startMs = parseExplicitCalendarInstant(
			slot.startsAt,
			`Calendar availability slot ${index + 1} start`,
		);
		const endMs = parseExplicitCalendarInstant(
			slot.endsAt,
			`Calendar availability slot ${index + 1} end`,
		);
		if (endMs <= startMs)
			throw new Error(
				`Calendar availability slot ${index + 1} must end after it starts.`,
			);
		if (endMs - startMs > MAX_CALENDAR_SLOT_DURATION_MS)
			throw new Error(
				`Calendar availability slot ${index + 1} cannot exceed 24 hours.`,
			);
		return {
			...(label ? { label } : {}),
			startsAt: new Date(startMs).toISOString(),
			endsAt: new Date(endMs).toISOString(),
			startMs,
			endMs,
		};
	});
	const timeMin = Math.min(...normalized.map((slot) => slot.startMs));
	const timeMax = Math.max(...normalized.map((slot) => slot.endMs));
	if (timeMax - timeMin > MAX_CALENDAR_AVAILABILITY_SPAN_MS)
		throw new Error(
			"Google Calendar availability candidates must fit within a 31-day window.",
		);
	return normalized;
}

function calendarTimeZone(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 200)
		throw new Error("Google Calendar returned an invalid time zone.");
	const timeZone = value;
	try {
		new Intl.DateTimeFormat("en", { timeZone }).format(0);
	} catch {
		throw new Error("Google Calendar returned an invalid time zone.");
	}
	return timeZone;
}

function calendarDateAt(
	instant: number,
	formatter: Intl.DateTimeFormat,
): string {
	const parts = formatter.formatToParts(instant);
	const values = new Map(parts.map((part) => [part.type, part.value]));
	return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
		return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return (
		Number.isFinite(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

function parseCalendarBusyInterval(raw: unknown): CalendarBusyInterval | undefined {
	if (!raw || typeof raw !== "object")
		throw new Error("Google Calendar returned an invalid event.");
	const event = raw as Record<string, unknown>;
	if (event.status === "cancelled" || event.transparency === "transparent")
		return undefined;
	const start =
		event.start && typeof event.start === "object"
			? (event.start as Record<string, unknown>)
			: {};
	const end =
		event.end && typeof event.end === "object"
			? (event.end as Record<string, unknown>)
			: {};
	if (typeof start.dateTime === "string" && typeof end.dateTime === "string") {
		const startMs = parseExplicitCalendarInstant(
			start.dateTime,
			"Google Calendar event start",
		);
		const endMs = parseExplicitCalendarInstant(
			end.dateTime,
			"Google Calendar event end",
		);
		if (endMs <= startMs)
			throw new Error("Google Calendar returned an invalid event interval.");
		return { allDay: false, startMs, endMs };
	}
	if (
		typeof start.date === "string" &&
		typeof end.date === "string" &&
		isCalendarDate(start.date) &&
		isCalendarDate(end.date) &&
		end.date > start.date
	)
		return { allDay: true, startDate: start.date, endDate: end.date };
	throw new Error("Google Calendar returned an invalid event interval.");
}

function slotOverlapsBusyInterval(
	slot: NormalizedCalendarAvailabilitySlot,
	interval: CalendarBusyInterval,
	slotStartDate: string,
	slotEndDate: string,
): boolean {
	if (!interval.allDay)
		return slot.startMs < interval.endMs && slot.endMs > interval.startMs;
	return (
		slotStartDate < interval.endDate && slotEndDate >= interval.startDate
	);
}

function visibleBusyInterval(interval: CalendarBusyInterval): Record<string, unknown> {
	return interval.allDay
		? {
				allDay: true,
				startDate: interval.startDate,
				endDate: interval.endDate,
			}
		: {
				allDay: false,
				startsAt: new Date(interval.startMs).toISOString(),
				endsAt: new Date(interval.endMs).toISOString(),
			};
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
	if (raw.length > 100_000)
		throw new Error("Google Workspace authorization record is too large.");
	let record: Partial<StoredGoogleWorkspaceAuthorization>;
	try {
		record = JSON.parse(raw) as Partial<StoredGoogleWorkspaceAuthorization>;
	} catch {
		throw new Error("Google Workspace authorization record is invalid.");
	}
	if (
		record.version !== 1 ||
		typeof record.clientId !== "string" ||
		typeof record.refreshToken !== "string" ||
		typeof record.email !== "string" ||
		!Array.isArray(record.scopes) ||
		typeof record.connectedAt !== "string"
	)
		throw new Error("Google Workspace authorization record is invalid.");
	if (
		!/^[0-9]+-[A-Za-z0-9_-]{20,200}\.apps\.googleusercontent\.com$/.test(
			record.clientId,
		) ||
		record.refreshToken.length < 20 ||
		record.refreshToken.length > 20_000
	)
		throw new Error("Google Workspace authorization record is invalid.");
	for (const scope of REQUIRED_SCOPES)
		if (!record.scopes.includes(scope))
			throw new Error(`Google Workspace authorization is missing ${scope}.`);
	return record as StoredGoogleWorkspaceAuthorization;
}

async function responseJson(
	response: Response,
	limit = 256_000,
): Promise<Record<string, unknown>> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > limit)
		throw new Error("Google Workspace response exceeds its size limit.");
	try {
		const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
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

	constructor(
		private readonly record: StoredGoogleWorkspaceAuthorization,
		private readonly fetcher: typeof fetch = fetch,
		private readonly now: () => Date = () => new Date(),
	) {
		this.email = record.email;
		this.gmailAdapter = new NativeChannelAdapter({
			id: "google-workspace-gmail",
			kind: "gmail",
			tokenProvider: () => this.token(),
			fetcher,
			now,
		});
	}

	get canReadMessages(): boolean {
		return this.record.scopes.includes(GMAIL_READONLY_SCOPE);
	}

	async searchLoginCodes(input: {
		after: string;
		domain: string;
		maxResults: number;
		signal: AbortSignal;
	}): Promise<CommunicationCodeMatch[]> {
		if (!this.canReadMessages) return [];
		const after = new Date(input.after);
		if (!Number.isFinite(after.getTime()))
			throw new Error("Google login-code search time is invalid.");
		const maxResults = Number.isFinite(input.maxResults)
			? Math.max(1, Math.min(10, Math.trunc(input.maxResults)))
			: 5;
		const query = [
			`after:${Math.floor(after.getTime() / 1_000)}`,
			`{verification security "one-time" passcode login "sign-in" code}`,
			gmailDomainQuery(input.domain),
		]
			.filter(Boolean)
			.join(" ");
		const listUrl = new URL(GMAIL_MESSAGES_ENDPOINT);
		listUrl.search = new URLSearchParams({
			q: query,
			maxResults: String(Math.min(20, maxResults * 2)),
			includeSpamTrash: "false",
		}).toString();
		const listed = await this.authorizedJson(listUrl, {
			signal: input.signal,
		});
		const messageIds = Array.isArray(listed.messages)
			? listed.messages.flatMap((value) => {
					if (!value || typeof value !== "object") return [];
					const id = (value as Record<string, unknown>).id;
					return typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id)
						? [id]
						: [];
				})
			: [];
		const matches: CommunicationCodeMatch[] = [];
		for (const id of messageIds.slice(0, 20)) {
			if (input.signal.aborted) throw input.signal.reason;
			const messageUrl = new URL(`${GMAIL_MESSAGES_ENDPOINT}/${id}`);
			messageUrl.search = new URLSearchParams({ format: "full" }).toString();
			const message = await this.authorizedJson(messageUrl, {
				signal: input.signal,
				responseLimit: 1_000_000,
			});
			const receivedAt = gmailReceivedAt(message, this.now());
			if (!receivedAt || receivedAt.getTime() < after.getTime()) continue;
			const headers = gmailHeaders(message);
			const subject = headers.subject;
			const sender = headers.from;
			const body = gmailText(message);
			const codes = extractLoginCodes(
				`${subject ?? ""}\n${sender ?? ""}\n${String(message.snippet ?? "")}\n${body}`,
			);
			for (const code of codes) {
				matches.push({
					sourceId: "gmail",
					sourceLabel: "Gmail",
					account: this.email,
					...(sender ? { sender } : {}),
					...(subject ? { subject } : {}),
					code,
					receivedAt: receivedAt.toISOString(),
				});
				if (matches.length >= maxResults) return matches;
			}
		}
		return matches;
	}

	async listEvents(input: {
		timeMin: string;
		timeMax?: string;
		maxResults: number;
		signal: AbortSignal;
	}): Promise<Record<string, unknown>> {
		const maxResults = boundedCalendarResultCount(input.maxResults);
		const url = new URL(CALENDAR_EVENTS_ENDPOINT);
		url.search = new URLSearchParams({
			timeMin: new Date(input.timeMin).toISOString(),
			...(input.timeMax
				? { timeMax: new Date(input.timeMax).toISOString() }
				: {}),
			maxResults: String(maxResults),
			singleEvents: "true",
			orderBy: "startTime",
		}).toString();
		const body = await this.authorizedJson(url, { signal: input.signal });
		const items = Array.isArray(body.items)
			? body.items.slice(0, maxResults).map((raw) => {
					const event =
						raw && typeof raw === "object"
							? (raw as Record<string, unknown>)
							: {};
					const start =
						event.start && typeof event.start === "object"
							? (event.start as Record<string, unknown>)
							: {};
					const end =
						event.end && typeof event.end === "object"
							? (event.end as Record<string, unknown>)
							: {};
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
								return [
									{
										...(email ? { email } : {}),
										...(name ? { name } : {}),
										...(typeof attendee.responseStatus === "string"
											? {
													responseStatus: attendee.responseStatus.slice(0, 100),
												}
											: {}),
										organizer: attendee.organizer === true,
									},
								];
							})
						: [];
					const conference =
						event.conferenceData && typeof event.conferenceData === "object"
							? (event.conferenceData as Record<string, unknown>)
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
						timeZone: String(start.timeZone ?? end.timeZone ?? "").slice(
							0,
							200,
						),
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
							: undefined,
					};
				})
			: [];
		return { calendar: "primary", items, trust: "untrusted_connector" };
	}

	async checkAvailability(input: {
		slots: CalendarAvailabilitySlot[];
		signal: AbortSignal;
	}): Promise<Record<string, unknown>> {
		const slots = normalizeAvailabilitySlots(input.slots);
		const timeMin = Math.min(...slots.map((slot) => slot.startMs));
		const timeMax = Math.max(...slots.map((slot) => slot.endMs));
		const { timeZone, intervals, eventsScanned } =
			await this.availabilityBusyIntervals({
				timeMin: new Date(timeMin).toISOString(),
				timeMax: new Date(timeMax).toISOString(),
				signal: input.signal,
			});
		const dateFormatter = new Intl.DateTimeFormat("en", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		return {
			calendar: "primary",
			calendarTimeZone: timeZone,
			trust: "untrusted_connector",
			verified: true,
			eventsScanned,
			busyIntervals: intervals.length,
			slots: slots.map((slot) => {
				const slotStartDate = calendarDateAt(slot.startMs, dateFormatter);
				const slotEndDate = calendarDateAt(slot.endMs - 1, dateFormatter);
				const conflicts = intervals.filter((interval) =>
					slotOverlapsBusyInterval(
						slot,
						interval,
						slotStartDate,
						slotEndDate,
					),
				);
				return {
					...(slot.label ? { label: slot.label } : {}),
					startsAt: slot.startsAt,
					endsAt: slot.endsAt,
					available: conflicts.length === 0,
					conflictCount: conflicts.length,
					conflicts: conflicts
						.slice(0, MAX_CALENDAR_CONFLICTS_PER_SLOT)
						.map(visibleBusyInterval),
					conflictsTruncated:
						conflicts.length > MAX_CALENDAR_CONFLICTS_PER_SLOT,
				};
			}),
		};
	}

	async createEvent(input: {
		operationId: string;
		title: string;
		startsAt: string;
		endsAt: string;
		description?: string;
		location?: string;
		signal: AbortSignal;
	}): Promise<Record<string, unknown>> {
		const startMs = parseExplicitCalendarInstant(
			input.startsAt,
			"Google Calendar event start",
		);
		const endMs = parseExplicitCalendarInstant(
			input.endsAt,
			"Google Calendar event end",
		);
		if (endMs <= startMs)
			throw new Error("Google Calendar events must end after they start.");
		const eventId = createHash("sha256")
			.update(`workstrand-google-calendar\0${input.operationId}`)
			.digest("hex")
			.slice(0, 32);
		const eventUrl = `${CALENDAR_EVENTS_ENDPOINT}/${eventId}`;
		const existing = await this.authorizedJson(new URL(eventUrl), {
			signal: input.signal,
			allowNotFound: true,
		});
		if (existing.id === eventId) return this.eventResult(existing, true);
		const created = await this.authorizedJson(
			new URL(CALENDAR_EVENTS_ENDPOINT),
			{
				method: "POST",
				signal: input.signal,
				body: {
					id: eventId,
					summary: input.title,
					start: { dateTime: new Date(startMs).toISOString() },
					end: { dateTime: new Date(endMs).toISOString() },
					...(input.description ? { description: input.description } : {}),
					...(input.location ? { location: input.location } : {}),
				},
			},
		);
		if (created.id !== eventId)
			throw new Error("Google Calendar returned an unexpected event ID.");
		const verified = await this.authorizedJson(new URL(eventUrl), {
			signal: input.signal,
		});
		if (verified.id !== eventId)
			throw new Error("Google Calendar event could not be read back.");
		return this.eventResult(verified, false);
	}

	private eventResult(
		event: Record<string, unknown>,
		repeated: boolean,
	): Record<string, unknown> {
		return {
			eventId: String(event.id ?? ""),
			htmlLink:
				typeof event.htmlLink === "string"
					? event.htmlLink.slice(0, 2_000)
					: undefined,
			status: String(event.status ?? ""),
			repeated,
			verified: true,
		};
	}

	private async availabilityBusyIntervals(input: {
		timeMin: string;
		timeMax: string;
		signal: AbortSignal;
	}): Promise<{
		timeZone: string;
		intervals: CalendarBusyInterval[];
		eventsScanned: number;
	}> {
		const intervals: CalendarBusyInterval[] = [];
		let eventsScanned = 0;
		let nextPageToken: string | undefined;
		let resolvedTimeZone: string | undefined;
		for (let page = 1; page <= MAX_CALENDAR_AVAILABILITY_PAGES; page += 1) {
			if (input.signal.aborted) throw input.signal.reason;
			const url = new URL(CALENDAR_EVENTS_ENDPOINT);
			url.search = new URLSearchParams({
				timeMin: input.timeMin,
				timeMax: input.timeMax,
				maxResults: String(CALENDAR_AVAILABILITY_PAGE_SIZE),
				singleEvents: "true",
				orderBy: "startTime",
				showDeleted: "false",
				fields:
					"items(status,transparency,start,end),nextPageToken,timeZone",
				...(nextPageToken ? { pageToken: nextPageToken } : {}),
			}).toString();
			const body = await this.authorizedJson(url, {
				signal: input.signal,
				responseLimit: 512_000,
			});
			if (body.timeZone !== undefined) {
				const pageTimeZone = calendarTimeZone(body.timeZone);
				if (resolvedTimeZone && pageTimeZone !== resolvedTimeZone)
					throw new Error(
						"Google Calendar changed time zones during availability verification.",
					);
				resolvedTimeZone = pageTimeZone;
			}
			if (body.items !== undefined && !Array.isArray(body.items))
				throw new Error("Google Calendar returned an invalid event list.");
			const items = Array.isArray(body.items) ? body.items : [];
			eventsScanned += items.length;
			if (eventsScanned > MAX_CALENDAR_AVAILABILITY_EVENTS)
				throw new Error(
					"Google Calendar availability is too dense to verify safely. Narrow the candidate time range.",
				);
			for (const item of items) {
				const interval = parseCalendarBusyInterval(item);
				if (interval) intervals.push(interval);
			}
			const rawNextPageToken = body.nextPageToken;
			if (rawNextPageToken === undefined) {
				nextPageToken = undefined;
				break;
			}
			if (
				typeof rawNextPageToken !== "string" ||
				rawNextPageToken.length < 1 ||
				rawNextPageToken.length > 2_000
			)
				throw new Error("Google Calendar returned an invalid page token.");
			nextPageToken = rawNextPageToken;
			if (page === MAX_CALENDAR_AVAILABILITY_PAGES)
				throw new Error(
					"Google Calendar availability is too dense to verify safely. Narrow the candidate time range.",
				);
		}
		if (!resolvedTimeZone)
			throw new Error(
				"Google Calendar did not return its time zone for availability verification.",
			);
		return {
			timeZone: resolvedTimeZone,
			intervals,
			eventsScanned,
		};
	}

	private async token(): Promise<string> {
		const now = this.now().getTime();
		if (this.accessToken && this.accessToken.expiresAt > now + 60_000)
			return this.accessToken.value;
		if (this.refreshInFlight) return this.refreshInFlight;
		this.refreshInFlight = this.refreshToken().finally(() => {
			this.refreshInFlight = undefined;
		});
		return this.refreshInFlight;
	}

	private async refreshToken(): Promise<string> {
		const response = await this.fetcher(TOKEN_ENDPOINT, {
			method: "POST",
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: this.record.clientId,
				refresh_token: this.record.refreshToken,
				grant_type: "refresh_token",
			}),
		});
		const body = await responseJson(response, 64_000);
		if (!response.ok)
			throw new Error(
				`Google Workspace token refresh failed (${String(body.error ?? response.status).slice(0, 200)}). Reconnect in Settings.`,
			);
		const value =
			typeof body.access_token === "string" ? body.access_token : "";
		const expiresIn = Number(body.expires_in);
		if (
			value.length < 20 ||
			value.length > 20_000 ||
			!Number.isFinite(expiresIn) ||
			expiresIn < 60 ||
			expiresIn > 86_400
		)
			throw new Error(
				"Google Workspace token refresh returned an invalid token.",
			);
		this.accessToken = {
			value,
			expiresAt: this.now().getTime() + expiresIn * 1_000,
		};
		return value;
	}

	private async authorizedJson(
		url: URL,
		input: {
			method?: "POST";
			body?: Record<string, unknown>;
			signal: AbortSignal;
			allowNotFound?: boolean;
			responseLimit?: number;
		},
	): Promise<Record<string, unknown>> {
		const response = await this.fetcher(url, {
			method: input.method ?? "GET",
			redirect: "error",
			signal: input.signal,
			headers: {
				accept: "application/json",
				authorization: `Bearer ${await this.token()}`,
				...(input.body ? { "content-type": "application/json" } : {}),
			},
			...(input.body ? { body: JSON.stringify(input.body) } : {}),
		});
		if (input.allowNotFound && response.status === 404) {
			await response.arrayBuffer();
			return {};
		}
		const body = await responseJson(response, input.responseLimit ?? 256_000);
		if (!response.ok)
			throw new Error(
				`Google Workspace request failed (${response.status}: ${String(body.error ?? response.statusText).slice(0, 500)}).`,
			);
		return body;
	}
}

function gmailHeaders(
	message: Record<string, unknown>,
): { from?: string; subject?: string } {
	const payload =
		message.payload && typeof message.payload === "object"
			? (message.payload as Record<string, unknown>)
			: {};
	const headers = Array.isArray(payload.headers) ? payload.headers : [];
	const values: { from?: string; subject?: string } = {};
	for (const raw of headers) {
		if (!raw || typeof raw !== "object") continue;
		const header = raw as Record<string, unknown>;
		const name = typeof header.name === "string" ? header.name.toLowerCase() : "";
		const value = typeof header.value === "string" ? header.value.trim() : "";
		if (!value) continue;
		if (name === "from") values.from = value.slice(0, 500);
		if (name === "subject") values.subject = value.slice(0, 500);
	}
	return values;
}

function gmailReceivedAt(
	message: Record<string, unknown>,
	now: Date,
): Date | undefined {
	const value = Number(message.internalDate);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const receivedAt = new Date(Math.min(value, now.getTime()));
	return Number.isFinite(receivedAt.getTime()) ? receivedAt : undefined;
}

function gmailText(message: Record<string, unknown>): string {
	const parts: string[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const body =
			record.body && typeof record.body === "object"
				? (record.body as Record<string, unknown>)
				: {};
		if (typeof body.data === "string" && body.data.length <= 400_000) {
			try {
				const decoded = Buffer.from(body.data, "base64url")
					.toString("utf8")
					.replace(/<[^>]+>/g, " ")
					.slice(0, 400_000);
				parts.push(decoded);
			} catch {
				// Ignore malformed MIME parts; the bounded Gmail snippet still gets scanned.
			}
		}
		if (Array.isArray(record.parts))
			for (const part of record.parts.slice(0, 50)) visit(part);
	};
	visit(message.payload);
	return parts.join("\n").slice(0, 500_000);
}

function gmailDomainQuery(domain: string): string {
	const normalized = domain.trim().toLowerCase();
	if (
		normalized.length > 253 ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
			normalized,
		)
	)
		return "";
	return `{from:${normalized} "${normalized}"}`;
}

export function environmentGoogleWorkspaceClient(
	environment: NodeJS.ProcessEnv = process.env,
	fetcher: typeof fetch = fetch,
	now: () => Date = () => new Date(),
): GoogleWorkspaceClient | undefined {
	const raw = environment.KESTREL_GOOGLE_WORKSPACE_OAUTH;
	return raw
		? new GoogleWorkspaceClient(parseRecord(raw), fetcher, now)
		: undefined;
}

export function installGoogleWorkspaceTools(
	runtime: AgentRuntime,
	client: GoogleWorkspaceClient,
	sessionId: string,
): void {
	runtime.registerExternalTool({
		descriptor: {
			name: "google.calendar.list-events",
			title: "List Google Calendar events",
			description:
				"Read a bounded time range from the connected primary Google Calendar.",
			category: "connector",
			riskLevel: "read_only",
			readOnly: true,
			requiresWorkspace: false,
			source: "connector",
			tags: ["google", "calendar", "events", "schedule"],
		},
		inputSchema: {
			type: "object",
			properties: {
				timeMin: { type: "string", format: "date-time" },
				timeMax: { type: "string", format: "date-time" },
				maxResults: { type: "integer", minimum: 1, maximum: 100, default: 20 },
			},
			required: ["timeMin"],
		},
		execute: ({ signal }, input) =>
			client.listEvents({
				timeMin: String(input.timeMin),
				...(input.timeMax ? { timeMax: String(input.timeMax) } : {}),
				maxResults: Number(input.maxResults ?? 20),
				signal,
			}),
	});
	runtime.registerExternalTool({
		descriptor: {
			name: "google.calendar.check-availability",
			title: "Check Google Calendar availability",
			description:
				"Verify up to 20 exact candidate time slots against the connected primary calendar. Returns only bounded busy intervals, never event titles, descriptions, attendees, or message content.",
			category: "connector",
			riskLevel: "read_only",
			readOnly: true,
			requiresWorkspace: false,
			source: "connector",
			tags: ["google", "calendar", "availability", "conflicts", "schedule"],
		},
		inputSchema: {
			type: "object",
			properties: {
				slots: {
					type: "array",
					minItems: 1,
					maxItems: MAX_CALENDAR_AVAILABILITY_SLOTS,
					items: {
						type: "object",
						properties: {
							label: { type: "string", maxLength: 200 },
							startsAt: { type: "string", format: "date-time" },
							endsAt: { type: "string", format: "date-time" },
						},
						required: ["startsAt", "endsAt"],
						additionalProperties: false,
					},
				},
			},
			required: ["slots"],
			additionalProperties: false,
		},
		execute: ({ signal }, input) =>
			client.checkAvailability({
				slots: input.slots as CalendarAvailabilitySlot[],
				signal,
			}),
	});
	runtime.registerExternalTool({
		descriptor: {
			name: "google.calendar.create-event",
			title: "Create Google Calendar event",
			description:
				"Create one deterministic event in the connected primary calendar and read it back after explicit approval.",
			category: "connector",
			riskLevel: "external",
			readOnly: false,
			requiresWorkspace: false,
			source: "connector",
			tags: ["google", "calendar", "event", "create"],
		},
		inputSchema: {
			type: "object",
			properties: {
				operationId: { type: "string", minLength: 8, maxLength: 200 },
				title: { type: "string", minLength: 1, maxLength: 2_000 },
				startsAt: { type: "string", format: "date-time" },
				endsAt: { type: "string", format: "date-time" },
				description: { type: "string", maxLength: 10_000 },
				location: { type: "string", maxLength: 2_000 },
			},
			required: ["operationId", "title", "startsAt", "endsAt"],
		},
		execute: ({ signal }, input) =>
			client.createEvent({
				operationId: String(input.operationId),
				title: String(input.title),
				startsAt: String(input.startsAt),
				endsAt: String(input.endsAt),
				...(input.description
					? { description: String(input.description) }
					: {}),
				...(input.location ? { location: String(input.location) } : {}),
				signal,
			}),
		verify: (_context, _input, output) => ({
			method: "google-calendar-read-back",
			evidence: {
				eventId: output.eventId,
				verified: output.verified,
				repeated: output.repeated,
			},
		}),
	});
	runtime.allowTool(sessionId, "google.calendar.list-events");
	runtime.allowTool(sessionId, "google.calendar.check-availability");
	runtime.allowTool(sessionId, "google.calendar.create-event");
}
