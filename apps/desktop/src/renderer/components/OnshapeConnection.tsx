import { useEffect, useState } from "react";
import type { CoreResponse, RuntimeSession } from "@kestrel/shared-types";

export function OnshapeConnection({ session }: { session?: RuntimeSession | undefined }) {
 const [configured, setConfigured] = useState(false); const [error, setError] = useState("");
 const [busy, setBusy] = useState(false); const [documentUrl, setDocumentUrl] = useState(""); const [result, setResult] = useState("");
 async function refresh() { const response = await window.kestrel.request({ type: "onshape-status" }) as CoreResponse; if (!response.ok) throw new Error(response.error); setConfigured(Boolean(response.onshapeStatus?.configured)); }
 useEffect(() => { void refresh().catch(cause => setError(String(cause))); }, []);
 async function action(work: () => Promise<void>) { setBusy(true); setError(""); try { await work(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
 return <section className="agent-resource-access" aria-label="Onshape connection">
  <h2>Onshape</h2><p>{configured ? "Keys configured · document access not yet verified" : "Not configured"}. Read-only document inspection.</p>
  {error && <p role="alert">{error}</p>}
  <details><summary>{configured ? "Replace protected keys" : "Connect Onshape"}</summary>
   <p>For personal use, create a read-only key in Onshape’s Developer settings. Keys stay in Kestrel’s protected storage. This currently supports cad.onshape.com.</p>
   <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); form.reset(); void action(async () => {
    for (const [credentialId, name] of [["onshape-access", "access"], ["onshape-secret", "secret"]] as const) { const response = await window.kestrel.request({ type: "credential-set", credentialId, value: String(values.get(name)) }); values.delete(name); if (!response.ok) throw new Error(response.error); }
    await refresh();
   }); }}>
    <label>Access key<input name="access" type="password" required minLength={8} autoComplete="off" /></label>
    <label>Secret key<input name="secret" type="password" required minLength={8} autoComplete="off" /></label>
    <button className="button secondary" disabled={busy}>Save protected keys</button>
   </form>
  </details>
  {configured && session?.kind === "agent" && <form onSubmit={event => { event.preventDefault(); void action(async () => {
   const assigned = await window.kestrel.request({ type: "onshape-assign", sessionId: session.id, documentUrl }); if (!assigned.ok) throw new Error(assigned.error);
   const inspected = await window.kestrel.request({ type: "onshape-inspect", sessionId: session.id, documentUrl }) as CoreResponse;
   if (!inspected.ok) throw new Error(inspected.error);
   if (inspected.execution?.status !== "verified") throw new Error(inspected.execution?.error ?? "Document inspection did not complete.");
   const output = inspected.execution.output;
   setResult(`Verified element metadata read at ${String(output?.observedAt)}. ${Array.isArray(output?.elements) ? output.elements.length : 0} elements. Geometry, fit, and CAD editing remain unverified.`);
  }); }}>
   <label>Document URL<input type="url" required value={documentUrl} onChange={event => { setDocumentUrl(event.target.value); setResult(""); }} /></label>
   <p>Assigns read access to this document workspace or version for {session.title}. Revoke it under agent access. An element URL grants the containing document context.</p>
   <button className="button secondary" disabled={busy}>Assign and inspect document</button>
  </form>}
  {!session && <p>Select an agent to assign a document.</p>}
  {result && <p role="status">{result}</p>}
 </section>;
}
