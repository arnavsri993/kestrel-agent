import { useEffect, useState } from "react";
import type { CoreResponse, PersonRecord, UnifiedCalendarEvent } from "@kestrel/shared-types";

export function ScopedLifeView({ sessionId, view }: { sessionId: string; view: "people" | "calendar" }) {
 const [people, setPeople] = useState<PersonRecord[]>([]); const [events, setEvents] = useState<UnifiedCalendarEvent[]>([]);
 const [error, setError] = useState(""); const [revision, setRevision] = useState(0); const [busy, setBusy] = useState(false);
 const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
 useEffect(() => { let active = true; setError("");
  const start = new Date(`${month}-01T00:00:00`); const end = new Date(start); end.setMonth(end.getMonth() + 1);
  void window.kestrel.request(view === "people" ? { type: "people-list", sessionId } : { type: "calendar-list", sessionId, startsAt: start.toISOString(), endsAt: end.toISOString() }).then(raw => { const result = raw as CoreResponse;
   if (!result.ok) throw new Error(result.error);
   if (active) { setPeople(result.people ?? []); setEvents(result.calendarEvents ?? []); }
  }).catch(cause => { if (active) setError(String(cause)); }); return () => { active = false; };
 }, [sessionId, view, revision, month]);
 async function save(action: () => Promise<{ ok: boolean; error?: string }>) {
  setBusy(true); setError(""); try { const result = await action(); if (!result.ok) throw new Error(result.error); setRevision(value => value + 1); }
  catch (cause) { setError(String(cause)); } finally { setBusy(false); }
 }
 return <section aria-label={view === "people" ? "Agent people" : "Agent calendar"}>
  {error && <p role="alert">{error}</p>}
  {view === "people" ? <>
   <p>People in this scope only. Observed senders are not a complete team roster; roles are added explicitly.</p>
   <details><summary>Add a person</summary><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void save(() => window.kestrel.request({ type: "people-upsert", sessionId, displayName: String(data.get("name")), role: String(data.get("role") ?? ""), nicknames: [], sourceId: "desktop-user", sensitivity: "personal" })); }}>
    <label>Name<input name="name" required maxLength={300} /></label><label>Confirmed role (optional)<input name="role" maxLength={500} /></label><button disabled={busy}>Add person</button>
   </form></details>
   {people.map(person => <details key={person.id}><summary>{person.displayName} · {person.identityStatus ?? "confirmed"}</summary><p>{person.role ?? "No formal role recorded."}</p><p>{person.lastInteractionAt ? `Last observed activity: ${new Date(person.lastInteractionAt).toLocaleString()}` : "No source activity recorded."}</p>
    <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void save(() => window.kestrel.request({ type: "people-upsert", sessionId, id: person.id, displayName: String(data.get("name")), role: String(data.get("role") ?? ""), nicknames: person.nicknames, sourceId: "desktop-user", sensitivity: person.sensitivity })); }}>
     <label>Correct name<input name="name" defaultValue={person.displayName} required maxLength={300} /></label><label>Confirmed role<input name="role" defaultValue={person.role ?? ""} maxLength={500} /></label><button disabled={busy}>Save correction</button>
    </form><p>Source references: {person.sourceIds.join(", ")}</p>
   </details>)}
   {!people.length && <p>No identified people yet. Ambiguous display names remain with their source observations.</p>}
  </> : <>
   <p>Upcoming events for this agent. These entries do not publish to your personal calendar.</p>
   <label>Month<input type="month" value={month} required onChange={event => { if (event.target.value) setMonth(event.target.value); }} /></label>
   <details><summary>Add an event or deadline</summary><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void save(() => window.kestrel.request({ type: "calendar-create-local", sessionId, title: String(data.get("title")), startsAt: new Date(String(data.get("start"))).toISOString(), endsAt: new Date(String(data.get("end"))).toISOString(), origin: data.get("confirmed") === "on" ? "explicit" : "suggested", confidence: data.get("confirmed") === "on" ? 1 : 0, sourceId: "desktop-user" })); }}>
    <label>Title<input name="title" required maxLength={2000} /></label><label>Starts (local time)<input type="datetime-local" name="start" required /></label><label>Ends (local time)<input type="datetime-local" name="end" required /></label><label><input name="confirmed" type="checkbox" /> This time is confirmed</label><button disabled={busy}>Save in agent calendar</button>
   </form></details>
   {events.map(event => <details key={event.id}><summary>{new Date(event.startsAt).toLocaleString()} · {event.title} · {event.status}</summary><p>{event.description}</p><p>{event.confidenceReason}</p><p>Source: {event.sourceIds.join(", ")}</p><button disabled={busy} onClick={() => void save(() => window.kestrel.request({ type: "calendar-delete-local", sessionId, id: event.id }))}>Delete this local entry</button></details>)}
   {!events.length && <p>No events in this month.</p>}
  </>}
 </section>;
}
