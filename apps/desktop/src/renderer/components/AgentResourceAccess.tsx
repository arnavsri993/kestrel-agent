import { useEffect, useState } from "react";
import type { CoreResponse, ResourceAccess, RuntimeSession } from "@kestrel/shared-types";

export function AgentResourceAccess({ session, googleEmail }: { session: RuntimeSession; googleEmail?: string }) {
 const [grants, setGrants] = useState<ResourceAccess[]>([]);
 const [parentGrants, setParentGrants] = useState<ResourceAccess[]>([]);
 const [error, setError] = useState("");
 const [busy, setBusy] = useState(false);
 const [loaded, setLoaded] = useState(false);
 const [kind, setKind] = useState("thread");
 const [value, setValue] = useState("");
 useEffect(() => {
  let active = true;
  setLoaded(false); setError(""); setGrants([]); setParentGrants([]);
  void Promise.all([window.kestrel.request({ type: "runtime-get-resource-grants", sessionId: session.id }),
   session.parentSessionId ? window.kestrel.request({ type: "runtime-get-resource-grants", sessionId: session.parentSessionId }) : Promise.resolve(undefined)]).then(results => {
   if (!active) return;
   const own = results[0] as CoreResponse;
   const parent = results[1] as CoreResponse | undefined;
   if (!own.ok) throw new Error(own.error);
   if (parent && !parent.ok) throw new Error(parent.error);
   setGrants(own.resourceGrants ?? []); setParentGrants(parent?.ok ? parent.resourceGrants ?? [] : []); setLoaded(true);
  }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load access."); });
  return () => { active = false; };
 }, [session.id, session.parentSessionId]);
 async function save(next: ResourceAccess[]) {
  setBusy(true); setError("");
  try {
   const result = await window.kestrel.request({ type: "runtime-set-resource-grants", sessionId: session.id, grants: next }) as CoreResponse;
   if (!result.ok) throw new Error(result.error);
   setGrants(result.resourceGrants ?? []); setValue("");
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save access."); }
  finally { setBusy(false); }
 }
 const same = (a: ResourceAccess, b: ResourceAccess) => a.connectionId === b.connectionId && a.resourceId === b.resourceId && a.capability === b.capability;
 return <section aria-label="Agent resource access" className="agent-resource-access">
  <h2>{session.title} access</h2>
  <p>Only selected resources are available. Revoking access stops future reads; imported memories remain until deleted in Memory.</p>
  {session.parentSessionId && <p>A specialist also needs its parent’s permission and an explicit grant in each delegated task.</p>}
  {error && <p role="alert">{error}</p>}
  {!loaded && !error && <p role="status">Loading access…</p>}
  {loaded && <>
   <ul>{grants.map((grant, index) => <li key={`${grant.connectionId}:${grant.resourceId}:${grant.capability}`}>
    <span>{grant.resourceId} · {grant.capability}<small>{grant.connectionId}</small></span>
    <button disabled={busy} onClick={() => void save(grants.filter((_, position) => position !== index))}>Revoke</button>
   </li>)}</ul>
   {!grants.length && <p>No connected resources assigned.</p>}
   {session.parentSessionId ? <details><summary>Assign from parent</summary>
    {parentGrants.filter(item => !grants.some(grant => same(grant, item))).map(item => <p key={`${item.connectionId}:${item.resourceId}:${item.capability}`}>
     {item.resourceId} · {item.capability} <button disabled={busy} onClick={() => void save([...grants, item])}>Assign</button>
    </p>)}
    {!parentGrants.length && <p>Assign a resource to the parent agent first.</p>}
   </details> : googleEmail ? <details><summary>Assign a Google resource</summary>
    <form onSubmit={event => {
     event.preventDefault();
     const candidate: ResourceAccess = { connectionId: `google-workspace:${googleEmail}`, resourceId: kind === "calendar" ? "calendar:primary" : kind === "recipient" ? `gmail:recipient:${value.trim().toLowerCase()}` : `gmail:thread:${value.trim()}`, capability: kind === "recipient" ? "draft" : "read" };
     if (!grants.some(grant => same(grant, candidate))) void save([...grants, candidate]);
    }}>
     <label>Resource<select value={kind} onChange={event => { setKind(event.target.value); setValue(""); }}>
      <option value="thread">Gmail thread — read</option><option value="recipient">Email recipient — draft only</option><option value="calendar">Primary calendar — read</option>
     </select></label>
     {kind !== "calendar" && <label>{kind === "thread" ? "Gmail thread ID" : "Recipient email"}<input required type={kind === "recipient" ? "email" : "text"} pattern={kind === "thread" ? "[a-zA-Z0-9_-]{1,200}" : undefined} maxLength={kind === "thread" ? 200 : 300} value={value} onChange={event => setValue(event.target.value)} /></label>}
     <p>{kind === "thread" ? "Use an explicit thread ID. This does not grant mailbox search or attachment access." : kind === "calendar" ? "Allows reading events on your primary calendar. It does not publish events." : "Allows creating drafts to this recipient after the normal approval check. It does not grant mailbox reads or sending."}</p>
     <button disabled={busy} type="submit">Assign resource</button>
    </form>
   </details> : <p>Connect Google Workspace below to assign a supported resource.</p>}
  </>}
 </section>;
}
