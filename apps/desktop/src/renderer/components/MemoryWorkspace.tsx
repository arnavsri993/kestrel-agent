import type {
	MemoryDocument,
	MemoryDocumentSave,
	MemoryWorkspace as MemoryWorkspaceData,
	MemoryWorkspaceQuery,
	RendererRequest,
} from "@kestrel/shared-types";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import "./MemoryWorkspace.css";

type WorkspaceView = "overview" | "timeline" | "memory" | "people" | "tools";
type DocumentKind = MemoryDocument["kind"];

async function request(input: RendererRequest) {
	const response = await window.kestrel.request(input);
	if (!response.ok) throw new Error(response.error);
	return response;
}

const tierLabels: Record<MemoryDocument["tier"], string> = {
	short_term: "Short term",
	mid_term: "Medium term",
	long_term: "Long term",
};

function humanDate(value: string) {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function documentSubtitle(document: MemoryDocument) {
	return `${tierLabels[document.tier]} · ${document.confirmation === "confirmed" ? "Confirmed" : `${Math.round(document.confidence * 100)}% inferred`}`;
}

function Overview({ documents, workspace, full = false }: { documents: MemoryDocument[]; workspace: MemoryWorkspaceData; full?: boolean }) {
	const today = new Date(); const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
	const memory = documents.filter((item) => item.kind === "memory");
	return (
		<div className="memory-overview">
			<header>
				
				{!full && <><h2>Today</h2><p>{workspace.days.find(day => day.day === todayKey)?.summary ?? "No significant activity remembered today."}</p></>}
				<h2>What Kestrel understands</h2>
				
			</header>
			{(["short_term", "mid_term", "long_term"] as const).map((tier) => {
				const entries = memory.filter((item) => item.tier === tier);
				return (
					<section className="memory-tier" key={tier}>
						<div className="memory-tier-heading">
							<h3>{tierLabels[tier]}</h3>
							<span>{entries.length} {entries.length === 1 ? "note" : "notes"}</span>
						</div>
						{entries.length ? (full ? entries : entries.slice(0, 3)).map((document) => (
							<article key={document.id}>
								<h4>{document.title}</h4>
								<p>{document.text}</p>
								<small>{document.confirmation === "inferred" ? `${Math.round(document.confidence * 100)}% inferred` : "Confirmed"} · updated {humanDate(document.updatedAt)}</small>
							</article>
						)) : <p className="memory-empty-copy">Nothing is recorded here yet.</p>}
					</section>
				);
			})}
		</div>
	);
}

function Timeline({ workspace }: { workspace: MemoryWorkspaceData }) {
	return (
		<div className="memory-timeline">
			<header>
				<p className="memory-kicker">The last seven days</p>
				<h2>Your week in context</h2>
				<p>{workspace.days.length ? `${workspace.days.reduce((sum, day) => sum + day.eventCount, 0)} captured moments across ${workspace.days.length} days.` : "No activity was captured in this period."}</p>
			</header>
			<div className="memory-days">
				{workspace.days.map((day) => (
					<section key={day.day}>
						<time dateTime={day.day}>{new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${day.day}T12:00:00`))}</time>
						<p>{day.summary || "Captured activity has no summary yet."}</p><small>{day.summaryMethod === "model" ? "AI summary · inferred" : "Activity digest"}</small>
						<details>
							<summary>{day.eventCount} source {day.eventCount === 1 ? "event" : "events"}</summary>
							<div className="memory-event-list">
								{day.events.map((event) => (
									<article key={event.id}>
										<time dateTime={event.startedAt}>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(event.startedAt))}</time>
										<div><strong>{event.textSummary}</strong><small>{event.source} · {event.actor}</small></div>
									</article>
								))}
							</div>
						</details>
					</section>
				))}
			</div>
		</div>
	);
}

function DocumentWorkspace({
	documents,
	kind,
	viewerId,
	onSaved,
	onForgotten,
}: {
	documents: MemoryDocument[];
	kind: DocumentKind | "memory_and_knowledge";
	viewerId: string;
	onSaved(document: MemoryDocument): void;
	onForgotten(id: string): void;
}) {
	const visible = useMemo(() => documents.filter((item) => kind === "memory_and_knowledge" ? item.kind === "memory" : item.kind === kind), [documents, kind]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState(false);
	const [domainsText, setDomainsText] = useState("");
	const [sharing, setSharing] = useState<"owner_only" | "domain_shared">("owner_only");
	const [title, setTitle] = useState("");
	const [text, setText] = useState("");
	const [tier, setTier] = useState<MemoryDocument["tier"]>(kind === "memory_and_knowledge" ? "mid_term" : "long_term");
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const selected = visible.find((item) => item.id === selectedId);

	useEffect(() => {
		if (dirty || creating) return;
		const next = selected ?? visible[0];
		setSelectedId(next?.id ?? null);
		setTitle(next?.title ?? "");
		setDomainsText(next?.domainIds.join(", ") ?? "");
		setSharing(next?.sharing ?? "owner_only");
		setText(next?.text ?? "");
		setTier(next?.tier ?? (kind === "memory_and_knowledge" ? "mid_term" : "long_term"));
	}, [documents, selectedId, dirty, kind]);

	function select(document?: MemoryDocument) {
		if (dirty && !window.confirm("Discard unsaved memory changes?")) return;
		setCreating(!document);
		setEditing(!document);
		setDomainsText(document?.domainIds.join(", ") ?? "");
		setSharing(document?.sharing ?? "owner_only");
		setSelectedId(document?.id ?? null);
		setTitle(document?.title ?? "");
		setText(document?.text ?? "");
		setTier(document?.tier ?? (kind === "memory_and_knowledge" ? "mid_term" : "long_term"));
		setDirty(false);
		setError("");
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!title.trim() || !text.trim()) return;
		setBusy(true);
		setError("");
		const document: MemoryDocumentSave = {
			...(selected ? { id: selected.id, expectedVersion: selected.version } : {}),
			viewerId,
			kind: selected?.kind ?? (kind === "memory_and_knowledge" ? "memory" : kind),
			title: title.trim(), text: text.trim(), tier,
			domainIds: domainsText.split(",").map(value => value.trim()).filter(Boolean), ownerAgentId: selected?.ownerAgentId,
			sharing, sourceIds: selected?.sourceIds ?? [],
			confidence: selected?.confidence ?? 1, confirmation: selected?.confirmation ?? "confirmed",
			sensitivity: selected?.sensitivity ?? "personal", passages: text === selected?.text ? selected.passages : [],
			canonicalEntityId: selected?.canonicalEntityId, origin: selected?.origin ?? "manual",
		};
		try {
			const response = await request({ type: "memory-document-save", document });
			if (!("memoryDocument" in response) || !response.memoryDocument) throw new Error("The saved document was not returned.");
			onSaved(response.memoryDocument);
			setSelectedId(response.memoryDocument.id);
			setCreating(false);
			setEditing(false);
			setDirty(false);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this document."); }
		finally { setBusy(false); }
	}

	async function forget() {
		if (!selected || !window.confirm(`Forget ${selected.title}? The original source history is preserved.`)) return;
		setBusy(true); setError("");
		try {
			await request({ type: "memory-document-forget", id: selected.id });
			onForgotten(selected.id); select(undefined);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not forget this document."); }
		finally { setBusy(false); }
	}

	const noun = kind === "person" ? "person" : kind === "tool" ? "tool" : "memory";
	return (
		<div className="memory-library">
			<aside aria-label={`${noun} documents`}>
				<header><h2>{kind === "person" ? "People" : kind === "tool" ? "Tools" : "Memory"}</h2><button onClick={() => select(undefined)}>New</button></header>
				{visible.map((document) => <button className={document.id === selectedId ? "active" : ""} aria-pressed={document.id === selectedId} key={document.id} onClick={() => select(document)}><strong>{document.title}</strong><small>{documentSubtitle(document)}</small></button>)}
				{!visible.length && <p>No {noun} documents yet.</p>}
			</aside>
			{selected && !editing ? <article className="memory-reader"><h2>{selected.title}</h2><p>{selected.text}</p><button onClick={() => setEditing(true)}>Edit memory</button><details><summary>Evidence and visibility</summary><p>{documentSubtitle(selected)} · {selected.domainIds.join(", ") || "No domain assigned"}</p><p>{selected.sourceIds.join(" · ")}</p></details></article> : <form className="memory-editor" onSubmit={save}>
				<label>Title<input value={title} maxLength={500} onChange={(event) => { setTitle(event.target.value); setDirty(true); }} placeholder={`Name this ${noun}`} /></label>
				<label>What Kestrel should know<textarea value={text} maxLength={100000} onChange={(event) => { setText(event.target.value); setDirty(true); }} placeholder={`Write the useful context about this ${noun}…`} /></label>
				<details><summary>Domain and sharing</summary><label>Domains<input value={domainsText} onChange={event => { setDomainsText(event.target.value); setDirty(true); }} placeholder="Separate domains with commas" /></label><label>Visibility<select value={sharing} onChange={event => { setSharing(event.target.value as typeof sharing); setDirty(true); }}><option value="owner_only">Only this viewer</option><option value="domain_shared">Relevant agents in these domains</option></select></label></details><label className="memory-tier-select">Memory horizon<select value={tier} onChange={(event) => { setTier(event.target.value as MemoryDocument["tier"]); setDirty(true); }}>{Object.entries(tierLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
				{selected && <details className="memory-provenance"><summary>Sources and provenance</summary><dl><dt>Origin</dt><dd>{selected.origin}</dd><dt>Status</dt><dd>{selected.confirmation}, {Math.round(selected.confidence * 100)}% confidence</dd><dt>Sharing</dt><dd>{selected.sharing.replace("_", " ")}</dd><dt>Updated</dt><dd>{humanDate(selected.updatedAt)}</dd><dt>Source IDs</dt><dd>{selected.sourceIds.length ? selected.sourceIds.join(", ") : "No source IDs"}</dd></dl></details>}
				{error && <p className="memory-error" role="alert">{error}</p>}
				<footer><button className="primary" disabled={busy || !dirty || !title.trim() || !text.trim()} type="submit">{busy ? "Saving…" : "Save"}</button>{selected && <button className="danger" disabled={busy} type="button" onClick={() => void forget()}>Forget</button>}<span aria-live="polite">{dirty ? "Unsaved changes" : selected ? "Saved" : ""}</span></footer>
			</form>}
		</div>
	);
}

export function MemoryWorkspace({ initialSessionId, legacyTools }: { initialSessionId?: string; legacyTools?: ReactNode }) {
	const [view, setView] = useState<WorkspaceView>("overview");
	const [viewerId, setViewerId] = useState(initialSessionId ?? "user");
	const [domainId, setDomainId] = useState("");
	const [weekOffset, setWeekOffset] = useState(0);
	const [consolidating, setConsolidating] = useState(false);
	const [workspace, setWorkspace] = useState<MemoryWorkspaceData | null>(null);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const requestId = useRef(0);

	async function load(background = false) {
		const id = ++requestId.current;
		if (!background) { setWorkspace(null); setBusy(true); }
		setError("");
		const end = new Date(); end.setHours(24, 0, 0, 0); end.setDate(end.getDate() + weekOffset * 7); const start = new Date(end); start.setDate(start.getDate() - 7);
		const query: MemoryWorkspaceQuery = { viewerId, includeSensitive: false, ...(domainId ? { domainId } : {}), startAt: start.toISOString(), endAt: end.toISOString() };
		try {
			const response = await request({ type: "memory-workspace-read", query });
			if (id !== requestId.current) return;
			if (!("memoryWorkspace" in response) || !response.memoryWorkspace) throw new Error("The memory workspace was not returned.");
			setWorkspace(response.memoryWorkspace);
			const resolved = response.memoryWorkspace.viewers.find(viewer => viewer.sessionId === viewerId);
			if (resolved && resolved.id !== viewerId) setViewerId(resolved.id);
		} catch (cause) { if (id === requestId.current) setError(cause instanceof Error ? cause.message : "Could not load memory."); }
		finally { if (id === requestId.current) setBusy(false); }
	}

	useEffect(() => { void load(); }, [viewerId, domainId, weekOffset]);
	useEffect(() => {
		const refresh = () => void load(true);
		const timer = window.setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
	}, [viewerId, domainId, weekOffset]);

	function updateDocument(document: MemoryDocument) { setWorkspace((current) => current ? { ...current, documents: [...current.documents.filter((item) => item.id !== document.id), document] } : current); }
	function removeDocument(id: string) { setWorkspace((current) => current ? { ...current, documents: current.documents.filter((item) => item.id !== id) } : current); }

	return (
		<main className="memory-workspace">
			<header className="memory-workspace-header">
				<h1>Memory</h1>
				<div className="memory-scope-controls">
					<label>Viewing as<select value={viewerId} onChange={(event) => { setWorkspace(null); setDomainId(""); setViewerId(event.target.value); }}><option value="user">You</option>{workspace?.viewers.filter((viewer) => viewer.id !== "user").map((viewer) => <option key={viewer.id} value={viewer.id}>{viewer.parentId ? "↳ " : ""}{viewer.label}</option>)}</select></label>
					<label>Domain<select value={domainId} onChange={(event) => setDomainId(event.target.value)}><option value="">All</option>{workspace?.domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.label}</option>)}</select></label>
				</div>
			</header>
			<nav className="memory-workspace-tabs" aria-label="Memory views">{([ ["overview", "Overview"], ["timeline", "Timeline"], ["memory", "Memory"], ["people", "People"], ["tools", "Tools"] ] as const).map(([id, label]) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>{label}</button>)}</nav>
			{error && <div className="memory-state" role="alert"><h2>Memory is unavailable</h2><p>{error}</p><button onClick={() => void load()}>Try again</button></div>}
			{busy && !workspace && <div className="memory-state" aria-live="polite"><h2>Reading memory…</h2><p>Gathering the notes visible to this viewer.</p></div>}
			{workspace && !error && <div className="memory-workspace-content">
				{view === "overview" && <><Overview documents={workspace.documents} workspace={workspace} /><section className="memory-recent"><h3>People</h3>{workspace.documents.filter(item => item.kind === "person").slice(0, 5).map(item => <button key={item.id} onClick={() => setView("people")}>{item.title}</button>)}<h3>Tools</h3>{workspace.documents.filter(item => item.kind === "tool").slice(0, 5).map(item => <button key={item.id} onClick={() => setView("tools")}>{item.title}</button>)}</section></>}
				{view === "timeline" && <><div className="memory-week-controls"><button onClick={() => setWeekOffset(value => value - 1)}>Previous week</button><button onClick={() => setWeekOffset(0)}>This week</button><button disabled={weekOffset >= 0} onClick={() => setWeekOffset(value => value + 1)}>Next week</button><button disabled={consolidating} onClick={async () => { setConsolidating(true); try { const result = await request({ type: "memory-workspace-consolidate", query: workspace.query }); if ("memoryWorkspace" in result && result.memoryWorkspace) setWorkspace(result.memoryWorkspace); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not consolidate memory."); } finally { setConsolidating(false); } }}>{consolidating ? "Summarizing…" : "Summarize with model"}</button></div><Timeline workspace={workspace} /></>}
				{view === "memory" && <><Overview documents={workspace.documents} workspace={workspace} full /><details><summary>Edit memory documents</summary><DocumentWorkspace key={`${viewerId}:${domainId}:${view}`} documents={workspace.documents} kind="memory_and_knowledge" viewerId={viewerId} onSaved={updateDocument} onForgotten={removeDocument} /></details></>}
				{view === "people" && <DocumentWorkspace key={`${viewerId}:${domainId}:${view}`} documents={workspace.documents} kind="person" viewerId={viewerId} onSaved={updateDocument} onForgotten={removeDocument} />}
				{view === "tools" && <><DocumentWorkspace key={`${viewerId}:${domainId}:${view}`} documents={workspace.documents} kind="tool" viewerId={viewerId} onSaved={updateDocument} onForgotten={removeDocument} /><details><summary>Domain knowledge</summary><DocumentWorkspace key={`${viewerId}:knowledge`} documents={workspace.documents} kind="knowledge" viewerId={viewerId} onSaved={updateDocument} onForgotten={removeDocument} /></details>{viewerId === "user" && legacyTools}</>}
			</div>}
		</main>
	);
}
