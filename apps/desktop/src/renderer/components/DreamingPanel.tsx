import { useEffect, useMemo, useState } from "react";
import type { CoreResponse, DreamingConfiguration, DreamingStatus, MemoryRecord } from "@kestrel/shared-types";

export function DreamingPanel({ memories, onMemoryChanged }: { memories: MemoryRecord[]; onMemoryChanged(): Promise<void> }) {
  const [status, setStatus] = useState<DreamingStatus | null>(null);
  const [busy, setBusy] = useState<"save" | "preview" | "run" | "review" | "">("");
  const [error, setError] = useState("");
  const byId = useMemo(() => new Map(memories.map((memory) => [memory.id, memory])), [memories]);

  async function request(input: Parameters<typeof window.kestrel.request>[0], action: typeof busy) {
    setBusy(action); setError("");
    try {
      const response = await window.kestrel.request(input) as CoreResponse;
      if (!response.ok || !response.dreamingStatus) throw new Error(response.ok ? "Memory consolidation did not return status." : response.error);
      setStatus(response.dreamingStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory consolidation failed.");
    } finally {
      setBusy("");
    }
  }

  useEffect(() => { void request({ type: "dreaming-get" }, ""); }, []);
  if (!status) return <section className="dreaming-panel" aria-label="Memory consolidation"><p>{error || "Loading private consolidation status…"}</p></section>;
  const configuration = status.configuration;
  const pending = status.candidates.filter((candidate) => candidate.status === "review");
  const previewOnly = status.detail.startsWith("Preview complete.");
  const setConfiguration = (change: Partial<DreamingConfiguration>) => request({ type: "dreaming-set", configuration: { ...configuration, ...change } }, "save");

  async function review(id: string, decision: "promote" | "reject") {
    await request({ type: "dreaming-review", id, decision }, "review");
    if (decision === "promote") await onMemoryChanged();
  }

  return <section className="dreaming-panel" aria-labelledby="dreaming-title">
    <header>
      <div><span className="eyebrow">Private memory maintenance</span><h2 id="dreaming-title">Dreaming</h2><p>Light recall, REM grouping, and deep scoring run locally. Automatic runs only stage candidates; you decide what becomes confirmed memory.</p></div>
      <div className="dreaming-toggle"><span>{configuration.enabled ? "Automatic runs on" : "Automatic runs off"}</span><button className={`switch ${configuration.enabled ? "on" : ""}`} role="switch" aria-label="Automatic memory consolidation" aria-checked={configuration.enabled} disabled={Boolean(busy)} onClick={() => void setConfiguration({ enabled: !configuration.enabled })}><span /></button></div>
    </header>
    <div className="dreaming-controls">
      <label>Daily run<select aria-label="Memory consolidation hour" value={configuration.scheduleHour} disabled={Boolean(busy)} onChange={(event) => void setConfiguration({ scheduleHour: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</option>)}</select></label>
      <div className="button-row"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void request({ type: "dreaming-run", preview: true }, "preview")}>{busy === "preview" ? "Previewing…" : "Preview safely"}</button><button className="button primary" disabled={Boolean(busy) || !configuration.enabled} onClick={() => void request({ type: "dreaming-run", preview: false }, "run")}>{busy === "run" ? "Running…" : "Run now"}</button></div>
    </div>
    <div className="dreaming-status" aria-live="polite"><strong className={pending.length > 0 ? "attention" : ""}>{pending.length > 0 ? `${pending.length} awaiting review` : "Review queue clear"}</strong><span>{status.detail}</span>{status.nextRunAt && <small>Next automatic run · {new Date(status.nextRunAt).toLocaleString()}</small>}</div>
    {pending.length > 0 && <div className="dreaming-candidates">{pending.map((candidate) => {
      const memory = byId.get(candidate.memoryId);
      return <article key={candidate.id}>
        <div><span className="eyebrow">{candidate.memoryType} · score {Math.round(candidate.score * 100)} · {candidate.sourceCount} sources</span><p>{memory?.content ?? "The source memory is no longer available."}</p><small>{candidate.reasons.join(" ")}</small></div>
        {previewOnly ? <span className="dreaming-preview-label">Preview only</span> : <div className="button-row"><button className="button primary" disabled={Boolean(busy) || !memory} onClick={() => void review(candidate.id, "promote")}>Promote</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => void review(candidate.id, "reject")}>Reject</button></div>}
      </article>;
    })}</div>}
    <details className="dream-diary"><summary>Dream diary · {status.diary.length} {status.diary.length === 1 ? "entry" : "entries"}</summary>{status.diary.length === 0 ? <p>No runs yet.</p> : <ol>{status.diary.slice(0, 10).map((entry) => <li key={entry.id}><time>{new Date(entry.completedAt).toLocaleString()}</time><p>{entry.summary}</p><small>{entry.preview ? "Preview only · nothing stored" : "Stored encrypted · no transcript content"}</small></li>)}</ol>}</details>
    {error && <p className="connection-error" role="alert">{error}</p>}
  </section>;
}
