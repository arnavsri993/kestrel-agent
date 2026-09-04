import type {
	AgentContextBundle,
	CalendarProviderStatus,
	CoreResponse,
	MemoryRecord,
	MemoryTimelineQueryResult,
	PersonRecord,
	ProvenanceRecord,
	RendererRequest,
	TimelineEvent,
	TranscriptSearchResult,
	UnifiedCalendarEvent,
	UserModelFact,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { DreamingPanel } from "./DreamingPanel";
import { Icon } from "./Icon";
import { MemoryRecallStatus } from "./MemoryRecallStatus";

type LifeView = "calendar" | "timeline" | "people" | "memory";

const dayFormatter = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

function startOfWeek(value: Date): Date {
	const date = new Date(value);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return date;
}

function addDays(value: Date, days: number): Date {
	const date = new Date(value);
	date.setDate(date.getDate() + days);
	return date;
}

function localDateTimeValue(value: Date): string {
	const offset = value.getTimezoneOffset() * 60_000;
	return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function initialEventTime(offsetHours: number): string {
	const date = new Date();
	date.setMinutes(0, 0, 0);
	date.setHours(date.getHours() + offsetHours);
	return localDateTimeValue(date);
}

function sameLocalDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

interface CalendarOccurrence {
	key: string;
	event: UnifiedCalendarEvent;
	startsAt: Date;
	endsAt: Date;
}

function occurrences(
	event: UnifiedCalendarEvent,
	weekStart: Date,
): CalendarOccurrence[] {
	const rangeEnd = addDays(weekStart, 7);
	if (!event.recurrenceDays?.length) {
		const startsAt = new Date(event.startsAt);
		const endsAt = new Date(event.endsAt);
		if (endsAt <= weekStart || startsAt >= rangeEnd) return [];
		return [{ key: event.id, event, startsAt, endsAt }];
	}
	const originalStart = new Date(event.startsAt);
	const originalEnd = new Date(event.endsAt);
	const duration = originalEnd.getTime() - originalStart.getTime();
	return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
		.filter((day) => event.recurrenceDays!.includes(day.getDay()))
		.map((day) => {
			const startsAt = new Date(day);
			startsAt.setHours(
				originalStart.getHours(),
				originalStart.getMinutes(),
				0,
				0,
			);
			return {
				key: `${event.id}:${startsAt.toISOString()}`,
				event,
				startsAt,
				endsAt: new Date(startsAt.getTime() + duration),
			};
		});
}

function originLabel(event: UnifiedCalendarEvent): string {
	if (event.origin === "provider")
		return `${event.providerId === "google" ? "Google" : event.providerId} · confirmed`;
	if (event.origin === "explicit") return "Kestrel · explicit";
	if (event.origin === "inferred")
		return `Inferred · ${Math.round(event.confidence * 100)}%`;
	return `Suggested · ${Math.round(event.confidence * 100)}%`;
}

function formatDisplayLabel(value: string): string {
	return value
		.replaceAll("_", " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function memoryState(memory: MemoryRecord): string {
	return formatDisplayLabel(
		memory.confirmationStatus ??
			(memory.userConfirmed
				? "confirmed"
				: memory.inferred
					? "inferred"
					: "suggested"),
	);
}

async function request(
	input: RendererRequest,
): Promise<Extract<CoreResponse, { ok: true }>> {
	const response = (await window.kestrel.request(input)) as CoreResponse;
	if (!response.ok) throw new Error(response.error);
	return response;
}

function CalendarView() {
	const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
	const [events, setEvents] = useState<UnifiedCalendarEvent[]>([]);
	const [providers, setProviders] = useState<CalendarProviderStatus[]>([]);
	const [selected, setSelected] = useState<CalendarOccurrence | null>(null);
	const [title, setTitle] = useState("");
	const [startsAt, setStartsAt] = useState(() => initialEventTime(1));
	const [endsAt, setEndsAt] = useState(() => initialEventTime(2));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const days = useMemo(
		() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
		[weekStart],
	);
	const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);
	const expanded = useMemo(
		() =>
			events
				.flatMap((event) => occurrences(event, weekStart))
				.sort(
					(left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
				),
		[events, weekStart],
	);
	const google = providers.find((provider) => provider.id === "google");

	async function load() {
		setBusy(true);
		setError("");
		try {
			const response = await request({
				type: "calendar-list",
				startsAt: weekStart.toISOString(),
				endsAt: weekEnd.toISOString(),
			});
			setEvents(response.calendarEvents ?? []);
			setProviders(response.calendarProviders ?? []);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not load the calendar.",
			);
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		void load();
	}, [weekStart.getTime()]);

	async function syncGoogle() {
		setBusy(true);
		setError("");
		try {
			await request({
				type: "calendar-sync",
				startsAt: weekStart.toISOString(),
				endsAt: weekEnd.toISOString(),
			});
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Google Calendar sync failed.",
			);
			setBusy(false);
		}
	}

	async function createEvent(event: FormEvent) {
		event.preventDefault();
		if (!title.trim()) return;
		setBusy(true);
		setError("");
		try {
			await request({
				type: "calendar-create-local",
				title: title.trim(),
				startsAt: new Date(startsAt).toISOString(),
				endsAt: new Date(endsAt).toISOString(),
				origin: "explicit",
				confidence: 1,
				sourceId: "desktop-user",
			});
			setTitle("");
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not create the event.",
			);
			setBusy(false);
		}
	}

	async function removeSelected() {
		if (!selected) return;
		setBusy(true);
		setError("");
		try {
			await request({
				type: "calendar-delete-local",
				id: selected.event.id,
			});
			setSelected(null);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not remove the event.",
			);
			setBusy(false);
		}
	}

	return (
		<div className="life-calendar">
			<section className="calendar-toolbar" aria-label="Calendar controls">
				<div>
					<button
						className="icon-button"
						aria-label="Previous week"
						onClick={() => setWeekStart(addDays(weekStart, -7))}
					>
						<Icon name="chevron" className="chevron-back" />
					</button>
					<button
						className="button secondary"
						onClick={() => setWeekStart(startOfWeek(new Date()))}
					>
						Today
					</button>
					<button
						className="icon-button"
						aria-label="Next week"
						onClick={() => setWeekStart(addDays(weekStart, 7))}
					>
						<Icon name="chevron" />
					</button>
					<strong>
						{dayFormatter.format(weekStart)} –{" "}
						{dayFormatter.format(addDays(weekEnd, -1))}
					</strong>
				</div>
				<button
					className="button secondary"
					disabled={busy || google?.state !== "connected"}
					onClick={() => void syncGoogle()}
					title={
						google?.state === "connected"
							? "Refresh this week from Google Calendar"
							: "Connect Google Workspace in Settings first"
					}
				>
					{busy ? "Updating…" : "Sync Google"}
				</button>
			</section>

			<div className="calendar-provider-strip" aria-label="Calendar sources">
				{providers.map((provider) => (
					<span key={provider.id} data-state={provider.state}>
						<i aria-hidden="true" />
						<strong>{provider.label}</strong>
						<small>{provider.state}</small>
					</span>
				))}
			</div>

			<section className="calendar-legend" aria-label="Calendar event legend">
				<span data-origin="provider">Solid edge · connected calendar</span>
				<span data-origin="explicit">Bright edge · explicit</span>
				<span data-origin="inferred">Dashed edge · inferred with confidence</span>
				<span data-origin="suggested">Dotted edge · awaiting approval</span>
			</section>

			<div className="calendar-layout">
				<section
					className="calendar-week"
					aria-label={`Week of ${dayFormatter.format(weekStart)}`}
					aria-busy={busy}
				>
					{days.map((day) => {
						const items = expanded.filter((item) =>
							sameLocalDay(item.startsAt, day),
						);
						return (
							<section className="calendar-day" key={day.toISOString()}>
								<header data-today={sameLocalDay(day, new Date()) || undefined}>
									<span>
										{day.toLocaleDateString(undefined, { weekday: "short" })}
									</span>
									<strong>{day.getDate()}</strong>
								</header>
								<div>
									{items.map((item) => (
										<button
											key={item.key}
											className="calendar-event"
											data-origin={item.event.origin}
											aria-pressed={selected?.key === item.key}
											onClick={() => setSelected(item)}
										>
											<time dateTime={item.startsAt.toISOString()}>
												{item.event.allDay
													? "All day"
													: timeFormatter.format(item.startsAt)}
											</time>
											<strong>{item.event.title}</strong>
											<small>{originLabel(item.event)}</small>
										</button>
									))}
									{items.length === 0 && (
										<span className="calendar-open">Open</span>
									)}
								</div>
							</section>
						);
					})}
				</section>

				<aside className="calendar-detail" aria-live="polite">
					{selected ? (
						<>
							<span className="origin-line" data-origin={selected.event.origin}>
								{originLabel(selected.event)}
							</span>
							<h2>{selected.event.title}</h2>
							<p>
								{dateTimeFormatter.format(selected.startsAt)} –{" "}
								{timeFormatter.format(selected.endsAt)}
							</p>
							{selected.event.location && <p>{selected.event.location}</p>}
							{selected.event.description && (
								<p>{selected.event.description}</p>
							)}
							{selected.event.meetingUrl && (
								<a
									className="quiet-link"
									href={selected.event.meetingUrl}
									target="_blank"
									rel="noreferrer"
								>
									Open meeting link
								</a>
							)}
							<details>
								<summary>Why this is here</summary>
								<p>
									{selected.event.confidenceReason ??
										"This event keeps its original source and confidence."}
								</p>
								<small>{selected.event.sourceIds.join(" · ")}</small>
							</details>
							{(selected.event.providerId === "local" ||
								selected.event.providerId === "agent") && (
								<button
									className="button danger"
									disabled={busy}
									onClick={() => void removeSelected()}
								>
									Remove local block
								</button>
							)}
							{selected.event.origin === "provider" && (
								<small className="permission-note">
									External changes use Kestrel’s approval boundary. This view
									never edits the provider silently.
								</small>
							)}
						</>
					) : (
						<>
							<h2>Choose a time block</h2>
							<p>
								Inspect its source, confidence, people, location, and permission
								boundary.
							</p>
						</>
					)}
				</aside>
			</div>

			{expanded.length === 0 && !busy && (
				<section className="life-empty">
					<Icon name="today" />
					<div>
						<h2>No time is mapped this week</h2>
						<p>
							Add a confirmed block below, connect Google Calendar, or tell
							Kestrel a recurring routine in chat.
						</p>
					</div>
				</section>
			)}

			<details className="life-create" open={expanded.length === 0}>
				<summary>Add a confirmed time block</summary>
				<form onSubmit={(event) => void createEvent(event)}>
					<label>
						What
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Project work"
						/>
					</label>
					<label>
						Starts
						<input
							type="datetime-local"
							value={startsAt}
							onChange={(event) => setStartsAt(event.target.value)}
						/>
					</label>
					<label>
						Ends
						<input
							type="datetime-local"
							value={endsAt}
							onChange={(event) => setEndsAt(event.target.value)}
						/>
					</label>
					<button
						className="button primary"
						disabled={busy || !title.trim() || !startsAt || !endsAt}
					>
						Add to Kestrel
					</button>
				</form>
				<small>
					This creates an explicit local block. It does not write to a connected
					calendar.
				</small>
			</details>
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

type TimelineSelection =
	| { kind: "activity_block"; id: string }
	| { kind: "timeline_event"; id: string };

function localDateInputValue(value: Date): string {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function dateFromLocalInput(value: string): Date | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
	const date = new Date(`${value}T12:00:00`);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

function dayRange(value: Date): { startAt: string; endAt: string } {
	const start = new Date(value);
	start.setHours(0, 0, 0, 0);
	const end = addDays(start, 1);
	return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function timelineTimeLabel(startedAt: string, endedAt?: string): string {
	const start = new Date(startedAt);
	if (!endedAt) return timeFormatter.format(start);
	return `${timeFormatter.format(start)} – ${timeFormatter.format(new Date(endedAt))}`;
}

function uniqueIds(values: readonly string[]): string[] {
	return [...new Set(values)].filter(Boolean);
}

function emptyTimelineResult(): MemoryTimelineQueryResult {
	return {
		results: [],
		events: [],
		sessions: [],
		activityBlocks: [],
		dailySummaries: [],
		hasMore: false,
	};
}

function TimelineView() {
	const [day, setDay] = useState(() => {
		const today = new Date();
		today.setHours(12, 0, 0, 0);
		return today;
	});
	const [query, setQuery] = useState("");
	const [appliedQuery, setAppliedQuery] = useState("");
	const [timeline, setTimeline] = useState<MemoryTimelineQueryResult>(() =>
		emptyTimelineResult(),
	);
	const [selection, setSelection] = useState<TimelineSelection | null>(null);
	const [provenance, setProvenance] = useState<ProvenanceRecord[]>([]);
	const [busy, setBusy] = useState(false);
	const [provenanceBusy, setProvenanceBusy] = useState(false);
	const [error, setError] = useState("");
	const range = useMemo(() => dayRange(day), [day]);
	const eventsById = useMemo(
		() => new Map(timeline.events.map((event) => [event.id, event] as const)),
		[timeline.events],
	);
	const blocks = useMemo(
		() =>
			[...timeline.activityBlocks].sort(
				(left, right) =>
					new Date(left.startedAt).getTime() -
						new Date(right.startedAt).getTime(),
			),
		[timeline.activityBlocks],
	);
	const groupedEventIds = useMemo(
		() => new Set(blocks.flatMap((block) => block.eventIds)),
		[blocks],
	);
	const standaloneEvents = useMemo(
		() =>
			timeline.events
				.filter((event) => !groupedEventIds.has(event.id))
				.sort(
					(left, right) =>
						new Date(left.startedAt).getTime() -
							new Date(right.startedAt).getTime(),
				),
		[timeline.events, groupedEventIds],
	);
	const selectedBlock =
		selection?.kind === "activity_block"
			? timeline.activityBlocks.find((block) => block.id === selection.id)
			: undefined;
	const selectedEvent =
		selection?.kind === "timeline_event"
			? eventsById.get(selection.id)
			: undefined;
	const detailEvents = useMemo(() => {
		if (selectedEvent) return [selectedEvent];
		if (!selectedBlock) return [];
		return selectedBlock.eventIds
			.flatMap((id) => {
				const event = eventsById.get(id);
				return event ? [event] : [];
			})
			.sort(
				(left, right) =>
					new Date(left.startedAt).getTime() -
						new Date(right.startedAt).getTime(),
			);
	}, [eventsById, selectedBlock, selectedEvent]);
const detailRelatedIds = useMemo(
		() =>
			uniqueIds(
				(selectedBlock
					? [
							...selectedBlock.projectIds,
							...selectedBlock.personIds,
							...selectedBlock.entityIds,
						]
					: detailEvents.flatMap((event) => [
							...event.projectIds,
							...event.personIds,
							...event.entityIds,
						])) ?? [],
			),
		[selectedBlock, detailEvents],
	);
	const summary = timeline.dailySummaries.find(
		(item) => item.day === localDateInputValue(day),
	);

	async function loadTimeline(search = appliedQuery) {
		setBusy(true);
		setError("");
		try {
			const response = await request({
				type: "memory-timeline-query",
				query: search,
				startAt: range.startAt,
				endAt: range.endAt,
				personIds: [],
				projectIds: [],
				entityIds: [],
				horizons: [],
				eventTypes: [],
				includeTimeline: true,
				includeMemories: false,
				includeEntities: false,
				includeAgents: false,
				includeTasks: false,
				includeSensitive: false,
				includeRestricted: false,
				limit: 100,
				sort: "chronological",
			});
			const next = response.memoryTimeline ?? emptyTimelineResult();
			setTimeline(next);
			setSelection((current) => {
				if (
					current?.kind === "activity_block" &&
					next.activityBlocks.some((block) => block.id === current.id)
				)
					return current;
				if (
					current?.kind === "timeline_event" &&
					next.events.some((event) => event.id === current.id)
				)
					return current;
				const firstBlock = next.activityBlocks[0];
				if (firstBlock) return { kind: "activity_block", id: firstBlock.id };
				const firstEvent = next.events[0];
				return firstEvent
					? { kind: "timeline_event", id: firstEvent.id }
					: null;
			});
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not load the timeline.",
			);
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		void loadTimeline();
	}, [day.getTime(), appliedQuery]);

	useEffect(() => {
		const owner = selectedBlock
			? { ownerType: "activity_block" as const, ownerId: selectedBlock.id }
			: selectedEvent
				? { ownerType: "timeline_event" as const, ownerId: selectedEvent.id }
				: undefined;
		if (!owner) {
			setProvenance([]);
			return;
		}
		let current = true;
		setProvenanceBusy(true);
		void request({
			type: "memory-provenance-list",
			ownerType: owner.ownerType,
			ownerId: owner.ownerId,
			limit: 50,
		})
			.then((response) => {
				if (current) setProvenance(response.memoryProvenance ?? []);
			})
			.catch((cause) => {
				if (current)
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load activity provenance.",
					);
			})
			.finally(() => {
				if (current) setProvenanceBusy(false);
			});
		return () => {
			current = false;
		};
	}, [selectedBlock, selectedEvent]);

	function selectEvent(event: TimelineEvent) {
		setSelection({ kind: "timeline_event", id: event.id });
	}

	function renderEvent(event: TimelineEvent) {
		return (
			<button
				key={event.id}
				className={`timeline-event${selectedEvent?.id === event.id ? " active" : ""}`}
				aria-pressed={selectedEvent?.id === event.id}
				onClick={() => selectEvent(event)}
			>
				<time dateTime={event.startedAt}>
					{timelineTimeLabel(event.startedAt, event.endedAt)}
				</time>
				<span className="timeline-event-type">
					{formatDisplayLabel(event.eventType)}
				</span>
				<strong>{event.textSummary}</strong>
				<small>
					{event.source} · {event.actor}
				</small>
			</button>
		);
	}

	return (
		<div className="life-timeline">
			<section className="timeline-toolbar" aria-label="Timeline controls">
				<div className="timeline-day-controls">
					<button
						className="icon-button"
						aria-label="Previous day"
						onClick={() => setDay((current) => addDays(current, -1))}
					>
						<Icon name="chevron" className="chevron-back" />
					</button>
					<button
						className="button secondary"
						onClick={() => {
							const today = new Date();
							today.setHours(12, 0, 0, 0);
							setDay(today);
						}}
					>
						Today
					</button>
					<button
						className="icon-button"
						aria-label="Next day"
						onClick={() => setDay((current) => addDays(current, 1))}
					>
						<Icon name="chevron" />
					</button>
					<strong>{dayFormatter.format(day)}</strong>
				</div>
				<label className="timeline-date-picker">
					<span className="sr-only">Jump to a day</span>
					<input
						type="date"
						value={localDateInputValue(day)}
						onChange={(event) => {
							const next = dateFromLocalInput(event.target.value);
							if (next) setDay(next);
						}}
					/>
				</label>
			</section>

			<form
				className="timeline-searchbar"
				onSubmit={(event) => {
					event.preventDefault();
					const next = query.trim();
					setAppliedQuery(next);
					if (next === appliedQuery) void loadTimeline(next);
				}}
			>
				<label>
					<span className="sr-only">Search timeline</span>
					<Icon name="search" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search this day’s activity"
					/>
				</label>
				<button
					className="button secondary"
					disabled={busy && !timeline.events.length}
				>
					{busy ? "Loading…" : "Search timeline"}
				</button>
				{appliedQuery && (
					<button
						type="button"
						className="quiet-link"
						onClick={() => {
							setQuery("");
							setAppliedQuery("");
						}}
					>
						Clear search
					</button>
				)}
			</form>

			<section className="timeline-overview" aria-live="polite">
				<div>
					<span className="eyebrow">Personal timeline</span>
					<h2>{summary?.title ?? "A day in motion"}</h2>
					<p>
						{summary?.summary ??
							"Kestrel keeps meaningful activity in chronological blocks, with the original evidence available when you inspect a moment."}
					</p>
				</div>
				<dl>
					<div>
						<dt>Sessions</dt>
						<dd>{timeline.sessions.length}</dd>
					</div>
					<div>
						<dt>Blocks</dt>
						<dd>{blocks.length}</dd>
					</div>
					<div>
						<dt>Events</dt>
						<dd>{timeline.events.length}</dd>
					</div>
				</dl>
			</section>

			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}

			<div className="timeline-layout">
				<section className="timeline-stream" aria-busy={busy}>
					{blocks.map((block) => {
						const blockEvents = block.eventIds.flatMap((id) => {
							const event = eventsById.get(id);
							return event ? [event] : [];
						});
						return (
							<article
								className={`timeline-block${selectedBlock?.id === block.id ? " active" : ""}`}
								key={block.id}
							>
								<header>
									<button
										className="timeline-block-select"
										aria-pressed={selectedBlock?.id === block.id}
										onClick={() =>
											setSelection({ kind: "activity_block", id: block.id })
										}
									>
										<time dateTime={block.startedAt}>
											{timelineTimeLabel(block.startedAt, block.endedAt)}
										</time>
										<strong>{block.title}</strong>
									</button>
									<span>{Math.round(block.confidence * 100)}% context</span>
								</header>
								<p>{block.summary}</p>
								<div className="timeline-event-list">
									{blockEvents.map(renderEvent)}
									{blockEvents.length === 0 && (
										<small className="timeline-missing-evidence">
											The block is retained, but its event evidence is not in this page.
										</small>
									)}
								</div>
							</article>
						);
					})}
					{standaloneEvents.map((event) => (
						<article className="timeline-block timeline-standalone" key={event.id}>
							<header>
								<div>
									<time dateTime={event.startedAt}>
										{timelineTimeLabel(event.startedAt, event.endedAt)}
									</time>
									<strong>{formatDisplayLabel(event.eventType)}</strong>
								</div>
								<span>{event.source}</span>
							</header>
							<div className="timeline-event-list">{renderEvent(event)}</div>
						</article>
					))}
					{!blocks.length && !standaloneEvents.length && !busy && (
						<section className="life-empty timeline-empty">
							<Icon name="activity" />
							<div>
								<h2>
									{appliedQuery ? "No activity matches" : "Nothing captured this day"}
								</h2>
								<p>
									{appliedQuery
										? "Try a broader phrase or clear the search to see the full day."
										: "Meaningful Kestrel activity will appear here when capture is enabled. Private and incognito sessions stay out of the timeline."}
								</p>
							</div>
						</section>
					)}
					{timeline.hasMore && (
						<small className="timeline-more-note">
							This day has more activity than the first 100 results. Narrow the search
							to inspect a specific thread.
						</small>
					)}
				</section>

				<aside className="timeline-detail" aria-live="polite">
					{selectedBlock || selectedEvent ? (
						<>
							<span className="eyebrow">
								{selectedBlock ? "Activity block" : "Timeline event"}
							</span>
							<h2>
								{selectedBlock?.title ??
									(selectedEvent ? formatDisplayLabel(selectedEvent.eventType) : "Activity")}
							</h2>
							<p>
								{selectedBlock
									? `${dateTimeFormatter.format(new Date(selectedBlock.startedAt))} · ${selectedBlock.confidence * 100 >= 0 ? `${Math.round(selectedBlock.confidence * 100)}% confidence` : ""}`
									: selectedEvent
										? dateTimeFormatter.format(new Date(selectedEvent.startedAt))
										: ""}
							</p>
							{selectedBlock && <p>{selectedBlock.summary}</p>}
							{selectedEvent && <p>{selectedEvent.textSummary}</p>}
							{detailEvents.length > 1 && (
								<section className="timeline-detail-events">
									<h3>Evidence in this block</h3>
									{detailEvents.map((event) => (
										<button
											key={event.id}
											className="timeline-detail-event"
											onClick={() => selectEvent(event)}
										>
											<time dateTime={event.startedAt}>
												{timelineTimeLabel(event.startedAt, event.endedAt)}
											</time>
											<span>{event.textSummary}</span>
										</button>
									))}
								</section>
							)}
							{detailRelatedIds.length > 0 && (
								<section className="timeline-detail-section">
									<h3>Related IDs</h3>
									<div className="timeline-chip-list">
										{detailRelatedIds.map((id) => (
											<code key={id}>{id}</code>
										))}
									</div>
								</section>
							)}
							{detailEvents.some((event) => event.url || event.filePath) && (
								<section className="timeline-detail-section">
									<h3>Pages and files</h3>
									{detailEvents.map((event) => (
										<div className="timeline-reference-list" key={event.id}>
											{event.url && /^https?:\/\//iu.test(event.url) && (
												<a href={event.url} target="_blank" rel="noreferrer">
													{event.url}
												</a>
											)}
											{event.filePath && <code>{event.filePath}</code>}
										</div>
									))}
								</section>
							)}
							<section className="timeline-detail-section">
								<h3>Provenance</h3>
								{provenanceBusy ? (
									<small className="timeline-muted">Loading source details…</small>
								) : provenance.length ? (
									<div className="timeline-provenance-list">
										{provenance.map((item) => (
											<article key={item.id}>
												<strong>{item.sourceType}</strong>
												<span>{item.sourceId}</span>
												<small>
													{item.actor} · {item.extractionMethod} · {Math.round(item.confidence * 100)}%
												</small>
												{item.excerpt && <p>{item.excerpt}</p>}
											</article>
										))}
									</div>
								) : (
									<small className="timeline-muted">
										No additional provenance was recorded for this activity.
									</small>
								)}
							</section>
						</>
					) : (
						<div className="timeline-detail-empty">
							<Icon name="activity" />
							<h2>Inspect a moment</h2>
							<p>Select a block or event to see the source, related work, pages, and files behind it.</p>
						</div>
					)}
				</aside>
			</div>
		</div>
	);
}

function PeopleView() {
	const [people, setPeople] = useState<PersonRecord[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [relationship, setRelationship] = useState("");
	const [organization, setOrganization] = useState("");
	const [email, setEmail] = useState("");
	const [tone, setTone] = useState("");
	const [formality, setFormality] = useState<
		"casual" | "neutral" | "professional" | "formal"
	>("professional");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const selected = people.find((person) => person.id === selectedId);

	async function load() {
		setBusy(true);
		setError("");
		try {
			const response = await request({ type: "people-list" });
			setPeople(response.people ?? []);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not load people.",
			);
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		void load();
	}, []);

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		setBusy(true);
		setError("");
		try {
			const response = await request({
				type: "people-upsert",
				displayName: name.trim(),
				nicknames: [],
				...(relationship.trim() ? { relationship: relationship.trim() } : {}),
				...(organization.trim() ? { organization: organization.trim() } : {}),
				...(email.trim() ? { email: email.trim() } : {}),
				...(tone.trim() ? { tone: tone.trim() } : {}),
				formality,
				sourceId: "desktop-user",
				sensitivity: "personal",
			});
			setName("");
			setRelationship("");
			setOrganization("");
			setEmail("");
			setTone("");
			setSelectedId(response.people?.[0]?.id ?? null);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save person.",
			);
			setBusy(false);
		}
	}

	async function removePerson(id: string) {
		setBusy(true);
		setError("");
		try {
			await request({ type: "people-delete", id });
			setSelectedId(null);
			setDeleteConfirmId(null);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not delete this person.",
			);
			setBusy(false);
		}
	}

	return (
		<div className="people-layout">
			<section className="people-directory" aria-busy={busy}>
				<header>
					<div>
						<h2>People</h2>
					</div>
					<strong>{people.length}</strong>
				</header>
				{people.map((person) => (
					<button
						key={person.id}
						className={selectedId === person.id ? "active" : ""}
						aria-pressed={selectedId === person.id}
						onClick={() => {
							setSelectedId(person.id);
							setDeleteConfirmId(null);
						}}
					>
						<span aria-hidden="true">
							{person.displayName
								.split(/\s+/)
								.slice(0, 2)
								.map((part) => part[0])
								.join("")
								.toUpperCase()}
						</span>
						<div>
							<strong>{person.displayName}</strong>
							<small>
								{person.relationship ??
									person.organization ??
									"Relationship not set"}
							</small>
						</div>
					</button>
				))}
				{people.length === 0 && !busy && (
					<div className="people-empty">
						<p>No people are stored yet.</p>
						<small>
							Add someone below and their context stays on this Mac.
						</small>
					</div>
				)}
			</section>

			<section className="person-detail">
				{selected ? (
					<>
						<header>
							<span>
								{selected.displayName
									.split(/\s+/)
									.slice(0, 2)
									.map((part) => part[0])
									.join("")
									.toUpperCase()}
							</span>
							<div>
								<h2>{selected.displayName}</h2>
								<p>
									{selected.relationship ??
										selected.organization ??
										"Relationship not set"}
								</p>
							</div>
						</header>
						<dl>
							{selected.organization && (
								<>
									<dt>Organization</dt>
									<dd>{selected.organization}</dd>
								</>
							)}
							{selected.role && (
								<>
									<dt>Role</dt>
									<dd>{selected.role}</dd>
								</>
							)}
							{selected.communicationStyle.formality && (
								<>
									<dt>Formality</dt>
									<dd>{selected.communicationStyle.formality}</dd>
								</>
							)}
							{selected.communicationStyle.tone && (
								<>
									<dt>Your usual tone</dt>
									<dd>{selected.communicationStyle.tone}</dd>
								</>
							)}
						</dl>
						<section className="person-facts">
							<h3>Facts</h3>
							{selected.facts
								.filter((fact) => fact.status === "active")
								.map((fact) => (
									<article key={fact.id}>
										<div>
											<strong>{fact.key}</strong>
											<p>{fact.value}</p>
										</div>
										<small>
											{fact.userConfirmed ? "Confirmed" : "Inferred"} ·{" "}
											{Math.round(fact.confidence * 100)}% · {fact.sourceType}
										</small>
									</article>
								))}
						</section>
						{deleteConfirmId === selected.id ? (
							<div className="destructive-confirmation" role="alert">
								<p>
									Delete this person and every memory directly attached to them?
									Unrelated memories remain.
								</p>
								<div>
									<button
										className="button danger"
										disabled={busy}
										onClick={() => void removePerson(selected.id)}
									>
										Delete person and related facts
									</button>
									<button
										className="button secondary"
										onClick={() => setDeleteConfirmId(null)}
									>
										Cancel
									</button>
								</div>
							</div>
						) : (
							<button
								className="quiet-link danger-link"
								onClick={() => setDeleteConfirmId(selected.id)}
							>
								Delete everything about this person
							</button>
						)}
					</>
				) : (
					<div className="person-detail-empty">
						<h2>Select a person</h2>
						<p>
							Kestrel uses confirmed relationship and tone context when drafting
							communication.
						</p>
					</div>
				)}
			</section>

			<details className="life-create person-create" open={people.length === 0}>
				<summary>Add a person</summary>
				<form onSubmit={(event) => void save(event)}>
					<label>
						Name
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label>
						Relationship
						<input
							value={relationship}
							onChange={(event) => setRelationship(event.target.value)}
							placeholder="Professor, friend, sponsor…"
						/>
					</label>
					<label>
						Organization
						<input
							value={organization}
							onChange={(event) => setOrganization(event.target.value)}
						/>
					</label>
					<label>
						Email
						<input
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</label>
					<label>
						Formality
						<select
							value={formality}
							onChange={(event) =>
								setFormality(event.target.value as typeof formality)
							}
						>
							<option value="casual">Casual</option>
							<option value="neutral">Neutral</option>
							<option value="professional">Professional</option>
							<option value="formal">Formal</option>
						</select>
					</label>
					<label className="wide">
						Your usual tone
						<input
							value={tone}
							onChange={(event) => setTone(event.target.value)}
							placeholder="Brief, respectful, and prepared"
						/>
					</label>
					<button className="button primary" disabled={busy || !name.trim()}>
						Save person
					</button>
				</form>
			</details>
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function MemoryView({
	snapshot,
	update,
	onOpenTranscriptResult,
}: {
	snapshot: WorkspaceSnapshot;
	update(next: WorkspaceSnapshot): void;
	onOpenTranscriptResult?(result: TranscriptSearchResult): void;
}) {
	const [query, setQuery] = useState("");
	const [layer, setLayer] = useState<
		"all" | NonNullable<MemoryRecord["layer"]>
	>("all");
	const [selectedId, setSelectedId] = useState<string | null>(
		snapshot.memories[0]?.id ?? null,
	);
	const [draft, setDraft] = useState("");
	const [newContent, setNewContent] = useState("");
	const [newType, setNewType] = useState<MemoryRecord["type"]>("semantic");
	const [newLayer, setNewLayer] =
		useState<NonNullable<MemoryRecord["layer"]>>("mid_term");
	const [facts, setFacts] = useState<UserModelFact[]>([]);
	const [contextQuery, setContextQuery] = useState("");
	const [context, setContext] = useState<AgentContextBundle | null>(null);
	const [transcriptQuery, setTranscriptQuery] = useState("");
	const [transcriptResults, setTranscriptResults] = useState<
		TranscriptSearchResult[]
	>([]);
	const [transcriptBusy, setTranscriptBusy] = useState(false);
	const [transcriptError, setTranscriptError] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const selected = snapshot.memories.find((memory) => memory.id === selectedId);
	const memoryListRef = useRef<HTMLElement | null>(null);
	const activeMemoryCount = useMemo(
		() => snapshot.memories.filter((memory) => memory.status === "active").length,
		[snapshot.memories],
	);
	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return snapshot.memories.filter(
			(memory) =>
				(layer === "all" || (memory.layer ?? "mid_term") === layer) &&
				(!needle ||
					`${memory.subject ?? ""} ${memory.content} ${memory.type} ${memory.sourceType}`
						.toLowerCase()
						.includes(needle)),
		);
	}, [snapshot.memories, query, layer]);

	useEffect(() => {
		setDraft(selected?.content ?? "");
	}, [selected?.id, selected?.content]);

	async function refresh() {
		const response = await request({ type: "snapshot" });
		if (response.snapshot) update(response.snapshot);
	}

	async function loadFacts() {
		const response = await request({ type: "memory-user-model-list" });
		setFacts(response.userModelFacts ?? []);
	}

	useEffect(() => {
		void loadFacts().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not load memory.",
			),
		);
	}, []);

	async function mutate(input: RendererRequest) {
		setBusy(true);
		setError("");
		try {
			await request(input);
			await refresh();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Memory update failed.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function createMemory(event: FormEvent) {
		event.preventDefault();
		const content = newContent.trim();
		if (!content) return;
		await mutate({
			type: "memory-remember",
			memoryType: newType,
			content,
			sensitivity: "personal",
			sourceId: "desktop-user",
			layer: newLayer,
		});
		setNewContent("");
	}

	async function forgetSelected() {
		if (!selected) return;
		const index = visible.findIndex((memory) => memory.id === selected.id);
		await mutate({ type: "memory-forget", id: selected.id });
		const next = visible[index + 1] ?? visible[index - 1];
		setSelectedId(next?.id ?? null);
		window.setTimeout(() => {
			const target = next
				? memoryListRef.current?.querySelector<HTMLButtonElement>(
						`[data-memory-id="${CSS.escape(next.id)}"]`,
					)
				: undefined;
			(
				target ??
				memoryListRef.current?.querySelector<HTMLButtonElement>("button")
			)?.focus();
		}, 0);
	}

	async function previewContext(event: FormEvent) {
		event.preventDefault();
		if (!contextQuery.trim()) return;
		setBusy(true);
		setError("");
		try {
			const response = await request({
				type: "life-context-preview",
				query: contextQuery.trim(),
				includeSensitive: false,
				includeRestricted: false,
			});
			setContext(response.contextBundle ?? null);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not explain context.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function searchTranscripts(event: FormEvent) {
		event.preventDefault();
		const value = transcriptQuery.trim();
		if (!value) {
			setTranscriptResults([]);
			setTranscriptError("");
			return;
		}
		setTranscriptBusy(true);
		setTranscriptError("");
		try {
			const response = await request({
				type: "runtime-search-messages",
				query: value,
				limit: 30,
			});
			setTranscriptResults(response.transcriptResults ?? []);
		} catch (cause) {
			setTranscriptError(
				cause instanceof Error
					? cause.message
					: "Transcript search failed.",
			);
			setTranscriptResults([]);
		} finally {
			setTranscriptBusy(false);
		}
	}

	async function reviewFact(id: string, decision: "confirm" | "reject") {
		setBusy(true);
		setError("");
		try {
			await request({ type: "memory-user-model-review", id, decision });
			await loadFacts();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Review failed.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="life-memory">
			<MemoryRecallStatus snapshot={snapshot} />
			<section className="memory-commandbar">
				<label>
					<span className="sr-only">Search memories</span>
					<Icon name="search" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search facts, people, projects, or sources"
					/>
				</label>
				<select
					aria-label="Memory layer"
					value={layer}
					onChange={(event) => setLayer(event.target.value as typeof layer)}
				>
					<option value="all">Every layer</option>
					<option value="short_term">Short term</option>
					<option value="mid_term">Mid term</option>
					<option value="long_term">Long term</option>
					<option value="archived">Archived</option>
				</select>
				<strong>{visible.length} remembered</strong>
			</section>

			<section className="transcript-search-panel" aria-labelledby="transcript-search-title">
				<header>
					<div>
						<span className="eyebrow">Local encrypted history</span>
						<h2 id="transcript-search-title">Search conversations</h2>
					</div>
					<small>Standard conversations only · no provider request</small>
				</header>
				<p>
					Search runs on this Mac over encrypted transcript records. Private,
					incognito, and forgotten conversations are excluded and remain out of
					this result list.
				</p>
				<form className="memory-search" onSubmit={(event) => void searchTranscripts(event)}>
					<label className="sr-only" htmlFor="transcript-search-input">
						Search conversations
					</label>
					<input
						id="transcript-search-input"
						value={transcriptQuery}
						onChange={(event) => setTranscriptQuery(event.target.value)}
						placeholder="Search encrypted task history"
					/>
					<button className="button secondary" disabled={transcriptBusy || !transcriptQuery.trim()}>
						{transcriptBusy ? "Searching…" : "Search history"}
					</button>
				</form>
				{transcriptError ? <p className="connection-error" role="alert">{transcriptError}</p> : null}
				{transcriptResults.length > 0 ? (
					<div className="transcript-search-results" aria-live="polite">
						{transcriptResults.map((result) => (
							<button
								className="transcript-search-result"
								key={`${result.sessionId}:${result.messageId}`}
								onClick={() => onOpenTranscriptResult?.(result)}
							>
								<span className="eyebrow">
									{result.sessionTitle} · {result.role} · {new Date(result.createdAt).toLocaleString()}
								</span>
								<strong>{result.preview}</strong>
								<small>Open the exact message in this conversation</small>
							</button>
						))}
					</div>
				) : transcriptQuery.trim() && !transcriptBusy ? (
					<p className="memory-no-results">No searchable conversation matches.</p>
				) : null}
			</section>

			{activeMemoryCount === 0 && !busy && (
				<section className="life-empty">
					<Icon name="memory" />
					<div>
						<h2>No memories yet</h2>
						<p>
							Say <em>remember that …</em> in chat to store a preference, or add a
							confirmed fact below. Inspect what Kestrel keeps before it influences
							a new chat.
						</p>
					</div>
				</section>
			)}

			<div className="memory-ledger">
				<section
					ref={memoryListRef}
					className="memory-ledger-list"
					aria-label="Memories"
				>
					{visible.map((memory) => (
						<button
							key={memory.id}
							data-memory-id={memory.id}
							className={memory.id === selectedId ? "active" : ""}
							aria-pressed={memory.id === selectedId}
							onClick={() => setSelectedId(memory.id)}
						>
							<span data-state={memory.confirmationStatus ?? "inferred"} />
							<div>
								<strong>{memory.subject ?? memory.content}</strong>
								<small>
									{formatDisplayLabel(memory.layer ?? "mid_term")} ·{" "}
									{memoryState(memory)} · {Math.round(memory.confidence * 100)}%
								</small>
							</div>
						</button>
					))}
					{visible.length === 0 && (
						<div className="memory-no-results">
							<p>No memories match this view.</p>
							<button
								className="quiet-link"
								onClick={() => {
									setQuery("");
									setLayer("all");
								}}
							>
								Clear filters
							</button>
						</div>
					)}
				</section>

				<section className="memory-inspector">
					{selected ? (
						<>
							<header>
								<div>
									<span className="eyebrow">
										{(selected.layer ?? "mid_term").replaceAll("_", " ")} ·{" "}
										{memoryState(selected)}
									</span>
									<h2>{selected.subject ?? selected.type}</h2>
								</div>
								<span>{selected.sensitivity}</span>
							</header>
							<label>
								Remembered fact
								<textarea
									rows={4}
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
								/>
							</label>
							<div className="memory-inspector-actions">
								<button
									className="button primary"
									disabled={
										busy || !draft.trim() || draft.trim() === selected.content
									}
									onClick={() =>
										void mutate({
											type: "memory-correct",
											id: selected.id,
											content: draft.trim(),
											memoryType: selected.type,
											sensitivity: selected.sensitivity,
											layer: selected.layer ?? "mid_term",
										})
									}
								>
									Save correction
								</button>
								<button
									className="button secondary"
									disabled={busy}
									onClick={() => void forgetSelected()}
								>
									Forget this fact
								</button>
							</div>
							<dl>
								<dt>Source</dt>
								<dd>
									{selected.sourceType}
									<small>{selected.sourceIds.join(" · ")}</small>
								</dd>
								<dt>Confidence</dt>
								<dd>{Math.round(selected.confidence * 100)}%</dd>
								<dt>Relevance</dt>
								<dd>
									{Math.round(
										(selected.relevanceScore ?? selected.importance) * 100,
									)}
									%
								</dd>
								<dt>Updated</dt>
								<dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
								{(selected.conflictingMemoryIds?.length ?? 0) > 0 && (
									<>
										<dt>Related conflicts</dt>
										<dd>{selected.conflictingMemoryIds!.length}</dd>
									</>
								)}
							</dl>
							<details>
								<summary>Why it was remembered</summary>
								<p>
									Kestrel kept this as {memoryState(selected)} {selected.type}{" "}
									context from {selected.sourceType}. It can be selected only
									when the task, people, project, or time range make it useful.
								</p>
							</details>
						</>
					) : (
						<div className="memory-inspector-empty">
							<h2>Select a memory</h2>
							<p>
								Inspect its source, authority, confidence, use, and controls.
							</p>
						</div>
					)}
				</section>
			</div>

			<details className="life-create">
				<summary>Add a confirmed memory</summary>
				<form onSubmit={(event) => void createMemory(event)}>
					<label className="wide">
						Fact
						<textarea
							rows={2}
							value={newContent}
							onChange={(event) => setNewContent(event.target.value)}
						/>
					</label>
					<label>
						Type
						<select
							value={newType}
							onChange={(event) =>
								setNewType(event.target.value as MemoryRecord["type"])
							}
						>
							{[
								"semantic",
								"episodic",
								"procedural",
								"project",
								"relationship",
							].map((type) => (
								<option key={type}>{type}</option>
							))}
						</select>
					</label>
					<label>
						Layer
						<select
							value={newLayer}
							onChange={(event) =>
								setNewLayer(event.target.value as typeof newLayer)
							}
						>
							<option value="short_term">Short term</option>
							<option value="mid_term">Mid term</option>
							<option value="long_term">Long term</option>
						</select>
					</label>
					<button
						className="button primary"
						disabled={busy || !newContent.trim()}
					>
						Remember
					</button>
				</form>
			</details>

			<section className="context-explainer">
				<header>
					<div>
						<h2>Explain context selection</h2>
					</div>
				</header>
				<form onSubmit={(event) => void previewContext(event)}>
					<input
						value={contextQuery}
						onChange={(event) => setContextQuery(event.target.value)}
						placeholder="When should I work on the statistics paper?"
					/>
					<button
						className="button secondary"
						disabled={busy || !contextQuery.trim()}
					>
						Show influences
					</button>
				</form>
				{context && (
					<ol>
						{context.influences.map((influence) => (
							<li key={`${influence.kind}:${influence.id}`}>
								<strong>{influence.kind}</strong>
								<span>{influence.reason}</span>
								<small>{Math.round(influence.confidence * 100)}%</small>
							</li>
						))}
					</ol>
				)}
			</section>

			{facts.some((fact) => fact.status === "proposed") && (
				<section className="life-proposals">
					<header>
						<h2>Waiting for your review</h2>
					</header>
					{facts
						.filter((fact) => fact.status === "proposed")
						.map((fact) => (
							<article key={fact.id}>
								<div>
									<strong>
										{fact.kind}.{fact.key}
									</strong>
									<p>{fact.value}</p>
									<small>{fact.sourceIds.join(" · ")}</small>
								</div>
								<div>
									<button
										className="button primary"
										disabled={busy}
										onClick={() => void reviewFact(fact.id, "confirm")}
									>
										Confirm
									</button>
									<button
										className="button secondary"
										disabled={busy}
										onClick={() => void reviewFact(fact.id, "reject")}
									>
										Reject
									</button>
								</div>
							</article>
						))}
				</section>
			)}

			<DreamingPanel memories={snapshot.memories} onMemoryChanged={refresh} />
			<p className="memory-control-note">
				Sensitive and restricted fields are excluded from task context unless
				the action has matching permission. Backups, export, and full data reset
				remain in Settings.
			</p>
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

export function LifeContext({
	snapshot,
	update,
	onOpenTranscriptResult,
}: {
	snapshot: WorkspaceSnapshot;
	update(next: WorkspaceSnapshot): void;
	onOpenTranscriptResult?(result: TranscriptSearchResult): void;
}) {
	const [view, setView] = useState<LifeView>("calendar");
	return (
		<div className="life-page">
			<header className="page-header life-header">
				<h1>Life</h1>
			</header>
			<nav className="life-switcher" aria-label="Life views">
				{(
					[
						["calendar", "Calendar", "today"],
						["timeline", "Timeline", "activity"],
						["people", "People", "chat"],
						["memory", "Memory", "memory"],
					] as const
				).map(([id, label, icon]) => (
					<button
						key={id}
						aria-current={view === id ? "page" : undefined}
						className={view === id ? "active" : ""}
						onClick={() => setView(id)}
					>
						<Icon name={icon} />
						<span>{label}</span>
					</button>
				))}
			</nav>
			{view === "calendar" && <CalendarView />}
			{view === "timeline" && <TimelineView />}
			{view === "people" && <PeopleView />}
			{view === "memory" && (
				<MemoryView
					snapshot={snapshot}
					update={update}
					{...(onOpenTranscriptResult
						? { onOpenTranscriptResult }
						: {})}
				/>
			)}
		</div>
	);
}
