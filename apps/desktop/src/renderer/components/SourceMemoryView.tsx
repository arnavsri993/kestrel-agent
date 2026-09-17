import { useEffect, useState } from "react";
import type { CoreResponse, SourceObservation, SourceSelection, TimelineEvent } from "@kestrel/shared-types";

const selectionKey = (source: SourceSelection) => JSON.stringify([source.connectionId, source.resourceId]);

export function SourceMemoryView({ sessionId, onQueued }: { sessionId: string; onQueued?: () => void }) {
 const [sources, setSources] = useState<SourceSelection[]>([]);
 const [selected, setSelected] = useState(""); const [query, setQuery] = useState("");
 const [offset, setOffset] = useState(0); const [page, setPage] = useState<{ events: TimelineEvent[]; nextOffset?: number | undefined }>();
 const [error, setError] = useState(""); const [view, setView] = useState<"timeline" | "people">("timeline");
 const [queued, setQueued] = useState<string[]>([]);
 const [running, setRunning] = useState<string>();
 const [reviewed, setReviewed] = useState<string[]>([]);
 async function runReview(observationId: string, retry = false) {
  setRunning(observationId); setError("");
  try {
   const result = await window.kestrel.request({ type: "source-run-review", sessionId, observationId, retry, model: "auto", providerIds: ["auto"] });
   if (!result.ok) throw new Error(result.error);
   setReviewed(ids => [...new Set([...ids, observationId])]); onQueued?.();
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Review failed."); onQueued?.(); }
  finally { setRunning(undefined); }
 }
 async function stopReview() {
  const result = await window.kestrel.request({ type: "source-stop-review", sessionId });
  if (!result.ok) setError(result.error);
 }

 async function queueReview(observationId: string) {
  try {
   const result = await window.kestrel.request({ type: "source-queue-review", sessionId, observationId });
   if (!result.ok) throw new Error(result.error);
   setQueued(ids => [...new Set([...ids, observationId])]);
   onQueued?.();
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not queue review."); }
 }
 useEffect(() => { let active = true;
  void window.kestrel.request({ type: "source-list", sessionId }).then(raw => { const result = raw as CoreResponse;
   if (!result.ok) throw new Error(result.error);
   if (active) { const next = result.sourceSelections ?? []; setSources(next); setSelected(next[0] ? selectionKey(next[0]) : ""); }
  }).catch(cause => { if (active) setError(String(cause)); });
  return () => { active = false; };
 }, [sessionId]);
 const source = sources.find(item => selectionKey(item) === selected);
 useEffect(() => { let active = true; setPage(undefined); setError("");
  if (!source) return;
  const timer = setTimeout(() => {
   void window.kestrel.request({ type: "source-page", sessionId, connectionId: source.connectionId, resourceId: source.resourceId, query, offset, limit: 50 }).then(raw => {
    const result = raw as CoreResponse; if (!result.ok) throw new Error(result.error);
    if (active) setPage(result.sourcePage);
   }).catch(cause => { if (active) setError(String(cause)); });
  }, 180);
  return () => { active = false; clearTimeout(timer); };
 }, [sessionId, source?.connectionId, source?.resourceId, query, offset]);
 return <section className="source-memory-view" aria-label="Source memory">
  <label className="source-memory-field">Source<select disabled={!sources.length} aria-label="Memory source" value={selected} onChange={event => { setSelected(event.target.value); setOffset(0); }}>
   {!sources.length && <option value="">No sources assigned</option>}
   {sources.map(item => <option key={selectionKey(item)} value={selectionKey(item)}>{item.label}</option>)}
  </select></label>
  <label className="scoped-memory-search">Search imported source history<input type="search" disabled={!sources.length} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} /></label>
  {source && <p>{source.coverage} coverage · {source.status.replaceAll("_", " ")} · {source.modelProcessingConsent ? "Model retrieval permitted when granted" : "Local inspection only"}. Messages are reported observations, not verification of completed work.</p>}
  <nav className="life-switcher" aria-label="Source views"><button className={view === "timeline" ? "active" : ""} aria-current={view === "timeline" ? "page" : undefined} onClick={() => setView("timeline")}>Timeline</button><button className={view === "people" ? "active" : ""} aria-current={view === "people" ? "page" : undefined} onClick={() => setView("people")}>People</button></nav>
  {view === "people" && <p>Observed senders on this page, not a membership roster. Display names alone do not establish identity or a formal role.</p>}
  {error && <p role="alert">{error}</p>}
  {!sources.length && <p>No sources assigned to this scope. Select a source in Connections.</p>}
  {source && !page && !error && <p role="status">Loading source history…</p>}
  {page?.events.map(event => {
   const observation = event.structuredData.observation as SourceObservation;
   return <details key={event.id}><summary>{view === "people" ? `${observation?.senderName ?? "Unknown sender"} · ` : ""}{new Date(event.startedAt).toLocaleString()} · {event.textSummary.slice(0, 120)}</summary>
    <p>{event.textSummary}</p><p>{observation?.senderName ?? "Unknown sender"} · reported · {observation?.state ?? "observed"}</p>
    <p>Original time: {observation?.originalTimestamp ?? event.startedAt}{observation?.timezone ? ` (${observation.timezone})` : " · source time zone unavailable"}</p>
    <p>Imported: {new Date(event.createdAt).toLocaleString()}</p>
    <button className="button secondary" disabled={queued.includes(event.id)} onClick={() => void queueReview(event.id)}>{queued.includes(event.id) ? "Review queued" : "Queue for review"}</button>
    <button className="button secondary" disabled={Boolean(running) || reviewed.includes(event.id) || !source?.modelProcessingConsent || source.status !== "ready"} onClick={() => void runReview(event.id)}>{running === event.id ? "Reviewing…" : reviewed.includes(event.id) ? "Review attempted" : "Review now"}</button>
    <details><summary>Review recovery</summary><button className="button secondary" disabled={Boolean(running) || !source?.modelProcessingConsent} onClick={() => void runReview(event.id, true)}>Retry stopped review</button><p>Retries failed or cancelled analysis using the same work item. Completed reviews are not repeated.</p></details>
    {running === event.id && <button className="button secondary" onClick={() => void stopReview()}>Stop review</button>}
    {reviewed.includes(event.id) && <p role="status">See Work history for the analysis or failure. No specialist work or external action was executed.</p>}
    <p>Review limit: 4 model turns, up to 2,000 output tokens per turn, 60 seconds.</p>
    {queued.includes(event.id) && !running && !reviewed.includes(event.id) && <p role="status">Saved in Work history as planned. No model run or external action has started.</p>}
    <details><summary>Evidence and revisions</summary><p>Source: {source?.label}. {observation?.providerMessageId ? "Provider message identity retained." : "Capture-local identity only; distinct rereads may be duplicates."}</p><p>Record: {event.id}</p><p>Edits are preserved as separate observations. Deleted and expired source content is removed when observed. Attachments have not been processed.</p></details>
   </details>;
  })}
  {page && <div><button className="button secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><span> Page {Math.floor(offset / 50) + 1} </span><button className="button secondary" disabled={page.nextOffset === undefined} onClick={() => setOffset(page.nextOffset!)}>Next</button></div>}
 </section>;
}
