import { useEffect, useState } from "react";
import type { CoreResponse, RuntimeSession, SourceSelection } from "@kestrel/shared-types";

export function WhatsAppConnection({ session }: { session?: RuntimeSession | undefined }) {
 const [inspection, setInspection] = useState<{ state: string; reason?: string; name?: string; resourceId?: string }>();
 const [sources, setSources] = useState<SourceSelection[]>([]);
 const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
 const [consent, setConsent] = useState(false); const [modelConsent, setModelConsent] = useState(false);
 const [dateOrder, setDateOrder] = useState<"MDY" | "DMY">("MDY");
 const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
 async function refresh() {
  if (!session) return;
  const response = await window.kestrel.request({ type: "source-list", sessionId: session.id }) as CoreResponse;
  if (!response.ok) throw new Error(response.error);
  setSources((response.sourceSelections ?? []).filter(item => item.connectionId === "whatsapp-browser"));
 }
 useEffect(() => { let active = true; setSources([]); setConsent(false); setInspection(undefined);
  if (session) void window.kestrel.request({ type: "source-list", sessionId: session.id }).then(raw => {
   const response = raw as CoreResponse;
   if (active && response.ok) setSources((response.sourceSelections ?? []).filter(item => item.connectionId === "whatsapp-browser"));
  }); return () => { active = false; };
 }, [session?.id]);
 async function perform(action: () => Promise<void>) {
  setBusy(true); setError(""); setNotice("");
  try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "WhatsApp operation failed."); }
  finally { setBusy(false); }
 }
 return <section className="agent-resource-access" aria-label="WhatsApp connection">
  <h2>WhatsApp</h2><p>Browser connection · user-triggered reads only</p>
  <button disabled={busy} onClick={() => void perform(async () => { const result = await window.kestrel.request({ type: "whatsapp-open" }); if (!result.ok) throw new Error(result.error); if ("whatsapp" in result) setInspection(result.whatsapp); })}>Open WhatsApp connection</button>
  <details><summary>{sources.length ? `${sources.length} assigned conversation${sources.length === 1 ? "" : "s"}` : "Select a team conversation"}</summary>
   <p>Link your account in the dedicated window. Open the team group and Group info. Opening messages may mark them read. Kestrel checks the group and privacy settings before capturing up to 200 visible text messages.</p>
   <p>Capture currently supports recognized English controls. Protected, disappearing, or unrecognized content is not imported.</p>
   {!session || session.kind !== "agent" ? <p>Choose a parent agent in “Access for” to assign a conversation.</p> : <>
    <button disabled={busy} onClick={() => void perform(async () => { const result = await window.kestrel.request({ type: "whatsapp-inspect" }); if (!result.ok) throw new Error(result.error); if ("whatsapp" in result) { setInspection(result.whatsapp); setConsent(false); } })}>Check selected group</button>
    {inspection && <p role="status">{inspection.name ? `${inspection.name} · ` : ""}{inspection.state.replaceAll("_", " ")}{inspection.reason ? ` — ${inspection.reason}` : ""}</p>}
    {inspection?.state === "ready" && inspection.resourceId && <form onSubmit={event => { event.preventDefault(); void perform(async () => {
     const result = await window.kestrel.request({ type: "whatsapp-select", sessionId: session.id, resourceId: inspection.resourceId!, processingConsent: true, modelProcessingConsent: modelConsent, dateOrder, timezone });
     if (!result.ok) throw new Error(result.error); await refresh(); setNotice("Conversation assigned. Use Sync now to read the visible range.");
    }); }}>
     <label><input type="checkbox" required checked={consent} onChange={event => setConsent(event.target.checked)} /> I have permission to process this conversation and store its selected messages locally in {session.title} memory.</label>
     <label><input type="checkbox" checked={modelConsent} onChange={event => setModelConsent(event.target.checked)} /> Allow relevant messages to be sent to my configured model provider when this agent uses them.</label>
     <label>Displayed date order<select value={dateOrder} onChange={event => setDateOrder(event.target.value as "MDY" | "DMY")}><option value="MDY">Month/day/year</option><option value="DMY">Day/month/year</option></select></label>
     <label>Message time zone<input value={timezone} required onChange={event => setTimezone(event.target.value)} /></label>
     <button type="submit" disabled={busy || !consent}>Assign selected conversation</button>
    </form>}
    {sources.map(source => <article key={source.resourceId}>
     <h3>{source.label}</h3><p>{source.status.replaceAll("_", " ")} · {source.coverage} history{source.lastSyncedAt ? ` · last read ${new Date(source.lastSyncedAt).toLocaleString()}` : " · not yet read"}</p>
     {source.oldestObservedAt && <p>Observed range: {new Date(source.oldestObservedAt).toLocaleString()} – {source.newestObservedAt ? new Date(source.newestObservedAt).toLocaleString() : "unknown"}. This is not a full-history sync.</p>}
     <button disabled={busy || source.status !== "ready"} onClick={() => void perform(async () => {
      try { const result = await window.kestrel.request({ type: "whatsapp-sync", sessionId: session.id, resourceId: source.resourceId }) as CoreResponse; if (!result.ok) throw new Error(result.error); setNotice(`${result.sourceIngestion?.inserted ?? 0} new observations; ${result.sourceIngestion?.repeated ?? 0} already stored. Coverage is partial.`); }
      finally { await refresh(); }
     })}>Sync now</button>
     <button disabled={busy} onClick={() => void perform(async () => { const result = await window.kestrel.request({ type: "source-select", selection: { ...source, status: source.status === "paused" ? "ready" : "paused", updatedAt: new Date().toISOString() } }); if (!result.ok) throw new Error(result.error); await refresh(); })}>{source.status === "paused" ? "Resume" : "Pause"}</button>
     <details><summary>Disconnect this source</summary><p>Stops synchronization and model retrieval. Imported observations remain available for you to inspect in Memory. The linked browser session stays on this computer.</p>
      <button disabled={busy} onClick={() => void perform(async () => { const result = await window.kestrel.request({ type: "source-select", selection: { ...source, status: "disconnected", updatedAt: new Date().toISOString() } }); if (!result.ok) throw new Error(result.error); await refresh(); })}>Disconnect source</button>
     </details>
    </article>)}
   </>}
  </details>
  {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
 </section>;
}
