import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { CoreResponse, EventApplicationContract } from "@kestrel/shared-types";

export function EventApplications({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [applications, setApplications] = useState<EventApplicationContract[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", organizer: "", url: "", deadline: "" });
  const selected = useMemo(() => applications.find((item) => item.id === selectedId) ?? applications[0], [applications, selectedId]);

  async function refresh(prefer?: string) {
    const response = await window.kestrel.request({ type: "event-applications-list" }) as CoreResponse;
    if (!response.ok) throw new Error(response.error);
    setApplications(response.eventApplications ?? []);
    if (prefer) setSelectedId(prefer);
  }
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Applications could not load.")); }, []);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy("create"); setError("");
    try {
      const response = await window.kestrel.request({
        type: "event-applications-create", title: form.title, organizer: form.organizer, url: form.url,
        ...(form.deadline ? { deadline: new Date(form.deadline).toISOString() } : {})
      }) as CoreResponse;
      if (!response.ok || !response.eventApplications?.[0]) throw new Error(response.ok ? "Application was not created." : response.error);
      setForm({ title: "", organizer: "", url: "", deadline: "" });
      await refresh(response.eventApplications[0].id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Application was not created."); }
    finally { setBusy(""); }
  }

  async function update(application: EventApplicationContract, patch: {
    status?: Exclude<EventApplicationContract["status"], "submitted">;
    eligibility?: EventApplicationContract["eligibility"];
    answers?: EventApplicationContract["answers"];
  }) {
    setBusy("save"); setError("");
    try {
      const response = await window.kestrel.request({ type: "event-applications-update", id: application.id, ...patch }) as CoreResponse;
      if (!response.ok) throw new Error(response.error);
      await refresh(application.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Application was not saved."); }
    finally { setBusy(""); }
  }

  async function prepare(application: EventApplicationContract) {
    setBusy("prepare"); setError("");
    try {
      await update(application, { status: "preparing" });
      const created = await window.kestrel.request({ type: "runtime-create-session", title: `Apply · ${application.title}` }) as CoreResponse;
      if (!created.ok || !created.session) throw new Error(created.ok ? "Agent session was not created." : created.error);
      const prompt = `Help me prepare this event or hackathon application.\n\nApplication ID: ${application.id}\nEvent: ${application.title}\nOrganizer: ${application.organizer}\nURL: ${application.url}\n${application.deadline ? `Deadline: ${application.deadline}\n` : ""}\nUse web research or the isolated browser to inspect the official form. Use events.list, then events.prepare to save eligibility checks and draft answers. Mark every agent-written answer reviewed=false and label personal or sensitive information honestly. Do not submit, accept terms, make legal attestations, pay, or send anything externally. Stop after preparing the review workspace and tell me what needs my confirmation.`;
      const run = await window.kestrel.request({ type: "runtime-run-agent", sessionId: created.session.id, message: prompt, model: "auto", providerIds: ["auto"], streamId: crypto.randomUUID() }) as CoreResponse;
      if (!run.ok) throw new Error(run.error);
      onOpenSession(created.session.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The preparation agent could not start."); }
    finally { setBusy(""); }
  }

  async function submitWithAgent(application: EventApplicationContract) {
    setBusy("submit"); setError("");
    try {
      const created = await window.kestrel.request({ type: "runtime-create-session", title: `Submit · ${application.title}` }) as CoreResponse;
      if (!created.ok || !created.session) throw new Error(created.ok ? "Submission session was not created." : created.error);
      const prompt = `Help me submit this already reviewed event or hackathon application through the official site.\n\nApplication ID: ${application.id}\nEvent: ${application.title}\nOfficial URL: ${application.url}\n\nUse events.list to read only the approved answers. Open the official URL in the isolated browser, match fields carefully, and stop for my explicit approval immediately before the final external Submit action. Never invent eligibility, legal attestations, consent, demographic data, signatures, payment details, or missing answers. If the site asks for any new or changed information, stop and ask me. After submission, verify a visible confirmation page or confirmation identifier. Only then call events.mark_submitted with a concise receipt. If confirmation is absent or ambiguous, leave the application approved and report what happened.`;
      const run = await window.kestrel.request({ type: "runtime-run-agent", sessionId: created.session.id, message: prompt, model: "auto", providerIds: ["auto"], streamId: crypto.randomUUID() }) as CoreResponse;
      if (!run.ok) throw new Error(run.error);
      onOpenSession(created.session.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser submission agent could not start."); }
    finally { setBusy(""); }
  }

  return <section className="page-frame event-applications-page">
    <header className="event-applications-hero">
      <div><h1>Apply with your agent. Send with your consent.</h1><p>Import an official event or hackathon page, let the local agent prepare a review workspace, then approve each answer before any external submission.</p></div>
      <div className="event-safety-note"><strong>Submission stays locked</strong><span>The agent may research and draft. It cannot turn a draft into a submitted application from this screen.</span></div>
    </header>
    <div className="event-applications-layout">
      <aside className="event-application-rail" aria-label="Saved applications">
        <h2>Applications</h2>
        {applications.length === 0 ? <p className="event-empty">No applications yet. Import the official page to begin.</p> :
          <ul>{applications.map((application) => <li key={application.id}><button className={selected?.id === application.id ? "active" : ""} onClick={() => setSelectedId(application.id)}><strong>{application.title}</strong><span>{application.organizer}</span><small>{application.status.replace("_", " ")}</small></button></li>)}</ul>}
      </aside>
      <div className="event-application-main">
        <form className="event-import-form" onSubmit={create}>
          <div><span className="eyebrow">Import official page</span><h2>Start a review workspace</h2></div>
          <label><span>Event or hackathon</span><input required maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label><span>Organizer</span><input required maxLength={200} value={form.organizer} onChange={(event) => setForm({ ...form, organizer: event.target.value })} /></label>
          <label className="wide"><span>Official HTTPS application URL</span><input required type="url" inputMode="url" placeholder="https://…" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
          <label><span>Deadline, if known</span><input type="datetime-local" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} /></label>
          <button className="button primary" disabled={Boolean(busy)}>{busy === "create" ? "Importing…" : "Import application"}</button>
        </form>
        {selected && <article className="event-review">
          <header><div><span className={`event-status status-${selected.status}`}>{selected.status.replace("_", " ")}</span><h2>{selected.title}</h2><p>{selected.organizer}{selected.deadline ? ` · due ${new Date(selected.deadline).toLocaleString()}` : ""}</p></div><a className="button secondary" href={selected.url} target="_blank" rel="noreferrer">Open official page</a></header>
          <div className="event-review-actions"><button className="button primary" disabled={Boolean(busy) || selected.status === "submitted"} onClick={() => void prepare(selected)}>{busy === "prepare" ? "Starting agent…" : selected.answers.length ? "Prepare again with agent" : "Prepare with local agent"}</button><small>Research and drafting only. External submission requires a separate explicit approval.</small></div>
          <section><div className="event-section-heading"><h3>Eligibility</h3><span>{selected.eligibility.filter((item) => item.met === true).length}/{selected.eligibility.length} confirmed</span></div>
            {selected.eligibility.length === 0 ? <p className="event-empty">The preparation agent has not added eligibility checks yet.</p> :
              <ul className="eligibility-list">{selected.eligibility.map((item, index) => <li key={item.id}><div><strong>{item.label}</strong>{item.evidence && <small>{item.evidence}</small>}</div><select disabled={Boolean(busy)} aria-label={`${item.label} eligibility`} value={item.met === null ? "unknown" : item.met ? "yes" : "no"} onChange={(event) => { const eligibility = selected.eligibility.map((entry, itemIndex) => itemIndex === index ? { ...entry, met: event.target.value === "unknown" ? null : event.target.value === "yes" } : entry); void update(selected, { eligibility }); }}><option value="unknown">Check</option><option value="yes">Eligible</option><option value="no">Not eligible</option></select></li>)}</ul>}
          </section>
          <section><div className="event-section-heading"><h3>Answers for review</h3><span>{selected.answers.filter((item) => item.reviewed).length}/{selected.answers.length} reviewed</span></div>
            {selected.answers.length === 0 ? <p className="event-empty">No draft answers yet. The agent will save drafts here without submitting them.</p> :
              <div className="event-answer-list">{selected.answers.map((answer, index) => <label key={answer.id} className={`event-answer sensitivity-${answer.sensitivity}`}><span><b>{answer.label}{answer.required ? " *" : ""}</b><small>{answer.sensitivity} · drafted by {answer.source}</small></span><textarea disabled={Boolean(busy)} value={answer.value} onChange={(event) => { const answers = selected.answers.map((entry, itemIndex) => itemIndex === index ? { ...entry, value: event.target.value, reviewed: false } : entry); setApplications((current) => current.map((application) => application.id === selected.id ? { ...application, answers } : application)); }} onBlur={() => void update(selected, { answers: selected.answers })} /><span className="review-checkbox"><input disabled={Boolean(busy)} type="checkbox" checked={answer.reviewed} onChange={(event) => { const answers = selected.answers.map((entry, itemIndex) => itemIndex === index ? { ...entry, reviewed: event.target.checked } : entry); setApplications((current) => current.map((application) => application.id === selected.id ? { ...application, answers } : application)); void update(selected, { answers }); }} /> I reviewed this answer</span></label>)}</div>}
          </section>
          <footer><div><strong>Final consent boundary</strong><p>Approval confirms eligibility and answer content. The browser agent must still pause immediately before external submission and verify a receipt afterward.</p></div>{selected.status === "approved" ? <button className="button primary" disabled={Boolean(busy)} onClick={() => void submitWithAgent(selected)}>{busy === "submit" ? "Starting secure browser…" : "Continue with browser agent"}</button> : <button className="button primary" disabled={Boolean(busy) || selected.status === "submitted"} onClick={() => void update(selected, { status: "approved" })}>{selected.status === "submitted" ? "Submission receipt saved" : "Approve reviewed application"}</button>}</footer>
        </article>}
        {error && <p className="event-error" role="alert">{error}</p>}
      </div>
    </div>
  </section>;
}
